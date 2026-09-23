/**
 * What this host permits, and what its events mean.
 *
 * ONE ANSWER PER QUESTION, and this module exists because there were briefly
 * two. Both lanes -- the training rollout driver and production turn capture --
 * need the agent's answer off `agent_end`, and both must know whether this host
 * will deliver that hook at all. Each grew its own copy: `lastAssistantText`
 * and `conversationAccessGranted` were written twice, in `rollout.js` and
 * `capture.js`, with the same intent and slightly different code. That is the
 * shape this codebase keeps finding, and it fails the same way every time --
 * one copy gets fixed.
 *
 * Neither lane may import the other (production must not reach into the
 * training driver, and vice versa), so the shared answers live here -- as do
 * the ones the tool recorder shares with turn capture: which conversation and
 * which task a host event belongs to.
 */
import { productionIdentifier } from "./wire.js";

/**
 * Does the host permit this plugin the CONVERSATION hooks?
 *
 * THE HOST'S OWN PREDICATE, not a paraphrase. `registerTypedHook` drops a
 * conversation hook -- `agent_end` among them -- for any plugin whose origin is
 * not `bundled` unless `allowConversationAccess === true`, and the refusal is a
 * bare `return`: `api.on()` reports nothing either way, so this cannot be
 * detected after the fact. This package is non-bundled by construction (it is
 * installed from npm), so the origin half is always true and only the explicit
 * opt-in is in question.
 *
 * Read from `api.config`, which is the same config object the host's registry
 * consults.
 */
export function conversationAccessGranted(api, pluginId) {
  return api?.config?.plugins?.entries?.[pluginId]
    ?.hooks?.allowConversationAccess === true;
}

/**
 * Which conversation a host event belongs to: the host's canonical session
 * key, which it documents as the same value on every hook of one session.
 * `null` when there is none, or when it is not an identifier the wire carries
 * exactly -- never a cleaned-up variant of one.
 */
export function conversationIdOf(event, ctx) {
  return productionIdentifier(event?.sessionKey ?? ctx?.sessionKey);
}

/** The caller-authored task/case id a host event carries, or `null`. */
export function taskIdOf(event, ctx) {
  return productionIdentifier(
    event?.taskId ?? event?.task_id ?? ctx?.taskId ?? ctx?.task_id,
  );
}

/**
 * Where THIS run's messages begin in an `agent_end` transcript.
 *
 * The host hands over the SESSION's messages, every earlier turn included, so
 * a run starts after the last message the user sent. Anything before that
 * belongs to a turn that has already been answered.
 */
function currentTurnStart(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") return i + 1;
  }
  return 0;
}

/**
 * The last assistant message's text IN THIS RUN, or `""` when there is none.
 *
 * `""` rather than a guess. A turn whose answer we never saw is a real state
 * that both lanes handle explicitly -- the rollout driver gives the work back,
 * and capture stores the turn with a null `final_text` for the control plane to
 * grade advisory. Inventing an answer here would remove that distinction from
 * both at once.
 *
 * BOUNDED BY THE LAST USER MESSAGE. The transcript is the whole session, so a
 * search that ran to its start took the PREVIOUS turn's answer whenever this
 * run produced no text -- a run that failed mid-tool reported the answer to a
 * different question as its own.
 *
 * Handles both content shapes because the host uses both: a plain string, and
 * an array of parts each carrying `text`.
 */
export function lastAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  const start = currentTurnStart(messages);
  for (let i = messages.length - 1; i >= start; i -= 1) {
    const m = messages[i];
    if (!m || typeof m !== "object" || m.role !== "assistant") continue;
    const { content } = m;
    if (typeof content === "string" && content.trim()) return content;
    if (Array.isArray(content)) {
      const text = content
        .filter((p) => p && typeof p === "object" && typeof p.text === "string")
        .map((p) => p.text).join("");
      if (text.trim()) return text;
    }
  }
  return "";
}

/**
 * The host's `stopReason` in the OTel GenAI finish-reason vocabulary.
 *
 * The host normalises every provider's stop reason to its own words, so the
 * provider's native value is not available here; these are the convention's
 * own enum values. `aborted` is `error` because the convention asks for
 * `error` wherever a finish reason was expected and not received. A value
 * this table does not know is carried as it is rather than guessed at.
 */
const FINISH_REASONS = Object.freeze({
  stop: "stop",
  length: "length",
  toolUse: "tool_call",
  error: "error",
  aborted: "error",
});

/** The host's content parts in the convention's part shapes. */
function genaiParts(content) {
  if (typeof content === "string") {
    return content ? [{ type: "text", content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const p of content) {
    if (!p || typeof p !== "object" || typeof p.type !== "string") continue;
    if (p.type === "text" && typeof p.text === "string") {
      parts.push({ type: "text", content: p.text });
    } else if (p.type === "thinking" && typeof p.thinking === "string") {
      parts.push({ type: "reasoning", content: p.thinking });
    } else if (p.type === "toolCall" && typeof p.name === "string") {
      const call = { type: "tool_call" };
      if (typeof p.id === "string") call.id = p.id;
      call.name = p.name;
      call.arguments = p.arguments ?? null;
      parts.push(call);
    } else if (p.type === "image" && typeof p.data === "string") {
      const blob = { type: "blob", modality: "image" };
      if (typeof p.mimeType === "string") blob.mime_type = p.mimeType;
      blob.content = p.data;
      parts.push(blob);
    } else {
      // A part type the convention has no mapping for is carried whole: its
      // generic part shape accepts any `type`, and dropping it would lose
      // what the model was actually shown.
      parts.push(p);
    }
  }
  return parts;
}

/**
 * What a tool returned, as the model received it: the text when every part
 * is text, otherwise the host's parts exactly as they were.
 */
function toolResponse(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content.length
      && content.every((p) => p && typeof p === "object"
        && typeof p.text === "string")) {
    return content.map((p) => p.text).join("");
  }
  return content ?? null;
}

/** One host message in the convention's shape, or null when it has no role. */
function genaiMessage(m, { output = false } = {}) {
  if (!m || typeof m !== "object" || typeof m.role !== "string") return null;
  if (m.role === "toolResult") {
    const part = { type: "tool_call_response" };
    if (typeof m.toolCallId === "string") part.id = m.toolCallId;
    part.response = toolResponse(m.content);
    return { role: "tool", parts: [part] };
  }
  const message = { role: m.role, parts: genaiParts(m.content) };
  if (output && typeof m.stopReason === "string" && m.stopReason) {
    message.finish_reason = FINISH_REASONS[m.stopReason] ?? m.stopReason;
  }
  return message;
}

/**
 * One `agent_end` transcript as a turn in the convention's shape.
 *
 * `output` is the answer -- the transcript's final message, when the run
 * ended on one from the assistant -- and `input` is everything the agent was
 * given before it: earlier turns, the user's message, and this run's own tool
 * calls and their responses, in order. That is exactly what the last model
 * call saw and what it produced, so the two together are the whole
 * conversation; the host's transcript used to be read for its last text and
 * discarded.
 *
 * A run that did not end on an assistant message (aborted mid-tool) has no
 * answer: everything is input and `output` is empty.
 */
export function genaiTurn(messages) {
  const all = Array.isArray(messages)
    ? messages.filter((m) => m && typeof m === "object")
    : [];
  const last = all.length - 1;
  const answered = last >= 0 && all[last].role === "assistant";
  const input = (answered ? all.slice(0, last) : all)
    .map((m) => genaiMessage(m))
    .filter(Boolean);
  const output = answered ? [genaiMessage(all[last], { output: true })] : [];
  return { input, output };
}
