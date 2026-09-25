/**
 * What one OpenClaw run's model calls saw and said, as the shared observation.
 *
 * THE HOST HALF of production model-content capture. `genai-otlp.js` renders
 * an observation -- a turn's model calls and tool executions -- into one OTel
 * GenAI trace, byte-identically with the Python SDK. This module builds that
 * observation from the two OpenClaw hooks that can see a model boundary, and
 * from nothing else:
 *
 *   `llm_input`  the assembled SYSTEM PROMPT, the HISTORY the run starts
 *                from, the user's PROMPT as the model boundary spells it, the
 *                TOOLS offered, and the provider/model -- i.e. the complete
 *                input of the run's first model call.
 *   `agent_end`  the transcript after the run: every assistant message the
 *                model produced and every tool result that went back to it.
 *
 * Both are VOID-returning observers (see `index.js` for why that matters),
 * and both are CONVERSATION hooks: without the operator's
 * `allowConversationAccess=true` the host never calls them and nothing here
 * runs.
 *
 * RECONSTRUCTED, AND SAID SO. OpenClaw's model hooks bracket a host ATTEMPT,
 * not each provider call. So the input of the Nth call in a tool loop is the
 * first call's input plus the run's own transcript before that call's
 * answer, which is exactly what a tool loop sends -- provided the host changed
 * nothing in between. What this module can SEE of a change, it refuses rather
 * than render around:
 *
 *   - more than one `llm_input` in a run (a retry, or a re-assembly after
 *     compaction: the model saw more than one prefix);
 *   - a message whose role is not one the model boundary carries verbatim
 *     (user, assistant, toolResult) -- the host converts those in ways this
 *     plugin cannot see;
 *   - a runtime-context carrier on the user turn, which the model saw and
 *     `llm_input` does not include;
 *   - images in the prompt, whose bytes `llm_input` does not carry;
 *   - a transcript whose last user message is not the prompt `llm_input`
 *     carried: a message steered into the running session
 *     (`activeSession.steer`, which fires no second `llm_input`) that the
 *     model saw mid-run, after the input this module was told about.
 *
 * A refusal records no model boundary for that turn; the turn itself is
 * captured exactly as before.
 *
 * CLOCKS are the host's own: the `llm_input` and `agent_end` receipt times
 * bound the run, and each message's own timestamp says when its span ended.
 * Nothing is invented to fill a gap -- a span starts where the previous one
 * ended -- and a clock too coarse to separate two messages advances by one
 * nanosecond, so the transcript's order survives the decoder's time order.
 *
 * Zero dependencies.
 */
import { newSpanId } from "./genai-otlp.js";

/** OpenClaw's provider ids, as the GenAI conventions name them. Anything else
 * is passed through verbatim: the attribute is an open enum. */
const PROVIDERS = {
  openai: "openai",
  "openai-codex": "openai",
  "azure-openai-responses": "azure.ai.openai",
  anthropic: "anthropic",
  google: "gcp.gemini",
  "google-vertex": "gcp.vertex_ai",
  "google-gemini-cli": "gcp.gemini",
  "amazon-bedrock": "aws.bedrock",
  groq: "groq",
  mistral: "mistral_ai",
  xai: "x_ai",
  deepseek: "deepseek",
  cohere: "cohere",
  perplexity: "perplexity",
};

/** pi-ai's stop reasons, as a native finish reason and as the conventions'
 * output-message finish_reason. */
const FINISH = {
  stop: "stop",
  toolUse: "tool_call",
  length: "length",
};

const text = (v) => (typeof v === "string" && v ? v : null);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Milliseconds (a host timestamp) as OTLP decimal nanoseconds. */
function msToNanos(ms) {
  return (BigInt(Math.trunc(ms)) * 1000000n).toString();
}

function providerName(value) {
  const id = text(value);
  return id ? (PROVIDERS[id] ?? id) : null;
}

class Refused extends Error {}

function contentParts(content) {
  if (typeof content === "string") {
    return content ? [{ type: "text", content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === "text") {
      parts.push({ type: "text", content: typeof block.text === "string" ? block.text : "" });
    } else if (block.type === "image") {
      parts.push({
        type: "blob", modality: "image", mime_type: block.mimeType ?? null,
        content: block.data,
      });
    } else if (block.type === "thinking") {
      // Redacted reasoning is an opaque token the model is sent back, not
      // text it said; it has no part in the conventions and is not rendered.
      if (!block.redacted && typeof block.thinking === "string") {
        parts.push({ type: "reasoning", content: block.thinking });
      }
    } else if (block.type === "toolCall") {
      parts.push({
        type: "tool_call", id: block.id ?? null, name: block.name,
        arguments: block.arguments ?? {},
      });
    } else if (typeof block.type === "string") {
      parts.push({ ...block });
    }
  }
  return parts;
}

/** What a tool result's content is SENT as: its text when it is only text. */
function toolResponse(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content.every((b) => isObject(b) && b.type === "text")) {
    return content.map((b) => b.text).join("");
  }
  return contentParts(content);
}

function semconvMessage(message) {
  if (!isObject(message)) throw new Refused("a message that is not an object");
  if (message.role === "user") {
    if (message.runtimeContextCarrier) {
      throw new Refused("a runtime-context carrier the model saw and llm_input omits");
    }
    return { role: "user", parts: contentParts(message.content) };
  }
  if (message.role === "assistant") {
    return { role: "assistant", parts: contentParts(message.content) };
  }
  if (message.role === "toolResult") {
    return {
      role: "tool",
      parts: [{
        type: "tool_call_response", id: message.toolCallId ?? null,
        response: toolResponse(message.content),
      }],
    };
  }
  throw new Refused(`a ${JSON.stringify(message.role)} message the host converts unseen`);
}

function toolDefinitions(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  const out = [];
  for (const tool of tools) {
    if (!isObject(tool) || !text(tool.name)) continue;
    const def = { type: "function", name: tool.name };
    if (typeof tool.description === "string") def.description = tool.description;
    const schema = tool.parameters ?? tool.inputSchema ?? tool.input_schema;
    if (schema !== undefined) def.parameters = JSON.parse(JSON.stringify(schema));
    out.push(def);
  }
  return out.length ? out : null;
}

/**
 * The run's first model input, from one `llm_input` event, or `null` when
 * it cannot be rendered faithfully (images, or a message the host converts
 * out of sight). `at` is the receipt time, decimal nanoseconds.
 */
export function inputFromLlmInput(event, at) {
  if (!isObject(event)) return null;
  if (Number(event.imagesCount) > 0) return null;
  try {
    const history = Array.isArray(event.historyMessages) ? event.historyMessages : [];
    const input = history.map(semconvMessage);
    if (typeof event.prompt !== "string") return null;
    input.push({ role: "user", parts: [{ type: "text", content: event.prompt }] });
    return {
      at,
      // What `operationsFromRun` finds the run's start by, never rendered
      // from: the input above already carries it as the model saw it.
      prompt: event.prompt,
      provider: providerName(event.provider),
      model: text(event.model),
      system: text(event.systemPrompt)
        ? [{ type: "text", content: event.systemPrompt }] : [],
      input,
      tools: toolDefinitions(event.tools),
    };
  } catch (err) {
    if (err instanceof Refused) return null;
    throw err;
  }
}

/** A user message's text as the transcript stores it, or `null` when it is
 * not text alone. */
function userText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || !content.length) return null;
  if (!content.every((b) => isObject(b) && b.type === "text" && typeof b.text === "string")) {
    return null;
  }
  return content.map((b) => b.text).join("");
}

/**
 * Is `message` the transcript's copy of the prompt `llm_input` carried?
 *
 * OpenClaw stores the prompt BARE and may only PREFIX it at the model
 * boundary -- the `[DOW YYYY-MM-DD HH:MM TZ] ` stamp it derives from the
 * message's own timestamp, a prompt-build hook's prepended context -- so the
 * boundary's spelling ends with the stored text. Anything else is refused:
 * the run's start is then unknown, and a guessed one is worse than none.
 */
function isRunPrompt(message, prompt) {
  if (typeof prompt !== "string") return false;
  const stored = userText(message?.content);
  if (stored === null) return false;
  return stored === prompt || (stored.length > 0 && prompt.endsWith(stored));
}

/**
 * The run's model calls and tool executions, as observation operations, or
 * `null` when the transcript cannot be matched to the input it started from.
 *
 * `messages` is `agent_end`'s transcript; the run's own messages are those
 * after its last user message, which must be the prompt `first` was given --
 * a user message steered in mid-run is the last one instead, and the run's
 * start (and every call before the steer) would otherwise be lost to a
 * prompt the model never saw. `endAt` is the `agent_end` receipt time.
 */
export function operationsFromRun(first, messages, endAt) {
  if (!first || !Array.isArray(messages)) return null;
  let lastUser = -1;
  messages.forEach((m, i) => { if (isObject(m) && m.role === "user") lastUser = i; });
  if (lastUser < 0) return null;
  if (!isRunPrompt(messages[lastUser], first.prompt)) return null;
  const run = messages.slice(lastUser + 1);
  let converted;
  try {
    if (messages[lastUser].runtimeContextCarrier) return null;
    converted = run.map(semconvMessage);
  } catch (err) {
    if (err instanceof Refused) return null;
    throw err;
  }
  const calls = new Map();
  const operations = [];
  let cursor = BigInt(first.at);
  const end = BigInt(endAt);
  // Each span ends when its message was written, and never at or before the
  // previous span's end. The TRANSCRIPT's order is observed; a host clock at
  // millisecond resolution (or behind the llm_input receipt) is not fine
  // enough to carry it, and the decoder orders a conversation's spans by
  // their clocks -- two spans on one instant would be ordered by their random
  // span ids. So a clock that did not advance advances by one nanosecond: the
  // order is the host's, only the sub-millisecond spacing is not.
  const clock = (message) => {
    const ts = Number(message?.timestamp);
    let t = Number.isFinite(ts) && ts > 0 ? BigInt(msToNanos(ts)) : cursor;
    if (t > end) t = end;
    return t > cursor ? t : cursor + 1n;
  };
  let history = [...first.input];
  run.forEach((message, i) => {
    const at = clock(message);
    if (message.role === "assistant") {
      const output = converted[i];
      const stop = typeof message.stopReason === "string" ? message.stopReason : null;
      const op = {
        operation: "chat",
        span_id: newSpanId(),
        start_time_unix_nano: cursor.toString(),
        end_time_unix_nano: at.toString(),
        provider_name: providerName(message.provider) ?? first.provider,
      };
      if (first.model) op.request_model = first.model;
      const responseModel = text(message.responseModel) ?? text(message.model);
      if (responseModel) op.response_model = responseModel;
      if (first.system.length) op.system_instructions = first.system;
      op.input_messages = history;
      if (first.tools) op.tool_definitions = first.tools;
      if (stop === "error" || stop === "aborted") {
        op.error_type = text(message.errorType) ?? stop;
      } else {
        const hasCalls = output.parts.some((p) => p.type === "tool_call");
        op.output_messages = [{
          ...output,
          finish_reason: hasCalls ? "tool_call" : (FINISH[stop] ?? "stop"),
        }];
        if (stop) op.finish_reasons = [stop];
        for (const part of output.parts) {
          if (part.type === "tool_call") calls.set(part.id, part);
        }
      }
      operations.push(op);
      history = [...history, output];
    } else if (message.role === "toolResult") {
      const call = calls.get(message.toolCallId);
      const response = converted[i].parts[0].response;
      const op = {
        operation: "execute_tool",
        span_id: newSpanId(),
        start_time_unix_nano: cursor.toString(),
        end_time_unix_nano: at.toString(),
        tool_name: text(message.toolName) ?? text(call?.name) ?? "tool",
        tool_type: "function",
      };
      if (text(message.toolCallId)) op.tool_call_id = message.toolCallId;
      // Only the arguments the model actually sent: a result joined to no
      // call carries none rather than an invented `{}`.
      if (call) op.arguments = call.arguments;
      if (message.isError) op.error_type = "tool_error";
      else op.result = response;
      operations.push(op);
      history = [...history, converted[i]];
    } else {
      history = [...history, converted[i]];
    }
    cursor = at;
  });
  if (!operations.some((op) => op.operation === "chat")) return null;
  return { start: first.at, end: end.toString(), operations };
}
