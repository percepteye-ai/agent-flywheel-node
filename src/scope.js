/**
 * WHOSE RUN IS THIS, and does the control plane's answer apply to it?
 *
 * ONE PREDICATE, asked by BOTH halves of the last mile. The prompt half
 * (`before_prompt_build`) and the model half (`before_model_resolve`) are two
 * hooks with one question behind them -- "is this the flywheel agent's own
 * turn?" -- and the moment each asked it for itself they would drift. So it is
 * asked here, once, and `policy.js` consults nothing else.
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE ───────────────────────────────────────
 *
 * The prompt handler took NO ARGUMENTS. It returned the approved prompt for
 * every `before_prompt_build` in the process, and the host runs that hook for
 * every agent, every subagent and every cron turn a gateway serves. An
 * operator approving a bundle for ONE agent got a process-wide prompt swap:
 * a subagent whose whole job is summarising a file got a support agent's
 * instructions, and so did a scheduled maintenance turn.
 *
 * The host does supply the identity -- it was simply not read.
 * `buildAgentHookContext` (lifecycle-hook-helpers-BwL6869q.js:9-34) puts
 * `agentId` and `sessionKey` on the context both hooks receive, and both call
 * sites pass it: `before_prompt_build` at
 * agent-harness-runtime-827dyFNd.js:139,151 and
 * attempt.prompt-helpers-kaS3UZwL.js:131-135, `before_model_resolve` at
 * embedded-agent-DGUuxGR2.js:2292-2335. Verified against the INSTALLED host,
 * OpenClaw 2026.7.1-2.
 *
 * ── WHAT A SESSION KEY SAYS ───────────────────────────────────────────────
 *
 * `agent:<agentId>:<rest>`, and `rest` carries the KIND. The host's own
 * predicates are `isSubagentSessionKey` and `isCronSessionKey`
 * (session-key-utils-A-JGvyXu.js:168-183); the two below are the same
 * questions asked the same way, because a subagent and a cron turn are
 * ORDINARY runs of the same agent and the session key is the only thing that
 * tells them apart.
 *
 * They are re-implemented rather than imported: `openclaw/dist/*` is the
 * host's private build output, its file names carry content hashes that move
 * every release, and this package declares no dependency on the host at all.
 * A copy that can go stale is the lesser evil against an import that breaks on
 * the next patch release -- and both halves fail CLOSED if it ever does drift,
 * because an unrecognised key shape is not a match.
 *
 * ── AND WHEN WE CANNOT TELL ───────────────────────────────────────────────
 *
 * Nothing is applied. That is the opposite of this file's neighbours -- the
 * control-plane reads fail OPEN, because keeping the prompt you have is the
 * safe answer there. Here the safe answer is the other one: applying another
 * agent's approved prompt is a change nobody asked for, and declining to apply
 * our own costs the improvement and nothing else.
 */

/** The host's default agent id (`DEFAULT_AGENT_ID`, account-selection-CccGNkkz.js:5). */
export const DEFAULT_HOST_AGENT_ID = "main";

/**
 * The host's own agent-id normalisation
 * (`normalizeAgentId`, account-selection-CccGNkkz.js:5-8).
 *
 * Returns `null` rather than the default for an empty value, deliberately: the
 * host folds "" to `main`, and folding it here would turn "the host named no
 * agent" into "the host named the default agent" -- which is a claim, not an
 * observation, and it is the claim that decides whether a prompt is swapped.
 */
export function normalizeAgentId(value) {
  const id = String(value ?? "").trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
  return id || null;
}

/**
 * `{agentId, rest}` for an agent-scoped session key, or null.
 *
 * Mirrors `parseAgentSessionKey` (session-key-utils-A-JGvyXu.js:154-167). The
 * host preserves the case of a handful of opaque peer ids while lowercasing
 * the rest; lowercasing the whole string is equivalent for every question
 * asked here, because the segments read are the leading `agent:` wrapper and
 * the `cron:` / `subagent:` marker that follows it, never a peer id.
 */
export function parseAgentSessionKey(sessionKey) {
  const raw = String(sessionKey ?? "").trim().toLowerCase();
  if (!raw) return null;
  const parts = raw.split(":");
  if (parts.length < 3 || parts[0] !== "agent" || !parts[1] || !parts[2]) {
    return null;
  }
  const rest = parts.slice(2).join(":");
  return rest ? { agentId: parts[1], rest } : null;
}

/** A subagent's session. `isSubagentSessionKey`, :178-183. */
export function isSubagentSessionKey(sessionKey) {
  const raw = String(sessionKey ?? "").trim().toLowerCase();
  if (!raw) return false;
  if (raw.startsWith("subagent:")) return true;
  return parseAgentSessionKey(raw)?.rest.startsWith("subagent:") === true;
}

/** A cron turn's session. `isCronSessionKey`, :173-177. */
export function isCronSessionKey(sessionKey) {
  const raw = String(sessionKey ?? "").trim().toLowerCase();
  if (!raw) return false;
  return parseAgentSessionKey(raw)?.rest.startsWith("cron:") === true;
}

/**
 * The agent ids this host is configured to run.
 *
 * `cfg.agents.list[].id`, falling back to the single default agent -- the same
 * shape and the same fallback as `listAgentIds`
 * (agent-scope-config-BxAUeF6t.js:35-53). `api.config` is the host's own
 * config object, the one its registry consults; `host.js` already reads it for
 * the conversation-access opt-in.
 */
export function hostAgentIds(hostConfig) {
  const list = hostConfig?.agents?.list;
  if (!Array.isArray(list)) return [DEFAULT_HOST_AGENT_ID];
  const ids = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const id = normalizeAgentId(entry.id);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.length ? ids : [DEFAULT_HOST_AGENT_ID];
}

/**
 * WHICH HOST AGENT this install's approved bundle is for.
 *
 * The two names are in different namespaces and this is where they are
 * joined. `agentId` is what the plugin registers with the control plane and
 * what `/prompt/current` answers about; `ctx.agentId` is the OpenClaw agent id
 * the host runs turns under, whose default is `main`. Comparing them raw would
 * refuse every default install (`openclaw` != `main`) and call that safety.
 *
 * So, in order:
 *
 *   1. the configured name IS one of this host's agents -- use it. An operator
 *      running several agents names the one this install serves and gets
 *      exactly that agent.
 *   2. this host runs exactly ONE agent -- use it. There is nothing else this
 *      bundle could be for, and this is the ordinary install.
 *   3. several agents, none of them named -- REFUSE, with the remedy. This is
 *      the only genuinely ambiguous case and it is the one where guessing
 *      swaps a bystander's prompt.
 *
 * @returns {{id: string|null, sole: boolean, reason: string}}
 */
export function resolveServedAgent({ agentId, hostConfig } = {}) {
  const ids = hostAgentIds(hostConfig);
  const sole = ids.length === 1;
  const wanted = normalizeAgentId(agentId);
  if (wanted && ids.includes(wanted)) return { id: wanted, sole, reason: "" };
  if (sole) return { id: ids[0], sole: true, reason: "" };
  return {
    id: null,
    sole: false,
    reason:
      `this host runs ${ids.length} agents (${ids.join(", ")}) and none of ` +
      `them is named ${JSON.stringify(wanted ?? "")}, so there is no way to ` +
      "tell which one the control plane's answer is about. Set this " +
      "plugin's `agentId` to the OpenClaw agent id it serves",
  };
}

/**
 * DOES THE APPROVED ANSWER APPLY TO THIS RUN?
 *
 * @param {object|null} ctx     the host's hook context
 * @param {{id: string|null, sole: boolean, reason: string}} served
 * @returns {{apply: boolean, reason: string}} `reason` is "" only when applying
 */
export function scopeDecision(ctx, served) {
  if (!served || !served.id) {
    return { apply: false, reason: served?.reason || "no agent is resolved" };
  }
  if (!ctx || typeof ctx !== "object") {
    return {
      apply: false,
      reason: "the host passed no hook context, so this run cannot be told " +
        "apart from another agent's",
    };
  }
  const sessionKey = String(ctx.sessionKey ?? "").trim();
  const hostAgent = normalizeAgentId(ctx.agentId)
    ?? parseAgentSessionKey(sessionKey)?.agentId
    ?? null;

  // NEITHER IDENTIFIER. Not a shape this host produces for an agent turn --
  // `buildAgentHookContext` carries both -- so it is a host we do not know,
  // and the answer to "is this our agent" is that we cannot tell.
  if (!sessionKey && !hostAgent) {
    return {
      apply: false,
      reason: "the host named neither an agent nor a session for this run, " +
        "so it cannot be told apart from another agent's",
    };
  }

  // A SUBAGENT IS NOT THE AGENT. It runs the same host agent id under a
  // different job -- summarise this, search that -- and the approved bundle
  // was certified against the turns the agent serves its users, which is the
  // population the control plane graded and trained on.
  if (isSubagentSessionKey(sessionKey)) {
    return {
      apply: false,
      reason: "this is a subagent session; the approved bundle was certified " +
        "for the agent's own turns, not for the jobs it delegates",
    };
  }

  // A CRON TURN IS NOT A SERVED TURN. Nobody is waiting on it and nothing
  // about it was measured.
  if (isCronSessionKey(sessionKey)) {
    return {
      apply: false,
      reason: "this is a scheduled (cron) session, not a turn this agent is " +
        "serving a user",
    };
  }

  if (hostAgent) {
    return hostAgent === served.id
      ? { apply: true, reason: "" }
      : {
        apply: false,
        reason: `this run belongs to host agent ${JSON.stringify(hostAgent)}, ` +
          `and the control plane's answer is for ${JSON.stringify(served.id)}`,
      };
  }

  // A session key we could parse no agent out of. Safe on a single-agent
  // host, because there is no other agent it could belong to; on a host
  // running several it is exactly the ambiguity that has to fail closed.
  return served.sole
    ? { apply: true, reason: "" }
    : {
      apply: false,
      reason: "the host named no agent for this run and this host runs " +
        "several, so it cannot be attributed to one",
    };
}
