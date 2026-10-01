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
 * the ones the tool recorder shares with turn capture (which conversation and
 * which task a host event belongs to) and the one model-boundary capture
 * shares with both (where a run starts in the host's transcript).
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
 * The index of the transcript's LAST user message, or -1 when there is none.
 *
 * `agent_end` hands over the SESSION's messages, every earlier turn included,
 * so a run's own messages are the ones after its last user message; anything
 * before it belongs to a turn that has already been answered. One answer,
 * because two readers ask: the answer this run gave (`lastAssistantText`) and
 * the model calls it made (`model-boundary.js`).
 */
export function lastUserIndex(messages) {
  if (!Array.isArray(messages)) return -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m !== null && typeof m === "object" && !Array.isArray(m)
        && m.role === "user") {
      return i;
    }
  }
  return -1;
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
 * different question as its own. A message steered into the running session
 * is a user message too, so a run that ends without answering it has no
 * answer here either.
 *
 * Handles both content shapes because the host uses both: a plain string, and
 * an array of parts each carrying `text`.
 */
export function lastAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  const start = lastUserIndex(messages) + 1;
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
