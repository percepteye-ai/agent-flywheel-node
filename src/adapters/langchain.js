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
 * system prompt, prompt, bound tools and model.
 */
import { currentTurn } from "../flywheel.js";

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

/**
 * A LangChain callback handler bound to the current turn or rollout.
 *
 * @param {object|null} [turn] the turn to record into; the one this is
 *   created in by default.
 */
export function flywheelCallbacks(turn = currentTurn()) {
  /** runId -> {name, args, started} for tool calls still running. */
  const pending = new Map();
  const finish = (runId, fields) => {
    const call = pending.get(runId);
    if (!call || !turn) return;
    pending.delete(runId);
    try {
      turn.recordToolCall({
        name: call.name, arguments: call.args, toolCallId: call.toolCallId,
        latencyMs: performance.now() - call.started, ...fields,
      });
    } catch { /* one lost record is not worth a failed run */ }
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
        name, args: argumentsOf(input), started: performance.now(),
        toolCallId: typeof toolCallId === "string" ? toolCallId : undefined,
      });
      while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
    },
    handleToolEnd(output, runId) {
      finish(runId, { result: output });
    },
    handleToolError(err, runId) {
      finish(runId, { error: err instanceof Error ? err : String(err) });
    },
    handleChatModelStart(llm, messages, _runId, _parentRunId, extraParams, _tags, _metadata, runName) {
      try {
        turn?.observeModelInput(modelInputOf(llm, messages, extraParams, runName));
      } catch { /* an observation is never worth a failed call */ }
    },
  };
}
