/**
 * TRAINING MODE: claim a rollout, hand it to the agent, report what happened.
 *
 * This is the half of the package that only exists in `training` mode. In
 * `production` mode `registerRolloutDriver` is NEVER CALLED, so none of these
 * hooks are subscribed and none of these calls can happen -- see `mode.js` for
 * why the split is the absence of a subscription rather than a branch inside a
 * handler.
 *
 * ── WHAT THE HOST ACTUALLY ALLOWS A THIRD-PARTY PLUGIN ────────────────────
 *
 * Every claim below was read out of the installed host (OpenClaw 2026.7.1-2),
 * not inferred from its documentation, because three of them are the opposite
 * of what the API surface suggests.
 *
 * `enqueueNextTurnInjection`  AVAILABLE. `enqueuePluginNextTurnInjection`
 *   (registry-B8eQDFB4.js:1405) has NO origin check, and
 *   `isPluginPromptInjectionEnabled` (:1389) is `!== false` -- DEFAULT-ALLOW.
 *   So delivering a task works on a default install, and it returns
 *   `{enqueued, id, sessionKey}`, which is a real verdict we can act on rather
 *   than a fire-and-forget. Limits are 32 KiB of text and 32 queued
 *   injections per session (:1368, :1370); over either, the host returns
 *   `enqueued:false` SILENTLY, which is why the size is checked here.
 *
 * `scheduleSessionTurn`       NOT AVAILABLE. `schedulePluginSessionTurn`
 *   (:1186) opens with `if (params.origin !== "bundled") return;` -- a silent
 *   no-op for any npm-installed plugin, returning `undefined`, which is
 *   indistinguishable from "cron service unavailable".
 *
 *   BUT THAT GATE IS ON THE WRAPPER, NOT ON THE CAPABILITY, and an earlier
 *   version of this comment drew the wrong conclusion from it -- that this
 *   plugin cannot start a turn at all. It can. `gateway_start` and
 *   `cron_changed` hand every plugin, whatever its origin, the RAW host cron
 *   service as `ctx.getCron()` (server-startup-post-attach-B3O9knW5.js:765,
 *   server-cron-Cwg2hJro.js:4384), `registerTypedHook` gates only conversation
 *   hooks by origin and prompt-injection hooks by policy -- neither covers
 *   `gateway_start` -- and `server-cron` contains no origin check anywhere. A
 *   job with `payload.kind: "agentTurn"` and `sessionTarget: "session:<key>"`
 *   reaches `runIsolatedAgentJob` (:2433) and then `runCronIsolatedAgentTurn`
 *   (:4484), which runs the agent.
 *
 *   THIS LANE DELIBERATELY DOES NOT USE THAT PATH, which is a product
 *   decision and not a technical limit. Reaching past a restriction the host
 *   states explicitly ("Bundled-only") by way of a service it hands out
 *   elsewhere is depending on what looks like an inconsistency in someone
 *   else's permission model: it can be closed in a patch release, and it is
 *   not a thing to do silently inside a customer's agent. If unattended
 *   rollouts are wanted, that is the mechanism -- taken as a decision, with
 *   the operator told what it does.
 *
 *   So today the task is placed in the NEXT turn the operator or harness
 *   starts. The Python SDK's CLI-hook lane has the same shape -- there a
 *   SessionStart hook writes the task into the working directory -- so the
 *   parity statement holds; this lane simply delivers into the agent's real
 *   context, exactly once, with a delivery verdict.
 *
 * `agent_end`                 CONVERSATION-GATED. It is in
 *   `CONVERSATION_HOOK_NAMES`, and a non-bundled plugin's registration is
 *   dropped with a host-side warning unless
 *   `plugins.entries.<id>.hooks.allowConversationAccess=true` (:4225-4235).
 *   The refusal is a bare `return` -- `api.on()` reports nothing either way --
 *   so it cannot be detected after the fact and is read from `api.config`
 *   instead, using the host's own predicate.
 *
 * ── WHY WE REFUSE TO CLAIM WITHOUT THE ANSWER CHANNEL ─────────────────────
 *
 * A claimed rollout is a LEASE on work nobody else can take. Claiming one we
 * cannot report is worse than not claiming it: the task sits unrunnable until
 * the lease lapses, and the queue looks busy while nothing progresses. So
 * conversation access is part of `canDrive` rather than something discovered
 * at report time -- and when it is missing the operator gets one line naming
 * the exact setting, instead of a queue that quietly stops moving.
 */
import { ConfigurationError } from "./errors.js";
import { createUnattendedRunner, cronTurnStarter } from "./unattended.js";

export const SESSION_START = "session_start";
export const SESSION_END = "session_end";
export const AGENT_END = "agent_end";
export const GATEWAY_START = "gateway_start";
export const GATEWAY_STOP = "gateway_stop";

/** The host's own ceilings, so an oversized task is refused, not dropped. */
export const MAX_INJECTION_BYTES = 32 * 1024;

/**
 * Does the host permit this plugin the conversation hooks, per the host's own
 * rule?
 *
 * THE HOST'S PREDICATE, not a paraphrase of it: non-bundled plugins need
 * `allowConversationAccess === true` explicitly, and this package is
 * non-bundled by construction -- it is installed from npm, and a bundled
 * plugin is one shipped inside OpenClaw itself. Read from `api.config`, which
 * is the same config object the registry consults.
 */
export function conversationAccessGranted(api, pluginId) {
  const entry = api?.config?.plugins?.entries?.[pluginId];
  return entry?.hooks?.allowConversationAccess === true;
}

/**
 * Everything that must be true before this install claims work.
 *
 * Returns `{canDrive, reason}` -- and the reason names ONE cause, the first
 * unmet one, rather than listing every possible cause for all of them. An
 * operator reading "set allowConversationAccess" acts; an operator reading
 * "check your mode, key and hooks" opens three files.
 */
export function driveVerdict(config, api, pluginId) {
  if (config?.mode !== "training") {
    return {
      canDrive: false,
      reason:
        `mode is '${config?.mode}', so this install observes only and claims ` +
        `no rollouts. Set PERCEPTEYE_AGENT_MODE=training to contribute.`,
    };
  }
  if (!config?.apiKey) {
    return {
      canDrive: false,
      reason:
        "training mode is set but no API key resolved, so there is no control " +
        "plane to claim from. Set PERCEPTEYE_API_KEY, or " +
        `plugins.entries.${pluginId}.config.apiKey.`,
    };
  }
  if (!conversationAccessGranted(api, pluginId)) {
    return {
      canDrive: false,
      reason:
        `rollouts need the agent's ANSWER, which arrives on the '${AGENT_END}' ` +
        `hook, and this host drops that hook for non-bundled plugins unless ` +
        `plugins.entries.${pluginId}.hooks.allowConversationAccess=true. ` +
        `Claiming work we cannot report would hold a lease until it lapsed, ` +
        `so nothing is claimed until that is set.`,
    };
  }
  return { canDrive: true, reason: null };
}

/** The task, as the agent will read it. */
export function taskText(rollout) {
  return (
    `A PerceptEye rollout has been assigned to this session.\n\n` +
    `Rollout id: ${rollout.rolloutId}\n\n` +
    `Task:\n${rollout.turnInput}\n`
  );
}

/**
 * The claim-deliver-report loop, with no host bound to it.
 *
 * `deps` is every host call this needs, so the loop is testable without
 * constructing an OpenClaw api: `enqueue` is
 * `api.session.workflow.enqueueNextTurnInjection`.
 */
export function createRolloutDriver({ transport, enqueue, logger = null }) {
  if (!transport) throw new ConfigurationError("a transport is required");
  if (typeof enqueue !== "function") {
    throw new ConfigurationError("an enqueue function is required");
  }

  /** sessionKey -> the rollout this session is running. */
  const inFlight = new Map();
  /**
   * Sessions with a claim in flight but not yet recorded.
   *
   * SEPARATE FROM `inFlight`, because `inFlight` cannot be populated until the
   * claim returns and the guard has to hold across that await. Checking
   * `inFlight` alone let two `session_start` events for one session both pass
   * the check before either finished claiming -- two leases for one session,
   * of which only the second could ever be delivered or reported, with the
   * first left to lapse.
   */
  const claiming = new Set();

  /**
   * Give the work back, typed, and stop tracking it.
   *
   * ALWAYS TYPED. An abandon is "do not train on this" -- a substrate fault --
   * not a low score. Reporting an undeliverable rollout as a zero-reward one
   * would teach the policy that its own behaviour caused an outcome it never
   * participated in.
   */
  async function giveBack(sessionKey, rollout, reason, detail) {
    inFlight.delete(sessionKey);
    try {
      await transport.abandon(rollout, { reason, detail });
    } catch (err) {
      logger?.warn?.(
        `[percepteye] could not abandon rollout ${rollout.rolloutId}; its ` +
        `lease will lapse on its own: ${err?.message ?? err}`,
      );
    }
  }

  /** Record a rollout as running in `sessionKey`, so `onAgentEnd` reports it. */
  function track(sessionKey, rollout) {
    inFlight.set(sessionKey, rollout);
  }

  async function onSessionStart(event) {
    const sessionKey = event?.sessionKey ?? event?.sessionId;
    if (!sessionKey || inFlight.has(sessionKey) || claiming.has(sessionKey)) {
      return null;
    }
    // Reserved SYNCHRONOUSLY, before the first await, so a second event for
    // this session cannot slip past the guard while the claim is in flight.
    claiming.add(sessionKey);
    try {
      return await claimAndDeliver(sessionKey);
    } finally {
      claiming.delete(sessionKey);
    }
  }

  async function claimAndDeliver(sessionKey) {
    let claimed;
    try {
      claimed = await transport.claim(1);
    } catch (err) {
      // A control plane that cannot be reached must never break the agent.
      // No rollout is delivered and the session runs as an ordinary one.
      logger?.warn?.(
        `[percepteye] could not claim a rollout: ${err?.message ?? err}`,
      );
      return null;
    }
    const rollout = claimed?.rollouts?.[0];
    if (!rollout) return null;

    const text = taskText(rollout);
    // Checked BEFORE sending, because over the ceiling the host returns
    // `enqueued:false` with no reason and the task would look delivered-then-
    // rejected rather than too big.
    if (Buffer.byteLength(text, "utf8") > MAX_INJECTION_BYTES) {
      await giveBack(
        sessionKey, rollout, "substrate_unavailable",
        `task is ${Buffer.byteLength(text, "utf8")} bytes; this host caps a ` +
        `next-turn injection at ${MAX_INJECTION_BYTES}`,
      );
      return null;
    }

    inFlight.set(sessionKey, rollout);

    let result;
    try {
      result = await enqueue({
        sessionKey,
        text,
        // The rollout id, so a retried claim of the SAME rollout cannot
        // deliver the task twice into one session. The host dedupes on this.
        idempotencyKey: `percepteye-rollout-${rollout.rolloutId}`,
        placement: "prepend_context",
      });
    } catch (err) {
      await giveBack(
        sessionKey, rollout, "entrypoint_error",
        `the host refused the task injection: ${err?.message ?? err}`,
      );
      return null;
    }

    if (!result?.enqueued) {
      // The agent will never see this task, so the rollout must go back now.
      // Holding it until the lease lapses helps nobody and makes the queue
      // look busier than it is.
      await giveBack(
        sessionKey, rollout, "entrypoint_error",
        "the host declined to queue the task for the next turn, so the agent " +
        "never received it (check " +
        "plugins.entries.percepteye-agent-flywheel.hooks.allowPromptInjection)",
      );
      return null;
    }

    logger?.info?.(
      `[percepteye] rollout ${rollout.rolloutId} delivered to session ` +
      `${sessionKey}; it runs on the next turn.`,
    );
    return rollout;
  }

  /**
   * The agent finished. Report the answer.
   *
   * `PluginHookAgentEndEvent` carries no session key -- it is
   * `{runId, messages, success, error, durationMs}` -- so the key comes from
   * the hook CONTEXT, which is `PluginHookSessionContext`.
   *
   * THIS FIRES PER ATTEMPT, NOT PER TURN. A host that retries a failed attempt
   * emits it again, so the FIRST attempt is the one reported: the rollout is
   * removed from `inFlight` here, and a later attempt finds nothing and
   * reports nothing. That is deliberate -- reporting twice would be worse --
   * but it does mean a rollout whose first attempt failed and whose retry
   * succeeded is reported as the failure. Written down rather than left to be
   * discovered from a confusing reward curve; reporting the final outcome
   * instead needs a per-turn signal this hook does not carry.
   */
  async function onAgentEnd(event, ctx) {
    const sessionKey = ctx?.sessionKey ?? ctx?.sessionId;
    const rollout = sessionKey ? inFlight.get(sessionKey) : null;
    if (!rollout) return null;
    inFlight.delete(sessionKey);

    if (event?.success === false) {
      // The agent RAN and failed. That is a real attempt and exactly what
      // training must see, so it is REPORTED, not abandoned -- the two are
      // opposite handling and sharing one label is how a real failure gets
      // triaged as a substrate fault.
      logger?.info?.(
        `[percepteye] rollout ${rollout.rolloutId} ran and failed; reporting it.`,
      );
    }

    const finalText = lastAssistantText(event?.messages);
    try {
      await transport.report(rollout, {
        finalText,
        // `undefined`, never `[]`. The recorder owns tool calls and writes
        // them to the trajectory; asserting zero here would overwrite what it
        // observed with a claim this function cannot make.
        success: event?.success === true ? true : undefined,
      });
      return rollout;
    } catch (err) {
      logger?.warn?.(
        `[percepteye] could not report rollout ${rollout.rolloutId}: ` +
        `${err?.message ?? err}`,
      );
      return null;
    }
  }

  /**
   * The session ended with a rollout still in flight, so no answer ever
   * arrived. Give it back rather than reporting an empty result: a report with
   * no final text is a report about nothing, and it would count as a completed
   * rollout.
   */
  async function onSessionEnd(event) {
    const sessionKey = event?.sessionKey ?? event?.sessionId;
    const rollout = sessionKey ? inFlight.get(sessionKey) : null;
    if (!rollout) return null;
    await giveBack(
      sessionKey, rollout, "cancelled",
      `the session ended (${event?.reason ?? "unknown"}) before the agent ` +
      `answered, so no trajectory was produced`,
    );
    return rollout;
  }

  // `track` and `giveBack` are what the UNATTENDED runner needs: it does its
  // own claiming and turn-starting, but reporting and typed abandon must stay
  // in one place, or an unattended rollout and an attended one would end two
  // different ways.
  return { onSessionStart, onAgentEnd, onSessionEnd, inFlight, track, giveBack };
}

/** The last assistant message's text, or "" when there is none. */
export function lastAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || typeof m !== "object" || m.role !== "assistant") continue;
    const { content } = m;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content
        .filter((p) => p && typeof p === "object" && typeof p.text === "string")
        .map((p) => p.text)
        .join("");
      if (text) return text;
    }
  }
  return "";
}

/**
 * Subscribe the driver. CALLED ONLY IN TRAINING MODE.
 *
 * Returns `null` when this install must not drive, having said why once. The
 * caller does not branch on mode -- `index.js` decides that -- so there is one
 * place where "may this install claim work" is answered.
 */
export function registerRolloutDriver(api, { config, transport, pluginId, logger = null }) {
  const verdict = driveVerdict(config, api, pluginId);
  if (!verdict.canDrive) {
    logger?.info?.(`[${pluginId}] not claiming rollouts: ${verdict.reason}`);
    return null;
  }
  const enqueueFn = api?.session?.workflow?.enqueueNextTurnInjection
    ?? api?.enqueueNextTurnInjection;
  if (typeof enqueueFn !== "function") {
    logger?.warn?.(
      `[${pluginId}] this host exposes no next-turn injection API, so a ` +
      `claimed task could not be delivered to the agent. Not claiming.`,
    );
    return null;
  }

  const driver = createRolloutDriver({
    transport,
    enqueue: (injection) => enqueueFn.call(api.session?.workflow ?? api, injection),
    logger,
  });

  // Failures are swallowed at the boundary: a telemetry plugin must never be
  // able to break the agent it is measuring.
  const safe = (fn) => (event, ctx) => {
    Promise.resolve()
      .then(() => fn(event, ctx))
      .catch((err) => logger?.warn?.(
        `[${pluginId}] rollout hook failed: ${err?.message ?? err}`));
  };

  api.on(SESSION_START, safe(driver.onSessionStart));
  api.on(AGENT_END, safe(driver.onAgentEnd));
  api.on(SESSION_END, safe(driver.onSessionEnd));

  // ── THE UNATTENDED LANE, ON BY DEFAULT IN TRAINING MODE ───────────────
  //
  // Reached only from training mode, because that is the only mode in which
  // this function is called at all. Note what is NOT done here: the hooks
  // above stay subscribed either way, so if the cron seam is unavailable the
  // plugin keeps claiming and delivering through injection rather than losing
  // rollouts entirely. Unattended is an ADDITION to that lane, not a
  // replacement for it -- which is what makes the kill switch cheap and the
  // degradation path safe.
  let unattended = null;
  if (config.unattended) {
    // `getCron` lives on the gateway hook CONTEXT and nowhere else, so it has
    // to be captured when the hook fires and resolved lazily afterwards -- the
    // service may not be up at `gateway_start`, which is why this stores the
    // context rather than the service. `cron_changed` carries the same
    // context and is captured too, so a cron that arrives later is still
    // reachable.
    let gatewayCtx = null;
    unattended = createUnattendedRunner({
      transport,
      driver,
      startTurn: cronTurnStarter(() => gatewayCtx?.getCron?.()),
      logger,
    });
    const capture = (_event, ctx) => {
      if (ctx?.getCron) gatewayCtx = ctx;
      unattended.start();
    };
    api.on(GATEWAY_START, safe(capture));
    api.on("cron_changed", safe(capture));
    api.on(GATEWAY_STOP, safe(() => unattended.stop()));
    logger?.info?.(
      `[${pluginId}] unattended rollouts are ON: this plugin starts its own ` +
      `turns in dedicated 'percepteye-rollout-*' sessions, one at a time, in ` +
      `training mode only. Set config.unattended=false (or ` +
      `PERCEPTEYE_UNATTENDED=0) to keep claiming rollouts but only deliver ` +
      `them into turns you start.`,
    );
  }

  driver.unattended = unattended;
  return driver;
}
