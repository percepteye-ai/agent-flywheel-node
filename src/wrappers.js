/**
 * One-line model-client wrappers: `wrapOpenAI`, `wrapAnthropic`, `wrapGemini`.
 *
 * For an agent that calls a provider's client directly, with no framework
 * adapter in between:
 *
 *   import OpenAI from "openai";
 *   import { flywheel, wrapOpenAI } from "@percepteye/agent-flywheel";
 *
 *   const client = wrapOpenAI(new OpenAI());
 *   const fw = flywheel({ agentId: "support-agent" });
 *   await fw.turn(userMessage, async () => {
 *     const r = await client.chat.completions.create({ model, messages });
 *     return r.choices[0].message.content;
 *   });
 *
 * Inside a production turn whose agent may upload model content
 * (`t.capturingModelContent()`), every call records ONE `chat` operation on
 * the turn's model boundary: what it was sent (system instructions, messages,
 * tool definitions, output format) and what it answered (text, reasoning, the
 * tool calls it asked for), as the framework adapters record theirs. Outside
 * one, or without that consent, a call records nothing.
 *
 * OBSERVE ONLY. The request is passed on as given and the SAME promise the
 * client returned is handed back -- an OpenAI or Anthropic `APIPromise` keeps
 * `.withResponse()` -- and a streamed response is the same stream object,
 * read on its way through to the caller. A capture bug costs the
 * observation, never the call. The client is patched in place and returned,
 * so wrapping twice is wrapping once.
 *
 * What is wrapped:
 *   OpenAI     `chat.completions.create` and `responses.create`, streamed or not.
 *   Anthropic  `messages.create`, streamed or not, and `messages.stream(...)`.
 *   Gemini     `models.generateContent` and `models.generateContentStream`
 *              (@google/genai).
 *
 * The Python SDK's `wrap_openai` / `wrap_anthropic` / `wrap_gemini`
 * (`agent_flywheel/wrappers.py`) are this module in Python; the shared
 * `model_wrappers.json` fixture holds both to the same operations.
 *
 * Zero dependencies.
 */
import { currentTurn } from "./flywheel.js";
import { newSpanId, nowUnixNano, requestedOutputFormat } from "./genai-otlp.js";
import { dataUrlPart, mediaPart } from "./model-boundary.js";

const MARK = Symbol.for("percepteye.agent-flywheel.wrapped");

const FINISH = new Map(Object.entries({
  stop: "stop", end_turn: "stop", stop_sequence: "stop",
  tool_calls: "tool_call", tool_use: "tool_call", function_call: "tool_call",
  length: "length", max_tokens: "length",
  content_filter: "content_filter", safety: "content_filter",
}));

const PROVIDERS = new Map(Object.entries({
  openai_chat: "openai", openai_responses: "openai",
  anthropic: "anthropic", gemini: "gcp.gemini",
}));

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" && v ? v : null);

// ── plain values ──────────────────────────────────────────────────────────

/** A provider SDK's value as plain JSON-shaped data: nulls dropped, bytes as
 * base64 text (the Python SDK's `_plain`). */
function plain(value) {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(plain);
  if (isObj(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== null && v !== undefined && typeof v !== "function") out[k] = plain(v);
    }
    return out;
  }
  return value;
}

const get = (obj, ...keys) => {
  if (!isObj(obj)) return null;
  for (const k of keys) if (obj[k] !== null && obj[k] !== undefined) return obj[k];
  return null;
};

function args(value) {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const textParts = (content) => (content ? [{ type: "text", content }] : []);

function flatTool(tool) {
  if (!isObj(tool)) return null;
  const src = tool.type === "function" && isObj(tool.function) ? tool.function : tool;
  if (!str(src.name)) return { ...tool };
  const flat = { type: "function", name: src.name };
  if ("description" in src) flat.description = src.description;
  const schema = get(src, "parameters", "input_schema", "inputSchema",
    "parameters_json_schema", "parametersJsonSchema");
  if (schema !== null) flat.parameters = schema;
  return flat;
}

function tools(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const out = list.map(flatTool).filter(Boolean);
  return out.length ? out : null;
}

// ── OpenAI Chat Completions ───────────────────────────────────────────────

const AUDIO = { mp3: "audio/mpeg", wav: "audio/wav" };

function openaiParts(content) {
  if (typeof content === "string") return textParts(content);
  const parts = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (!isObj(block)) continue;
    const kind = block.type;
    if (kind === "text" || kind === "input_text" || kind === "output_text") {
      parts.push({ type: "text", content: block.text ?? "" });
    } else if (kind === "refusal") {
      parts.push({ type: "text", content: block.refusal ?? "" });
    } else if (kind === "image_url" || kind === "input_image") {
      const url = isObj(block.image_url) ? block.image_url.url : block.image_url;
      const part = dataUrlPart(url, { modality: "image" });
      if (part) parts.push(part);
    } else if (kind === "input_audio" && isObj(block.input_audio)) {
      const fmt = block.input_audio.format;
      const mime = typeof fmt === "string" && fmt ? (AUDIO[fmt] ?? `audio/${fmt}`) : null;
      parts.push(mediaPart({ mimeType: mime, data: block.input_audio.data, modality: "audio" }));
    } else if (typeof kind === "string") {
      parts.push({ ...block });
    }
  }
  return parts;
}

function openaiMessage(m) {
  const role = m.role || "user";
  if (role === "tool") {
    return { role: "tool", parts: [{
      type: "tool_call_response", id: m.tool_call_id ?? null, response: m.content ?? null }] };
  }
  const parts = openaiParts(m.content);
  if (role === "assistant") {
    for (const call of m.tool_calls ?? []) {
      const fn = call.function ?? {};
      parts.push({ type: "tool_call", id: call.id ?? null, name: fn.name ?? null,
        arguments: args(fn.arguments) });
    }
  }
  return { role, parts };
}

function openaiChatRequest(req) {
  const system = [];
  const input = [];
  for (const m of req.messages ?? []) {
    if (!isObj(m)) continue;
    if ((m.role === "system" || m.role === "developer") && !input.length) {
      system.push(...openaiParts(m.content));
    } else {
      input.push(openaiMessage(m));
    }
  }
  return { system, input };
}

function openaiChatResponse(resp) {
  const choice = (resp.choices ?? [{}])[0] ?? {};
  return {
    output: openaiMessage({ ...(choice.message ?? {}), role: "assistant" }),
    finish: choice.finish_reason ?? null, model: resp.model ?? null,
  };
}

function openaiChatStream(chunks) {
  let text = "";
  const calls = new Map();
  let finish = null;
  let model = null;
  for (const chunk of chunks) {
    if (!isObj(chunk)) continue;
    model = chunk.model || model;
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string") text += delta.content;
      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0;
        if (!calls.has(index)) calls.set(index, { id: null, name: null, arguments: "" });
        const slot = calls.get(index);
        const fn = call.function ?? {};
        slot.id = call.id || slot.id;
        slot.name = fn.name || slot.name;
        slot.arguments += fn.arguments || "";
      }
      finish = choice.finish_reason || finish;
    }
  }
  const parts = textParts(text);
  for (const index of [...calls.keys()].sort((a, b) => a - b)) {
    const call = calls.get(index);
    parts.push({ type: "tool_call", id: call.id, name: call.name, arguments: args(call.arguments) });
  }
  return { output: { role: "assistant", parts }, finish, model };
}

// ── OpenAI Responses ──────────────────────────────────────────────────────

function openaiResponsesRequest(req) {
  const system = typeof req.instructions === "string" ? textParts(req.instructions) : [];
  const input = [];
  let items = req.input;
  if (typeof items === "string") items = [{ role: "user", content: items }];
  for (const item of Array.isArray(items) ? items : []) {
    if (!isObj(item)) continue;
    if (item.type === "function_call") {
      input.push({ role: "assistant", parts: [{ type: "tool_call", id: item.call_id ?? null,
        name: item.name ?? null, arguments: args(item.arguments) }] });
    } else if (item.type === "function_call_output") {
      input.push({ role: "tool", parts: [{ type: "tool_call_response",
        id: item.call_id ?? null, response: item.output ?? null }] });
    } else if (item.role) {
      if ((item.role === "system" || item.role === "developer") && !input.length) {
        system.push(...openaiParts(item.content));
      } else {
        input.push({ role: item.role, parts: openaiParts(item.content) });
      }
    }
  }
  return { system, input };
}

function openaiResponsesResponse(resp) {
  const parts = [];
  for (const item of resp.output ?? []) {
    if (!isObj(item)) continue;
    if (item.type === "message") {
      parts.push(...openaiParts(item.content));
    } else if (item.type === "function_call") {
      parts.push({ type: "tool_call", id: item.call_id ?? null, name: item.name ?? null,
        arguments: args(item.arguments) });
    } else if (item.type === "reasoning") {
      for (const s of item.summary ?? []) {
        if (isObj(s) && typeof s.text === "string") parts.push({ type: "reasoning", content: s.text });
      }
    }
  }
  const details = resp.incomplete_details;
  return {
    output: { role: "assistant", parts },
    finish: isObj(details) ? (details.reason ?? null) : null, model: resp.model ?? null,
  };
}

function openaiResponsesStream(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (isObj(e) && (e.type === "response.completed" || e.type === "response.incomplete")
        && isObj(e.response)) {
      return openaiResponsesResponse(e.response);
    }
  }
  return null;
}

// ── Anthropic Messages ────────────────────────────────────────────────────

function anthropicBlock(block) {
  if (typeof block === "string") return { type: "text", content: block };
  if (!isObj(block)) return null;
  switch (block.type) {
    case "text": return { type: "text", content: block.text ?? "" };
    case "thinking": return { type: "reasoning", content: block.thinking ?? "" };
    case "redacted_thinking": return null;
    case "tool_use":
      return { type: "tool_call", id: block.id ?? null, name: block.name ?? null,
        arguments: block.input ?? {} };
    default:
  }
  if ((block.type === "image" || block.type === "document") && isObj(block.source)) {
    const source = block.source;
    const modality = block.type === "image" ? "image" : null;
    if (source.type === "base64") {
      return mediaPart({ mimeType: source.media_type ?? null, data: source.data, modality });
    }
    if (source.type === "url") {
      return dataUrlPart(source.url, { modality, mimeType: source.media_type ?? null });
    }
  }
  return typeof block.type === "string" ? { ...block } : null;
}

function anthropicRequest(req) {
  const raw = req.system;
  const system = typeof raw === "string" ? textParts(raw)
    : (raw ?? []).map(anthropicBlock).filter(Boolean);
  const input = [];
  for (const m of req.messages ?? []) {
    if (!isObj(m)) continue;
    if (typeof m.content === "string") {
      input.push({ role: m.role ?? null, parts: textParts(m.content) });
      continue;
    }
    const parts = [];
    for (const block of m.content ?? []) {
      if (isObj(block) && block.type === "tool_result") {
        input.push({ role: "tool", parts: [{ type: "tool_call_response",
          id: block.tool_use_id ?? null, response: block.content ?? null }] });
        continue;
      }
      const part = anthropicBlock(block);
      if (part) parts.push(part);
    }
    if (parts.length || !(m.content ?? []).length) input.push({ role: m.role ?? null, parts });
  }
  return { system, input };
}

function anthropicResponse(resp) {
  return {
    output: { role: "assistant", parts: (resp.content ?? []).map(anthropicBlock).filter(Boolean) },
    finish: resp.stop_reason ?? null, model: resp.model ?? null,
  };
}

function anthropicStream(events) {
  const blocks = new Map();
  let finish = null;
  let model = null;
  for (const e of events) {
    if (!isObj(e)) continue;
    if (e.type === "message_start") {
      model = e.message?.model || model;
    } else if (e.type === "content_block_start") {
      const block = { ...(e.content_block ?? {}) };
      if (block.type === "tool_use") block._json = "";
      blocks.set(e.index ?? blocks.size, block);
    } else if (e.type === "content_block_delta") {
      const block = blocks.get(e.index ?? 0);
      const d = e.delta ?? {};
      if (!block) continue;
      if (d.type === "text_delta") block.text = (block.text ?? "") + (d.text ?? "");
      else if (d.type === "thinking_delta") block.thinking = (block.thinking ?? "") + (d.thinking ?? "");
      else if (d.type === "input_json_delta") block._json = (block._json ?? "") + (d.partial_json ?? "");
    } else if (e.type === "message_delta") {
      finish = e.delta?.stop_reason || finish;
    }
  }
  const content = [];
  for (const index of [...blocks.keys()].sort((a, b) => a - b)) {
    const block = blocks.get(index);
    if ("_json" in block) {
      const raw = block._json;
      delete block._json;
      if (raw) block.input = args(raw);
    }
    content.push(block);
  }
  return anthropicResponse({ content, stop_reason: finish, model });
}

// ── Gemini (@google/genai) ────────────────────────────────────────────────

/** One Gemini part, with the role it belongs under ("tool" for a function
 * response). */
function geminiPart(part) {
  if (typeof part === "string") return ["", { type: "text", content: part }];
  if (!isObj(part)) return null;
  if (typeof part.text === "string") {
    return ["", { type: part.thought ? "reasoning" : "text", content: part.text }];
  }
  const call = get(part, "function_call", "functionCall");
  if (isObj(call)) {
    return ["", { type: "tool_call", id: call.id ?? null, name: call.name ?? null,
      arguments: call.args ?? {} }];
  }
  const response = get(part, "function_response", "functionResponse");
  if (isObj(response)) {
    return ["tool", { type: "tool_call_response", id: response.id ?? null,
      response: response.response ?? null }];
  }
  const inline = get(part, "inline_data", "inlineData");
  if (isObj(inline)) {
    return ["", mediaPart({ mimeType: get(inline, "mime_type", "mimeType"), data: inline.data })];
  }
  const file = get(part, "file_data", "fileData");
  if (isObj(file)) {
    return ["", mediaPart({ mimeType: get(file, "mime_type", "mimeType"),
      uri: get(file, "file_uri", "fileUri") })];
  }
  return null;
}

function geminiContent(content) {
  if (typeof content === "string") return [{ role: "user", parts: textParts(content) }];
  if (!isObj(content)) return [];
  const role = content.role === "model" ? "assistant" : (content.role || "user");
  const own = [];
  const tool = [];
  for (const part of content.parts ?? []) {
    const seen = geminiPart(part);
    if (seen) (seen[0] === "tool" ? tool : own).push(seen[1]);
  }
  const out = [];
  if (tool.length) out.push({ role: "tool", parts: tool });
  if (own.length || !tool.length) out.push({ role, parts: own });
  return out;
}

const partsOnly = (list) => (list ?? []).map(geminiPart).filter(Boolean).map(([, p]) => p);

function geminiRequest(req) {
  const config = isObj(req.config) ? req.config : {};
  const raw = get(config, "system_instruction", "systemInstruction");
  const system = typeof raw === "string" ? textParts(raw)
    : isObj(raw) ? partsOnly(raw.parts) : partsOnly(Array.isArray(raw) ? raw : []);
  let contents = req.contents;
  if (typeof contents === "string" || isObj(contents)) contents = [contents];
  const input = [];
  let loose = [];
  for (const item of Array.isArray(contents) ? contents : []) {
    if (isObj(item) && "parts" in item) {
      if (loose.length) {
        input.push({ role: "user", parts: loose });
        loose = [];
      }
      input.push(...geminiContent(item));
    } else {
      const seen = geminiPart(item);
      if (seen) loose.push(seen[1]);
    }
  }
  if (loose.length) input.push({ role: "user", parts: loose });
  const defs = [];
  for (const tool of get(config, "tools") ?? []) {
    const decls = isObj(tool) ? get(tool, "function_declarations", "functionDeclarations") : null;
    if (Array.isArray(decls)) defs.push(...decls);
    else defs.push(tool);
  }
  return { system, input, tools: defs, formatSource: config };
}

function geminiResponse(resp) {
  const candidate = (resp.candidates ?? [{}])[0] ?? {};
  const content = isObj(candidate.content) ? candidate.content : {};
  return {
    output: { role: "assistant", parts: partsOnly(content.parts) },
    finish: get(candidate, "finish_reason", "finishReason"),
    model: get(resp, "model_version", "modelVersion"),
  };
}

function geminiStream(chunks) {
  const parts = [];
  let finish = null;
  let model = null;
  for (const chunk of chunks) {
    if (!isObj(chunk)) continue;
    const one = geminiResponse(chunk);
    for (const part of one.output.parts) {
      const last = parts.at(-1);
      if (last && (part.type === "text" || part.type === "reasoning") && last.type === part.type) {
        last.content += part.content;
      } else {
        parts.push({ ...part });
      }
    }
    finish = one.finish || finish;
    model = one.model || model;
  }
  return { output: { role: "assistant", parts }, finish, model };
}

// ── the shared shape: request, response, operation ────────────────────────

const REQUESTS = new Map(Object.entries({
  openai_chat: openaiChatRequest, openai_responses: openaiResponsesRequest,
  anthropic: anthropicRequest, gemini: geminiRequest,
}));
const RESPONSES = new Map(Object.entries({
  openai_chat: openaiChatResponse, openai_responses: openaiResponsesResponse,
  anthropic: anthropicResponse, gemini: geminiResponse,
}));
const STREAMS = new Map(Object.entries({
  openai_chat: openaiChatStream, openai_responses: openaiResponsesStream,
  anthropic: anthropicStream, gemini: geminiStream,
}));

/** The request as it was SENT (the Python SDK's `request_of`). */
export function requestOf(api, request) {
  const req = plain(request) ?? {};
  const seen = REQUESTS.get(api)(req);
  return {
    provider_name: PROVIDERS.get(api),
    request_model: typeof req.model === "string" ? req.model : null,
    system_instructions: seen.system,
    input_messages: seen.input,
    tool_definitions: tools(seen.tools ?? req.tools),
    response_format: requestedOutputFormat(seen.formatSource ?? req),
  };
}

/** What a call answered: `{output, finish, model}` (Python's `response_of`). */
export function responseOf(api, response) {
  const resp = plain(response);
  return isObj(resp) ? RESPONSES.get(api)(resp) : null;
}

/** What a streamed call answered, from its chunks or events in order. */
export function streamResponseOf(api, chunks) {
  return STREAMS.get(api)(chunks.map(plain));
}

/** One model call as the boundary's `chat` operation (Python's
 * `chat_operation`), keys in the order the adapters write them. */
export function chatOperation(request, { start, end, answer = null, errorType = null }) {
  const op = {
    operation: "chat",
    span_id: newSpanId(),
    start_time_unix_nano: start,
    end_time_unix_nano: end,
    provider_name: request.provider_name,
  };
  if (request.request_model) op.request_model = request.request_model;
  if (request.system_instructions?.length) op.system_instructions = request.system_instructions;
  op.input_messages = request.input_messages;
  if (request.tool_definitions?.length) op.tool_definitions = request.tool_definitions;
  if (request.response_format) op.response_format = request.response_format;
  if (errorType) {
    op.error_type = errorType;
    return op;
  }
  if (!answer) return op;
  const output = { ...answer.output };
  const native = str(answer.finish);
  const calls = output.parts.some((p) => p.type === "tool_call");
  output.finish_reason = calls ? "tool_call" : (native
    ? (FINISH.get(native) ?? FINISH.get(native.toLowerCase()) ?? native) : "stop");
  op.output_messages = [output];
  if (native) op.finish_reasons = [native];
  if (str(answer.model)) op.response_model = answer.model;
  return op;
}

// ── the wrappers ──────────────────────────────────────────────────────────

const errorName = (err) => str(err?.constructor?.name) ?? str(err?.name) ?? "Error";

function record(turn, request, start, fields) {
  try {
    turn.recordModelOperation(chatOperation(request, { start, end: nowUnixNano(), ...fields }));
  } catch { /* an observation is never worth a failed call */ }
}

/** Read a streamed response on its way through: the SAME object, its
 * iterator observed. Records once, when iteration ends, fails or stops. */
function tapStream(stream, done) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function") return;
  const seen = [];
  let closed = false;
  const finish = (error) => {
    if (!closed) {
      closed = true;
      done(seen, error);
    }
  };
  const iterate = stream[Symbol.asyncIterator].bind(stream);
  // An async generator returns ITSELF from Symbol.asyncIterator: patch its
  // own `next`/`return`/`throw` rather than the iterator method.
  // (Asked by its tag, never by calling the iterator method: on a
  // ReadableStream that call would lock the stream.)
  if (Object.prototype.toString.call(stream) === "[object AsyncGenerator]") {
    const next = stream.next.bind(stream);
    const ret = stream.return?.bind(stream);
    stream.next = async (...a) => {
      try {
        const r = await next(...a);
        if (r.done) finish(null);
        else seen.push(r.value);
        return r;
      } catch (err) {
        finish(err);
        throw err;
      }
    };
    if (ret) {
      stream.return = async (...a) => {
        finish(null);
        return ret(...a);
      };
    }
    return;
  }
  stream[Symbol.asyncIterator] = function observed() {
    const it = iterate();
    return {
      async next(...a) {
        try {
          const r = await it.next(...a);
          if (r.done) finish(null);
          else seen.push(r.value);
          return r;
        } catch (err) {
          finish(err);
          throw err;
        }
      },
      async return(...a) {
        finish(null);
        return it.return ? it.return(...a) : { done: true, value: undefined };
      },
      async throw(err) {
        finish(err);
        if (it.throw) return it.throw(err);
        throw err;
      },
      [Symbol.asyncIterator]() { return this; },
    };
  };
}

function patch(owner, name, api, { alwaysStream = false } = {}) {
  const original = owner?.[name];
  if (typeof original !== "function" || original[MARK]) return;
  const observed = function observedCall(...callArgs) {
    const turn = currentTurn();
    let capturing = false;
    try { capturing = turn?.capturingModelContent?.() === true; } catch { capturing = false; }
    if (!capturing) return original.apply(this, callArgs);
    let request;
    let start;
    try {
      request = requestOf(api, callArgs[0] ?? {});
      start = nowUnixNano();
    } catch {
      return original.apply(this, callArgs);
    }
    let pending;
    try {
      pending = original.apply(this, callArgs);
    } catch (err) {
      record(turn, request, start, { errorType: errorName(err) });
      throw err;
    }
    const streamed = alwaysStream || callArgs[0]?.stream === true;
    // Observed ALONGSIDE the caller: the same promise goes back, and this
    // reaction runs first, so a stream is tapped before it is read.
    Promise.resolve(pending).then((result) => {
      if (streamed) {
        tapStream(result, (seen, error) => {
          if (error) {
            record(turn, request, start, { errorType: errorName(error) });
            return;
          }
          let answer = null;
          try { answer = streamResponseOf(api, seen); } catch { answer = null; }
          record(turn, request, start, { answer });
        });
        return;
      }
      let answer = null;
      try { answer = responseOf(api, result); } catch { answer = null; }
      record(turn, request, start, { answer });
    }, (err) => {
      record(turn, request, start, { errorType: errorName(err) });
    });
    return pending;
  };
  observed[MARK] = true;
  owner[name] = observed;
}

/** Observe an `openai` client's Chat Completions and Responses calls.
 * Returns the same client. */
export function wrapOpenAI(client) {
  patch(client?.chat?.completions, "create", "openai_chat");
  patch(client?.responses, "create", "openai_responses");
  return client;
}

/**
 * Anthropic's `messages.stream(...)` helper posts on its own, not through
 * `create`. The SAME MessageStream goes back; its final message is recorded
 * from its own `finalMessage` event (an error from its `error` event), which
 * reads and changes nothing the caller consumes. Idempotent.
 */
function patchStreamHelper(messages) {
  const original = messages?.stream;
  if (typeof original !== "function" || original[MARK]) return;
  const observed = function observedStream(...callArgs) {
    const stream = original.apply(this, callArgs);
    const turn = currentTurn();
    let capturing = false;
    try { capturing = turn?.capturingModelContent?.() === true; } catch { capturing = false; }
    if (!capturing || typeof stream?.on !== "function") return stream;
    try {
      const request = requestOf("anthropic", callArgs[0] ?? {});
      const start = nowUnixNano();
      let done = false;
      stream.on("finalMessage", (message) => {
        if (done) return;
        done = true;
        let answer = null;
        try { answer = responseOf("anthropic", message); } catch { answer = null; }
        record(turn, request, start, { answer });
      });
      stream.on("error", (err) => {
        if (done) return;
        done = true;
        record(turn, request, start, { errorType: errorName(err) });
      });
    } catch { /* an observation is never worth a failed call */ }
    return stream;
  };
  observed[MARK] = true;
  messages.stream = observed;
}

/** Observe an `@anthropic-ai/sdk` client's Messages calls -- `create`,
 * streamed or not, and the `messages.stream(...)` helper. Returns the same
 * client. */
export function wrapAnthropic(client) {
  patch(client?.messages, "create", "anthropic");
  patchStreamHelper(client?.messages);
  return client;
}

/** Observe an `@google/genai` client's content generation. Returns the same
 * client. */
export function wrapGemini(client) {
  patch(client?.models, "generateContent", "gemini");
  patch(client?.models, "generateContentStream", "gemini", { alwaysStream: true });
  return client;
}
