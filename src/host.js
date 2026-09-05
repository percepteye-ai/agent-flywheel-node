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
 * training driver, and vice versa), so the shared answers live here.
 */

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
 * The last assistant message's text, or `""` when there is none.
 *
 * `""` rather than a guess. A turn whose answer we never saw is a real state
 * that both lanes handle explicitly -- the rollout driver gives the work back,
 * and capture stores the turn with a null `final_text` for the control plane to
 * grade advisory. Inventing an answer here would remove that distinction from
 * both at once.
 *
 * Handles both content shapes because the host uses both: a plain string, and
 * an array of parts each carrying `text`.
 */
export function lastAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
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
