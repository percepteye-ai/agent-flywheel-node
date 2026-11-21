/**
 * THE LANGCHAIN.JS ADAPTER (LangChain and LangGraph): a callback handler,
 * in the plain-object shape LangChain accepts in `callbacks`, so this package
 * imports nothing of LangChain's and keeps zero runtime dependencies.
 *
 *   import { flywheelCallbacks } from "@percepteye/agent-flywheel/langchain";
 *
 *   await fw.turn(input, async (t) => {
 *     const out = await agent.invoke({ messages: [...] },
 *       { callbacks: [flywheelCallbacks()], signal: t.signal });
 *     return out.messages.at(-1).content;
 *   });
 *
 * CREATE IT INSIDE THE TURN. It binds the turn it is created in, because
 * LangChain may run handlers from its own queue, outside the async context
 * the turn started -- a handler that looked the turn up per event could find
 * none and record nothing. Outside a turn it records nothing.
 *
 * It records every tool call LangChain runs -- a tool that throws is
 * `failed`, one that returns is `unknown` (a returned value is not proof its
 * side effect landed) -- and reports the first chat-model input of the turn:
 * system prompt, prompt, bound tools and model. Under the agent's
 * model-content consent it also records EVERY chat-model call (what it was
 * sent, what it answered) and every tool execution on the turn's model
 * boundary, as the Python SDK's LangChain adapter does.
 */
import { currentTurn } from "../flywheel.js";
import { nowUnixNano } from "../genai-otlp.js";
import {
  chatOperation, dataUrlPart, mediaPart, providerName, toolDefinitions, toolOperation,
} from "../model-boundary.js";

const MAX_PENDING = 1024;

const roleOf = (message) => {
  const type = typeof message?._getType === "function" ? message._getType()
    : typeof message?.getType === "function" ? message.getType()
      : message?.type ?? message?.role;
  return {
    system: "system", human: "user", user: "user", ai: "assistant",
    assistant: "assistant", tool: "tool",
  }[type] ?? String(type ?? "unknown");
};

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && (p.type === "text" || typeof p.text === "string"))
    .map((p) => p.text ?? "").join("");
};

const argumentsOf = (input) => {
  if (input && typeof input === "object" && !Array.isArray(input)) return input;
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch { /* not JSON: the tool took one string */ }
    return { input };
  }
  return input === undefined ? {} : { input };
};

const nameOf = (serialized, runName) => (
  (typeof runName === "string" && runName)
  || (typeof serialized?.name === "string" && serialized.name)
  || (Array.isArray(serialized?.id) ? serialized.id.at(-1) : null)
  || null
);

/** The chat-model input, in the shape `observeModelInput` takes. */
export function modelInputOf(llm, messages, extraParams, runName) {
  const batch = Array.isArray(messages?.[0]) ? messages[0] : (messages ?? []);
  const rendered = batch.map((m) => ({ role: roleOf(m), content: textOf(m?.content) }));
  const system = rendered.filter((m) => m.role === "system").map((m) => m.content)
    .filter(Boolean).join("\n\n");
  const rest = rendered.filter((m) => m.role !== "system");
  let last = -1;
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    if (rest[i].role === "user") { last = i; break; }
  }
  const params = extraParams?.invocation_params ?? {};
  return {
    systemPrompt: system || undefined,
    prompt: last >= 0 ? rest[last].content : undefined,
    historyMessages: last >= 0 ? rest.slice(0, last) : rest,
    provider: nameOf(llm, null) ?? undefined,
    model: params.model ?? params.model_name ?? params.modelName ?? runName ?? undefined,
    tools: Array.isArray(params.tools) ? params.tools : undefined,
  };
}

// ── the model boundary: LangChain's messages as GenAI parts ───────────────

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** A content block that is a medium, as the GenAI part both SDKs emit. */
function mediaBlock(block) {
  if (block.type === "image_url") {
    const url = isObj(block.image_url) ? block.image_url.url : block.image_url;
    return dataUrlPart(url, { modality: "image" });
  }
  if (!["image", "audio", "video", "file"].includes(block.type)) return null;
  const modality = block.type === "file" ? null : block.type;
  const mimeType = block.mime_type ?? block.mimeType ?? null;
  if (typeof block.data === "string") return mediaPart({ mimeType, data: block.data, modality });
  if (typeof block.base64 === "string") return mediaPart({ mimeType, data: block.base64, modality });
  if (typeof block.url === "string") return dataUrlPart(block.url, { modality, mimeType });
  return null;
}

function partsOf(content) {
  if (typeof content === "string") return content ? [{ type: "text", content }] : [];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (typeof block === "string") {
      out.push({ type: "text", content: block });
      continue;
    }
    if (!isObj(block)) continue;
    if (block.type === "text") {
      out.push({ type: "text", content: typeof block.text === "string" ? block.text : "" });
    } else if (block.type === "thinking" || block.type === "reasoning") {
      const t = block.thinking ?? block.reasoning;
      if (typeof t === "string") out.push({ type: "reasoning", content: t });
    } else if (["tool_use", "tool_call", "function_call"].includes(block.type)) {
      // Duplicates `message.tool_calls`, which is what is read.
    } else {
      const media = mediaBlock(block);
      if (media) out.push(media);
      else if (typeof block.type === "string") out.push({ ...block });
    }
  }
  return out;
}

/** One LangChain message as the conventions spell it (Python's `_message`). */
function semconvMessage(message) {
  const role = roleOf(message);
  if (role === "assistant") {
    const parts = partsOf(message?.content);
    for (const call of [...(message?.tool_calls ?? []), ...(message?.invalid_tool_calls ?? [])]) {
      parts.push({ type: "tool_call", id: call?.id ?? null, name: call?.name, arguments: call?.args });
    }
    return { role: "assistant", parts };
  }
  if (role === "tool") {
    let content = message?.content;
    if (Array.isArray(content) && content.some((b) => isObj(b) && mediaBlock(b))) {
      content = partsOf(content);
    }
    return {
      role: "tool",
      parts: [{ type: "tool_call_response", id: message?.tool_call_id ?? null, response: content }],
    };
  }
  return { role, parts: partsOf(message?.content) };
}

/** The chat call's request as it was SENT (Python's `_chat_request`). */
function chatRequestOf(messages, extraParams, metadata) {
  const batch = Array.isArray(messages?.[0]) ? messages[0] : (messages ?? []);
  const params = extraParams?.invocation_params ?? {};
  const meta = isObj(metadata) ? metadata : {};
  const system = [];
  const input = [];
  for (const m of batch) {
    if (roleOf(m) === "system" && !input.length) system.push(...partsOf(m?.content));
    else input.push(semconvMessage(m));
  }
  const format = params.response_format ?? params.text?.format ?? null;
  return {
    provider: typeof meta.ls_provider === "string" ? providerName(meta.ls_provider) : null,
    requestModel: params.model ?? params.model_name ?? params.modelName ?? meta.ls_model_name ?? null,
    system,
    input,
    tools: toolDefinitions(Array.isArray(params.tools) ? params.tools : null),
    responseFormat: isObj(format) ? format : null,
  };
}

/** What `handleLLMEnd` carries, as the call's output fields. */
function outputFieldsOf(output) {
  const generation = output?.generations?.[0]?.[0];
  const message = generation?.message;
  if (!message) return {};
  const meta = message.response_metadata ?? {};
  const info = generation.generationInfo ?? generation.generation_info ?? {};
  return {
    output: semconvMessage(message),
    nativeFinish: meta.finish_reason ?? meta.stop_reason ?? info.finish_reason ?? null,
    responseModel: meta.model_name ?? meta.model ?? null,
  };
}

/**
 * A LangChain callback handler bound to the current turn or rollout.
 *
 * @param {object|null} [turn] the turn to record into; the one this is
 *   created in by default.
 */
export function flywheelCallbacks(turn = currentTurn()) {
  /** runId -> {name, args, started} for tool calls still running. */
  const pending = new Map();
  /** runId -> {start, request} for chat-model calls still running. */
  const models = new Map();
  const capturing = () => {
    try {
      return turn?.capturingModelContent?.() === true;
    } catch {
      return false;
    }
  };
  const finish = (runId, fields, boundary) => {
    const call = pending.get(runId);
    if (!call || !turn) return;
    pending.delete(runId);
    try {
      turn.recordToolCall({
        name: call.name, arguments: call.args, toolCallId: call.toolCallId,
        latencyMs: performance.now() - call.started, ...fields,
      });
    } catch { /* one lost record is not worth a failed run */ }
    if (!capturing()) return;
    try {
      turn.recordModelOperation(toolOperation({
        start: call.startedAt, end: nowUnixNano(), name: call.name,
        toolCallId: boundary.toolCallId ?? call.toolCallId ?? null,
        args: call.args, ...boundary,
      }));
    } catch { /* an observation is never worth a failed run */ }
  };
  const finishModel = (runId, fields) => {
    const call = models.get(runId);
    if (!call) return;
    models.delete(runId);
    if (!capturing()) return;
    try {
      turn.recordModelOperation(chatOperation({
        ...call.request, start: call.start, end: nowUnixNano(), ...fields,
      }));
    } catch { /* an observation is never worth a failed call */ }
  };
  return {
    name: "percepteye-agent-flywheel",
    // Never fail the customer's run over a record.
    raiseError: false,
    handleToolStart(tool, input, runId, _parentRunId, _tags, _metadata, runName, toolCallId) {
      if (!turn) return;
      const name = nameOf(tool, runName);
      if (!name) return;
      pending.set(runId, {
        name, args: argumentsOf(input), started: performance.now(), startedAt: nowUnixNano(),
        toolCallId: typeof toolCallId === "string" ? toolCallId : undefined,
      });
      while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
    },
    handleToolEnd(output, runId) {
      // What the tool handed BACK to the model: a ToolMessage's content (the
      // value the next call is sent) and the model's own call id on it.
      const isMessage = isObj(output) && "content" in output;
      finish(runId, { result: output }, {
        result: isMessage ? output.content : output,
        toolCallId: isMessage && typeof output.tool_call_id === "string"
          ? output.tool_call_id : undefined,
      });
    },
    handleToolError(err, runId) {
      finish(runId, { error: err instanceof Error ? err : String(err) },
        { errorType: err?.name ?? "Error" });
    },
    handleChatModelStart(llm, messages, runId, _parentRunId, extraParams, _tags, metadata, runName) {
      try {
        turn?.observeModelInput(modelInputOf(llm, messages, extraParams, runName));
      } catch { /* an observation is never worth a failed call */ }
      if (!capturing()) return;
      try {
        models.set(runId, {
          start: nowUnixNano(), request: chatRequestOf(messages, extraParams, metadata),
        });
        while (models.size > MAX_PENDING) models.delete(models.keys().next().value);
      } catch { /* an observation is never worth a failed call */ }
    },
    handleLLMEnd(output, runId) {
      let fields = {};
      try { fields = outputFieldsOf(output); } catch { /* observe only */ }
      finishModel(runId, fields);
    },
    handleLLMError(err, runId) {
      finishModel(runId, { errorType: err?.name ?? "Error" });
    },
  };
}

/**
 * `tools` with the current turn's approved descriptions applied (design
 * 2026-11-21, contract B), as COPIES; the originals are never changed.
 * LangChain's callbacks cannot change a request, so this is the one line:
 * `model.bindTools(applyToolDescriptions(tools))` inside the turn. Outside
 * one, or for a tool the overlay does not name, the tool is returned as is.
 * The Python SDK's `apply_tool_descriptions`.
 *
 * @param {Array} tools LangChain tools, or OpenAI-style definitions
 * @param {object|null} [turn] the turn; the current one by default
 */
export function applyToolDescriptions(tools, turn = currentTurn()) {
  const overlay = turn?.toolDescriptions ?? null;
  if (!overlay || !Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object") return tool;
    const fn = tool.type === "function" && isObj(tool.function) ? tool.function : null;
    if (fn && Object.hasOwn(overlay, fn.name)) {
      return { ...tool, function: { ...fn, description: overlay[fn.name] } };
    }
    if (typeof tool.name !== "string" || !Object.hasOwn(overlay, tool.name)) return tool;
    // A class instance (a LangChain tool) keeps its prototype: a copy of the
    // same kind, with the approved description.
    const copy = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool);
    copy.description = overlay[tool.name];
    return copy;
  });
}
