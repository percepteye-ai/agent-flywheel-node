/**
 * THE VERCEL AI SDK ADAPTER. Two pieces, each optional, neither importing
 * `ai`: this package keeps zero runtime dependencies, and these are plain
 * objects in the shapes the AI SDK already accepts.
 *
 *   import { flywheelTools, flywheelMiddleware } from "@percepteye/agent-flywheel/ai-sdk";
 *
 *   const model = wrapLanguageModel({ model: base, middleware: flywheelMiddleware() });
 *   await generateText({ model, tools: flywheelTools(tools), prompt: t.input });
 *
 * `flywheelTools` records every executed tool call against the current turn
 * or rollout (`currentTurn()`), and refuses to run one once a training
 * rollout's lease is revoked. `flywheelMiddleware` reports what the model is
 * sent -- system prompt, prompt, tools, model -- once per turn (the agent's
 * description), and under its model-content consent records EVERY model
 * call of the turn with what it answered, as `flywheelTools` records every
 * tool execution: the turn's whole multi-step trace.
 *
 * Outside a turn both are pass-throughs, so the same agent code serves
 * traffic the flywheel never sees.
 */
import { currentTurn } from "../flywheel.js";
import { nowUnixNano } from "../genai-otlp.js";
import {
  chatOperation, dataUrlPart, mediaPart, providerName, toolDefinitions, toolOperation,
} from "../model-boundary.js";

/**
 * Wrap a `tools` record so each executed call is recorded.
 *
 * A call that THROWS is `failed`. A call that returns is `unknown` unless
 * the result says otherwise in a way this package reads (an `Error`, an exit
 * status): a returned value is not proof the side effect landed, and this
 * package never rounds an unobserved result up to `ok`. State it yourself
 * with `recordToolCall({ outcome })` where you know better.
 *
 * @template T
 * @param {T} tools the record you pass to `generateText` / `streamText`
 * @returns {T}
 */
export function flywheelTools(tools) {
  if (!tools || typeof tools !== "object") return tools;
  const out = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool || typeof tool.execute !== "function") {
      out[name] = tool;
      continue;
    }
    const execute = tool.execute;
    out[name] = {
      ...tool,
      async execute(args, options) {
        const turn = currentTurn();
        if (!turn) return execute.call(tool, args, options);
        await turn.guardToolCall(name, args);
        const started = performance.now();
        const startedAt = nowUnixNano();
        const toolCallId = typeof options?.toolCallId === "string" ? options.toolCallId : undefined;
        // The execution on the turn's model boundary, under its consent.
        const boundary = (fields) => {
          try {
            if (!turn.capturingModelContent?.()) return;
            turn.recordModelOperation(toolOperation({
              start: startedAt, end: nowUnixNano(), name, toolCallId,
              args: args ?? {}, ...fields,
            }));
          } catch { /* an observation is never worth a failed call */ }
        };
        try {
          const result = await execute.call(tool, args, options);
          turn.recordToolCall({
            name, arguments: args, result, toolCallId,
            latencyMs: performance.now() - started,
          });
          boundary({ result });
          return result;
        } catch (err) {
          turn.recordToolCall({
            name, arguments: args, error: err instanceof Error ? err : String(err),
            toolCallId, latencyMs: performance.now() - started,
          });
          boundary({ errorType: err?.name ?? "Error" });
          throw err;
        }
      },
    };
  }
  return out;
}

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text).join("");
};

/**
 * The model input, in the shape `observeModelInput` takes, from the AI SDK's
 * call options: `params.prompt` (its messages, the system prompt among
 * them), `params.tools`, and the model's id and provider.
 */
export function modelInputOf(params, model) {
  const messages = Array.isArray(params?.prompt) ? params.prompt : [];
  const system = messages.filter((m) => m?.role === "system").map((m) => textOf(m.content))
    .filter(Boolean).join("\n\n");
  const rest = messages.filter((m) => m?.role !== "system");
  let last = -1;
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    if (rest[i]?.role === "user") { last = i; break; }
  }
  return {
    systemPrompt: system || undefined,
    prompt: last >= 0 ? textOf(rest[last].content) : undefined,
    historyMessages: last >= 0 ? rest.slice(0, last) : rest,
    provider: model?.provider,
    model: model?.modelId,
    tools: Array.isArray(params?.tools) ? params.tools : undefined,
  };
}

// ── the model boundary: the AI SDK's prompt and result as GenAI parts ─────
//
// A TRANSLATION, never an addition: every part below is one the AI SDK was
// about to send or had just received. Both language-model specifications
// are read (v1: AI SDK 4, `args`/`mimeType`/`result`; v2: AI SDK 5+,
// `input`/`mediaType`/`output`).

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** A tool call's arguments as the model sent them: parsed when JSON text. */
function argumentsOf(value) {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** A medium in the prompt (`file`, or v1's `image`) as a GenAI part. */
function filePart(part) {
  const mimeType = part.mediaType ?? part.mimeType ?? null;
  const data = part.data ?? part.image;
  if (typeof data === "string") {
    return data.startsWith("data:") || /^[a-z][a-z0-9+.-]*:\/\//i.test(data)
      ? dataUrlPart(data, { mimeType }) : mediaPart({ mimeType, data });
  }
  if (data instanceof URL) return mediaPart({ mimeType, uri: data.href });
  if (data instanceof Uint8Array) {
    return mediaPart({ mimeType, data: Buffer.from(data).toString("base64") });
  }
  return null;
}

/** What a tool result handed back to the model. */
function toolResponse(part) {
  const output = part.output;
  if (isObj(output) && typeof output.type === "string" && "value" in output) {
    if (output.type === "content" && Array.isArray(output.value)) {
      return output.value.map((p) => (p?.type === "media"
        ? mediaPart({ mimeType: p.mediaType ?? null, data: p.data })
        : { type: "text", content: p?.text ?? "" }));
    }
    return output.value;
  }
  return output !== undefined ? output : part.result;
}

function parts(content) {
  if (typeof content === "string") return content ? [{ type: "text", content }] : [];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const part of content) {
    if (!isObj(part)) continue;
    if (part.type === "text") {
      out.push({ type: "text", content: typeof part.text === "string" ? part.text : "" });
    } else if (part.type === "reasoning") {
      if (typeof part.text === "string") out.push({ type: "reasoning", content: part.text });
    } else if (part.type === "tool-call") {
      out.push({
        type: "tool_call", id: part.toolCallId ?? null, name: part.toolName,
        arguments: argumentsOf(part.input ?? part.args),
      });
    } else if (part.type === "tool-result") {
      out.push({
        type: "tool_call_response", id: part.toolCallId ?? null,
        response: toolResponse(part),
      });
    } else if (part.type === "file" || part.type === "image") {
      const media = filePart(part);
      if (media) out.push(media);
    }
  }
  return out;
}

/** The call's request, snapshotted as it was SENT. */
function chatRequestOf(params, model) {
  const messages = Array.isArray(params?.prompt) ? params.prompt : [];
  const system = [];
  const input = [];
  for (const m of messages) {
    if (m?.role === "system" && !input.length) {
      system.push(...parts(m.content));
    } else if (isObj(m)) {
      input.push({ role: m.role, parts: parts(m.content) });
    }
  }
  let provider = typeof model?.provider === "string" ? model.provider : null;
  // `openai.chat`, `anthropic.messages`, `google.vertex.chat`: the provider
  // is what comes before the API's name.
  if (provider) {
    provider = provider.startsWith("google.vertex") ? "google-vertex" : provider.split(".")[0];
  }
  const format = params?.responseFormat;
  return {
    provider: providerName(provider),
    requestModel: typeof model?.modelId === "string" ? model.modelId : null,
    system,
    input,
    tools: toolDefinitions(Array.isArray(params?.tools) ? params.tools : null),
    responseFormat: isObj(format) && format.type === "json" ? format : null,
  };
}

const finishOf = (reason) => (isObj(reason)
  ? (reason.unified ?? reason.raw ?? null) : (typeof reason === "string" ? reason : null));

/** What `doGenerate` returned, as the assistant message. */
function outputOf(result) {
  const content = Array.isArray(result?.content) ? parts(result.content) : [];
  if (!Array.isArray(result?.content)) {
    // v1: `text`, `reasoning`, `toolCalls`.
    if (typeof result?.reasoning === "string" && result.reasoning) {
      content.push({ type: "reasoning", content: result.reasoning });
    }
    if (typeof result?.text === "string" && result.text) {
      content.push({ type: "text", content: result.text });
    }
    for (const call of result?.toolCalls ?? []) {
      content.push({
        type: "tool_call", id: call.toolCallId ?? null, name: call.toolName,
        arguments: argumentsOf(call.args ?? call.input),
      });
    }
  }
  return { role: "assistant", parts: content };
}

/**
 * A language-model middleware for `wrapLanguageModel`. It reports the
 * model's input to the current turn once per turn (the agent's description),
 * and -- under the agent's model-content consent -- records EVERY call the
 * turn makes, streamed or not: what it was sent, what it answered, the tool
 * calls it asked for. It changes nothing the model is sent and nothing it
 * returns.
 */
export function flywheelMiddleware() {
  const observe = (turn, params, model) => {
    try {
      turn?.observeModelInput(modelInputOf(params, model));
    } catch { /* an observation is never worth a failed call */ }
  };
  const record = (turn, request, start, fields) => {
    try {
      turn.recordModelOperation(chatOperation({
        ...request, start, end: nowUnixNano(), ...fields,
      }));
    } catch { /* an observation is never worth a failed call */ }
  };
  const capturing = (turn) => {
    try {
      return turn?.capturingModelContent?.() === true;
    } catch {
      return false;
    }
  };
  return {
    middlewareVersion: "v2",
    // THE ONE CHANGE this middleware makes to a call, and only inside a turn
    // whose approved system prompt ships approved tool descriptions (design
    // 2026-11-21, contract B): each named tool's description is the approved
    // one. A tool the overlay does not name is sent as it was.
    transformParams: async ({ params }) => applyToolDescriptionsToParams(
      params, currentTurn()?.toolDescriptions ?? null),
    wrapGenerate: async ({ doGenerate, params, model }) => {
      const turn = currentTurn();
      observe(turn, params, model);
      if (!capturing(turn)) return doGenerate();
      const start = nowUnixNano();
      let request;
      try { request = chatRequestOf(params, model); } catch { return doGenerate(); }
      let result;
      try {
        result = await doGenerate();
      } catch (err) {
        record(turn, request, start, { errorType: err?.name ?? "Error" });
        throw err;
      }
      try {
        record(turn, request, start, {
          output: outputOf(result),
          nativeFinish: finishOf(result?.finishReason),
          responseModel: result?.response?.modelId ?? null,
        });
      } catch { /* observe only */ }
      return result;
    },
    wrapStream: async ({ doStream, params, model }) => {
      const turn = currentTurn();
      observe(turn, params, model);
      if (!capturing(turn)) return doStream();
      const start = nowUnixNano();
      let request;
      try { request = chatRequestOf(params, model); } catch { return doStream(); }
      let streamed;
      try {
        streamed = await doStream();
      } catch (err) {
        record(turn, request, start, { errorType: err?.name ?? "Error" });
        throw err;
      }
      if (typeof streamed?.stream?.pipeThrough !== "function"
          || typeof TransformStream !== "function") {
        return streamed;
      }
      // The SAME chunks, passed on untouched; read on the way through.
      let textOut = "";
      let reasoning = "";
      const calls = [];
      let finish = null;
      let responseModel = null;
      let errorType = null;
      const tap = new TransformStream({
        transform(chunk, controller) {
          try {
            switch (chunk?.type) {
              case "text-delta":
                textOut += chunk.delta ?? chunk.textDelta ?? "";
                break;
              case "reasoning":
              case "reasoning-delta":
                reasoning += chunk.delta ?? chunk.textDelta ?? chunk.text ?? "";
                break;
              case "tool-call":
                calls.push({
                  type: "tool_call", id: chunk.toolCallId ?? null, name: chunk.toolName,
                  arguments: argumentsOf(chunk.input ?? chunk.args),
                });
                break;
              case "response-metadata":
                responseModel = chunk.modelId ?? responseModel;
                break;
              case "finish":
                finish = finishOf(chunk.finishReason);
                break;
              case "error":
                errorType = chunk.error?.name ?? "Error";
                break;
              default:
            }
          } catch { /* observe only */ }
          controller.enqueue(chunk);
        },
        flush() {
          const out = [];
          if (reasoning) out.push({ type: "reasoning", content: reasoning });
          if (textOut) out.push({ type: "text", content: textOut });
          out.push(...calls);
          record(turn, request, start, errorType ? { errorType } : {
            output: { role: "assistant", parts: out }, nativeFinish: finish, responseModel,
          });
        },
      });
      return { ...streamed, stream: streamed.stream.pipeThrough(tap) };
    },
  };
}

/**
 * `params` with each named function tool's description replaced by the
 * overlay's, as a COPY; `params` itself when there is nothing to replace.
 */
export function applyToolDescriptionsToParams(params, overlay) {
  if (!overlay || !Array.isArray(params?.tools)) return params;
  let changed = false;
  const tools = params.tools.map((tool) => {
    if (tool?.type === "function" && typeof tool.name === "string"
        && Object.hasOwn(overlay, tool.name)) {
      changed = true;
      return { ...tool, description: overlay[tool.name] };
    }
    return tool;
  });
  return changed ? { ...params, tools } : params;
}
