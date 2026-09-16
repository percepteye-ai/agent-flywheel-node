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
 *   THIS LANE USES THAT PATH, IN TRAINING MODE, AND SAYS SO. An earlier
 *   version of this header said the opposite -- "deliberately does not use
 *   that path" -- and it stayed there after `registerRolloutDriver` below
 *   started wiring it, which made the most sensitive claim in the package a
 *   false one. Reaching past a restriction the host states explicitly
 *   ("Bundled-only") by way of a service it hands out elsewhere is depending
 *   on what looks like an inconsistency in someone else's permission model,
 *   so it is done as a decision with three things designed in:
 *
 *     - TRAINING MODE ONLY, structurally: this function is not called at all
 *       in production, so a process serving real users can never start a turn
 *       on its own, whatever any setting says.
 *     - IN A DEDICATED SESSION, `percepteye-rollout-<id>`, never one a person
 *       is using, and with `delivery.mode: "none"` so training output cannot
 *       surface in a human's chat.
 *     - DEGRADING WHEN THE SEAM CLOSES, which a patch release may do at any
 *       time: the runner stops polling and this file's injection lane carries
 *       on alone. See `unattended.js` for the mechanism and why stopping (not
 *       just announcing) is the whole of it.
 *
 *   The injection lane below is NOT replaced by any of that. It stays
 *   subscribed and it is what runs when there is no cron: the task is placed
 *   in the NEXT turn the operator or harness starts. The Python SDK's CLI-hook
 *   lane has the same shape -- there a SessionStart hook writes the task into
 *   the working directory -- so the parity statement holds; this lane simply
 *   delivers into the agent's real context, exactly once, with a delivery
 *   verdict.
 *
 * `agent_end`                 CONVERSATION-GATED. It is in
 *   `CONVERSATION_HOOK_NAMES`, and a non-bundled plugin's registration is
 *   dropped with a host-side warning unless
 *   `plugins.entries.<id>.hooks.allowConversationAccess=true` (:4225-4235).
 *   The refusal is a bare `return` -- `api.on()` reports nothing either way --
 *   so it cannot be detected after the fact and is read from `api.config`
 *   instead, using the host's own predicate.
 *
 * llm_input / llm_output are available, but they bracket a host attempt
 * rather than each provider invocation and carry no call id. Tool loops,
 * retries, and compaction can issue several provider calls inside one
 * attempt. This adapter therefore makes no llm_call_count claim. A custom
 * host adapter may inject the generic counter only with true per-call evidence.
 *
 * A claimed rollout is a LEASE on work nobody else can take. Claiming one we
 * cannot report is worse than not claiming it: the task sits unrunnable until
 * the lease lapses, and the queue looks busy while nothing progresses. So
 * conversation access is part of `canDrive` rather than something discovered
 * at report time -- and when it is missing the operator gets one line naming
 * the exact setting, instead of a queue that quietly stops moving.
 *
 * ── AND REPORTING IT IS NOT ALLOWED TO BE SILENT ──────────────────────────
 *
 * The other half of that sentence was missing for as long as this file has
 * existed. `onAgentEnd` awaited `transport.report` and its `catch` logged one
 * warning, so an outcome the control plane did not accept was gone: held in a
 * local variable that went out of scope, with the row then swept to
 * `abandoned` / `deadline_exceeded` by a reaper whose detail says no agent
 * ever claimed it. Every rollout on one OPSD queue came back that way.
 *
 * `outbox.js` is the fix and its header is the long version. What this file
 * owes it is two seams, both named here so a third lane cannot be written
 * without them:
 *
 *   PRODUCER  `onAgentEnd` delivers through `spool.deliver`, which writes the
 *             outcome to disk BEFORE the first network call.
 *   CONSUMER  `claim` drains the outbox before every claim, in BOTH lanes --
 *             which is why `unattended.js` has no transport of its own.
 */
import { ConfigurationError, LeaseLost } from "./errors.js";
import { isLowerSha256 } from "./execution-identity.js";
import { conversationAccessGranted, lastAssistantText } from "./host.js";
import { SDK_UA } from "./http.js";
import { createModelCallCounter } from "./model-calls.js";
import { createOutbox, outboxDir } from "./outbox.js";
import { createUnattendedRunner, cronTurnStarter } from "./unattended.js";
import { CONTRACT_VERSION } from "./wire.js";

export const SESSION_START = "session_start";
export const SESSION_END = "session_end";
export const AGENT_END = "agent_end";
export const BEFORE_AGENT_RUN = "before_agent_run";
export const BEFORE_TOOL_CALL = "before_tool_call";
export const GATEWAY_START = "gateway_start";
export const GATEWAY_STOP = "gateway_stop";

/** The host's own ceilings, so an oversized task is refused, not dropped. */
export const MAX_INJECTION_BYTES = 32 * 1024;

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
        `mode is '${config?.mode}', so this install claims no rollouts. ` +
        `Set PERCEPTEYE_AGENT_MODE=training to contribute.`,
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
export function createRolloutDriver({
  transport, enqueue, cancel = null, logger = null, executionIdentity = null,
  modelCalls = createModelCallCounter(),
  heartbeatScheduler = (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  heartbeatCanceller = (timer) => clearTimeout(timer),
  now = () => Date.now(),
  env = process.env,
  outbox = null,
}) {
  if (!transport) throw new ConfigurationError("a transport is required");
  if (typeof enqueue !== "function") {
    throw new ConfigurationError("an enqueue function is required");
  }
  if (cancel !== null && typeof cancel !== "function") {
    throw new ConfigurationError("cancel must be a function when supplied");
  }

  /**
   * Durable delivery, always on.
   *
   * NOT OPTIONAL and not behind a setting. A result held only in a local
   * variable is the whole incident this lane was rewritten for, and a
   * capability that ships dormant is a capability nobody gets. The directory
   * is resolved from `env` for the same reason `capture.js` resolves its root
   * that way: one answer to "where does this package write", honouring
   * PERCEPTEYE_HOME, with no second environment flag.
   */
  const spool = outbox ?? createOutbox({
    dir: outboxDir(transport?.agentId, env),
    // The ONE way a result leaves this SDK, on the first attempt and on every
    // redelivery alike.
    send: (rollout, output) => transport.report(rollout, output),
    logger,
    now,
  });

  /** sessionKey -> the rollout this session is running. */
  const inFlight = new Map();
  /** sessionKey -> fixed-cadence lease renewal for its current rollout. */
  const heartbeats = new Map();
  /** sessionKey -> host run id (or null), once the injected turn starts. */
  const activeRuns = new Map();
  /**
   * sessionKey -> rollout whose terminal result request is in progress.
   *
   * A heartbeat is deliberately kept alive through that request. The result
   * may close the lease just before an overlapping heartbeat reaches the
   * server, in which case that heartbeat's 410 is completion, not revocation.
   * Keeping this state separate prevents the completed turn from fencing the
   * next unrelated run in the same session.
   */
  const reporting = new Map();
  /**
   * A lease lost before model submission. `agent_turn_prepare` drains the
   * exactly-once injection before `before_agent_run`, so blocking that one run
   * both prevents stale work and consumes the now-invalid injection.
   */
  const blockNextRun = new Set();
  /** sessionKey -> revoked host run id (or null when the host omitted it). */
  const revokedRuns = new Map();
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
  let warnedMissingModelCallCount = false;

  function stopHeartbeat(sessionKey) {
    const state = heartbeats.get(sessionKey);
    if (!state) return;
    state.stopped = true;
    if (state.timer !== null) heartbeatCanceller(state.timer);
    heartbeats.delete(sessionKey);
  }

  function heartbeatIntervalFor(rollout) {
    // leaseExpiresTs is the absolute expiry the server actually granted.
    // Measure the duration ONCE: recomputing against a shrinking absolute
    // timestamp makes the interval collapse toward one second forever.
    const grantedMs = Number.isFinite(rollout?.leaseExpiresTs)
      ? rollout.leaseExpiresTs * 1000 - now()
      : null;
    const requestedMs = Number(transport?.leaseMs);
    const leaseMs = grantedMs !== null && grantedMs > 0
      ? grantedMs
      : (Number.isFinite(requestedMs) && requestedMs > 0
        ? requestedMs : 1_800_000);
    // The server accepts at most a ten-minute extension. A 30-minute initial
    // grant therefore cannot pace at 30m/3: that would schedule the next beat
    // exactly when the renewed 10-minute lease expires. Pace against the
    // smaller of the granted/requested duration and the renewal ceiling.
    return Math.max(1_000, Math.min(leaseMs, 600_000) / 3);
  }

  function startHeartbeat(sessionKey, rollout) {
    stopHeartbeat(sessionKey);
    if (!rollout?.leaseToken || typeof transport?.heartbeat !== "function") return;
    const state = {
      rollout,
      intervalMs: heartbeatIntervalFor(rollout),
      stopped: false,
      timer: null,
    };
    heartbeats.set(sessionKey, state);
    // A logger belongs to the host, and a host whose logger throws must not be
    // able to stop a lease being renewed. Every diagnostic below goes through
    // this rather than calling `logger` directly.
    const note = (message) => {
      try { logger?.warn?.(message); } catch { /* telemetry, not the lease */ }
    };
    const schedule = () => {
      if (state.stopped) return;
      try {
        state.timer = heartbeatScheduler(beat, state.intervalMs);
      } catch (err) {
        // The scheduler is injectable and on a real host it is the host's own
        // timer. If it refuses, this lease stops being renewed -- which is the
        // one outcome that has to be SAID rather than discovered from a
        // requeued rollout twenty minutes later.
        state.stopped = true;
        heartbeats.delete(sessionKey);
        note(
          `[agent-flywheel] rollout ${rollout.rolloutId}'s lease can no longer ` +
          `be renewed because its heartbeat could not be scheduled ` +
          `(${err?.message ?? err}); the control plane will requeue it when ` +
          `the lease lapses.`,
        );
      }
    };
    /** The lease is gone. Returns nothing; sets `state.stopped`. */
    const onLeaseLost = async () => {
      state.stopped = true;
      heartbeats.delete(sessionKey);
      if (reporting.get(sessionKey) === rollout) {
        // The terminal result request races this heartbeat. It owns the
        // authoritative outcome now; a 410 here can simply mean that the
        // result landed first and closed the lease. The agent run is
        // already over, so there is nothing to cancel or fence.
        return;
      }
      if (inFlight.get(sessionKey) === rollout) inFlight.delete(sessionKey);
      try { modelCalls?.abandon?.(sessionKey); } catch { /* evidence cleanup */ }
      const runStarted = activeRuns.has(sessionKey);
      const runId = activeRuns.get(sessionKey) ?? undefined;
      activeRuns.delete(sessionKey);
      if (!runStarted) blockNextRun.add(sessionKey);
      else revokedRuns.set(sessionKey, runId ?? null);
      let cancelled = false;
      if (cancel) {
        try {
          cancelled = await cancel({ sessionKey, runId, rollout }) === true;
          if (!cancelled && runStarted) {
            note(
              `[agent-flywheel] lease lost for rollout ${rollout.rolloutId}, ` +
              `but the host did not confirm that its active run stopped.`,
            );
          }
        } catch (cancelErr) {
          note(
            `[agent-flywheel] lease lost for rollout ${rollout.rolloutId}, and ` +
            `the host could not stop its run: ${cancelErr?.message ?? cancelErr}`,
          );
        }
      } else if (runStarted) {
        note(
          `[agent-flywheel] lease lost for rollout ${rollout.rolloutId}; this ` +
          `host exposes no active-run cancellation seam, so every later ` +
          `tool call from the revoked run will be blocked.`,
        );
      }
      note(
        `[agent-flywheel] lease lost for rollout ${rollout.rolloutId}; its ` +
        `${cancelled ? "host run was cancelled and " : ""}result will not ` +
        `be reported because the control plane requeued it.`,
      );
    };
    /**
     * One renewal. STRUCTURALLY INCAPABLE OF ENDING THE RENEWAL CHAIN, and
     * that is the whole reason it is shaped this way.
     *
     * This used to reschedule only on the two paths it recognised -- a clean
     * beat and a non-LeaseLost transport error. Anything else thrown anywhere
     * in here (a host logger that raises, a customer transport that rejects
     * with something exotic, a cancel seam that throws twice) escaped as a
     * rejected promise from a `setTimeout` callback: the lease stopped being
     * renewed with nothing logged, the control plane's reaper wrote
     * `abandoned` / `deadline_exceeded` over the rollout that was still
     * running, and no report was ever accepted. That is the original incident,
     * reproduced from one unexpected exception type. Worse here than in the
     * Python SDK, in fact: an unhandled rejection is fatal to the whole
     * process under Node's default policy, so it can take the customer's
     * gateway down rather than one lease.
     *
     * So: a beat that fails is treated exactly like a transient failure --
     * the next beat is already due, and a beat that raises is not evidence the
     * lease is gone. Only a LeaseLost stops the chain.
     */
    const beat = async () => {
      if (state.stopped) return;
      state.timer = null;
      try {
        await transport.heartbeat(rollout);
      } catch (err) {
        try {
          if (err instanceof LeaseLost || err?.name === "LeaseLost") {
            await onLeaseLost();
          } else {
            note(
              `[agent-flywheel] could not renew rollout ${rollout.rolloutId}; the ` +
              `next scheduled heartbeat will retry: ${err?.message ?? err}`,
            );
          }
        } catch (guardErr) {
          // NAMES WHICH OF THE TWO ACTUALLY HAPPENED. A lease-loss handler
          // that fails partway has already stopped the chain, and telling an
          // operator "still being renewed" in that case is one wrong cause for
          // two opposite states.
          note(
            `[agent-flywheel] rollout ${rollout.rolloutId}'s heartbeat failure ` +
            `handler itself failed (${guardErr?.message ?? guardErr}); renewal ` +
            `${state.stopped ? "has stopped" : "continues"}.`,
          );
        }
      }
      schedule();
    };
    schedule();
  }

  /**
   * Give the work back, typed, and stop tracking it.
   *
   * ALWAYS TYPED. An abandon is "do not train on this" -- a substrate fault --
   * not a low score. Reporting an undeliverable rollout as a zero-reward one
   * would teach the policy that its own behaviour caused an outcome it never
   * participated in.
   */
  async function giveBack(sessionKey, rollout, reason, detail) {
    stopHeartbeat(sessionKey);
    inFlight.delete(sessionKey);
    try {
      modelCalls?.abandon?.(sessionKey);
    } catch {
      /* measurement cleanup must not keep a lease from being returned */
    }
    try {
      await transport.abandon(rollout, { reason, detail });
    } catch (err) {
      logger?.warn?.(
        `[agent-flywheel] could not abandon rollout ${rollout.rolloutId}; its ` +
        `lease will lapse on its own: ${err?.message ?? err}`,
      );
    }
  }

  /** Record a rollout as running in `sessionKey`, so `onAgentEnd` reports it. */
  function track(sessionKey, rollout) {
    inFlight.set(sessionKey, rollout);
    startHeartbeat(sessionKey, rollout);
    try {
      modelCalls?.begin?.(sessionKey);
    } catch {
      /* the result will be reported without an attested count */
    }
  }

  /** Generic adapter seam: one host-proven provider invocation began. */
  function onModelCallStarted(event, ctx = {}) {
    try {
      return modelCalls?.observeStarted?.(event, ctx) === true;
    } catch {
      return false;
    }
  }

  /** Generic adapter seam: the same host-proven provider invocation ended. */
  function onModelCallEnded(event, ctx = {}) {
    try {
      return modelCalls?.observeEnded?.(event, ctx) === true;
    } catch {
      return false;
    }
  }

  /**
   * Bind the host's active run to its lease, and stop a queued turn whose
   * lease was revoked before it reached model submission.
   */
  function onBeforeAgentRun(_event, ctx = {}) {
    const sessionKey = ctx?.sessionKey ?? ctx?.sessionId;
    if (!sessionKey) return undefined;
    if (blockNextRun.delete(sessionKey) || revokedRuns.has(sessionKey)) {
      return {
        outcome: "block",
        reason: "the PerceptEye rollout lease was lost before this run started",
        message: "This training rollout expired before it started. Please retry.",
        category: "percepteye_lease_lost",
      };
    }
    if (inFlight.has(sessionKey)) {
      const runId = ctx?.runId;
      activeRuns.set(
        sessionKey,
        typeof runId === "string" && runId ? runId : null,
      );
    }
    return undefined;
  }

  /**
   * OpenClaw does not expose a background active-run abort to ordinary
   * plugins. Once a lease is revoked, fence all subsequent tool side effects
   * from that run even when the model loop takes time to unwind.
   */
  function onBeforeToolCall(event, ctx = {}) {
    const sessionKey = ctx?.sessionKey ?? ctx?.sessionId;
    if (!sessionKey || !revokedRuns.has(sessionKey)) return undefined;
    const revokedRunId = revokedRuns.get(sessionKey);
    const observedRunId = event?.runId ?? ctx?.runId;
    if (
      revokedRunId && typeof observedRunId === "string" && observedRunId
      && observedRunId !== revokedRunId
    ) return undefined;
    return {
      block: true,
      blockReason:
        "PerceptEye rollout lease was revoked; post-revocation side effects are blocked",
    };
  }

  async function onSessionStart(event) {
    const sessionKey = event?.sessionKey ?? event?.sessionId;
    if (
      !sessionKey || blockNextRun.has(sessionKey)
      || inFlight.has(sessionKey) || claiming.has(sessionKey)
    ) {
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

  /**
   * THE ONE CLAIM SEAM. Both lanes reach the control plane through this.
   *
   * DRAIN BEFORE CLAIM, because a result already produced is worth more than
   * the next rollout: the work is done, the agent's time is spent, and the
   * only thing standing between it and a graded row is one POST. Claiming more
   * work while a finished result sits on disk is how an outage becomes a
   * backlog.
   *
   * This is where it lives rather than in each caller because there were two
   * callers and a third would have been written without it. `unattended.js`
   * used to hold its own `transport.claim`; it calls this now, so "every claim
   * drains first" is a property of the code rather than of remembering.
   */
  async function claim(maxRollouts = 1) {
    try {
      await spool.drain();
    } catch (err) {
      // NAMED AS ITSELF. Folding this into the claim failure below would tell
      // an operator the control plane was unreachable when what failed was the
      // local outbox, which is a different thing to go and look at.
      logger?.warn?.(
        `[agent-flywheel] the outbox drain failed (${err?.message ?? err}); ` +
        `held results stay on disk and are retried before the next claim.`,
      );
    }
    return transport.claim(maxRollouts);
  }

  async function claimAndDeliver(sessionKey) {
    let claimed;
    try {
      claimed = await claim(1);
    } catch (err) {
      // A control plane that cannot be reached must never break the agent.
      // No rollout is delivered and the session runs as an ordinary one.
      logger?.warn?.(
        `[agent-flywheel] could not claim a rollout: ${err?.message ?? err}`,
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

    track(sessionKey, rollout);

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
        "plugins.entries.agent-flywheel.hooks.allowPromptInjection)",
      );
      return null;
    }

    logger?.info?.(
      `[agent-flywheel] rollout ${rollout.rolloutId} delivered to session ` +
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
    if (sessionKey && rollout) reporting.set(sessionKey, rollout);
    if (sessionKey) {
      activeRuns.delete(sessionKey);
      revokedRuns.delete(sessionKey);
    }
    if (!rollout) return null;
    inFlight.delete(sessionKey);

    if (event?.success === false) {
      // The agent RAN and failed. That is a real attempt and exactly what
      // training must see, so it is REPORTED, not abandoned -- the two are
      // opposite handling and sharing one label is how a real failure gets
      // triaged as a substrate fault.
      logger?.info?.(
        `[agent-flywheel] rollout ${rollout.rolloutId} ran and failed; reporting it.`,
      );
    }

    const finalText = lastAssistantText(event?.messages);
    let modelCallMeasurement;
    try {
      modelCallMeasurement = modelCalls?.finish?.(sessionKey, event, ctx);
    } catch (err) {
      modelCallMeasurement = {
        count: null,
        reason: `the model-call observer failed: ${err?.message ?? err}`,
      };
    }
    modelCallMeasurement ??= {
      count: null,
      reason: "no independent model-call observer was configured",
    };
    if (
      modelCallMeasurement.count !== null
      && (!Number.isInteger(modelCallMeasurement.count)
        || modelCallMeasurement.count < 0)
    ) {
      modelCallMeasurement = {
        count: null,
        reason: "the model-call observer returned an invalid count",
      };
    }
    if (modelCallMeasurement.count === null && !warnedMissingModelCallCount) {
      warnedMissingModelCallCount = true;
      logger?.warn?.(
        `[agent-flywheel] rollout ${rollout.rolloutId} has no exact, independently ` +
        `observed model-call count (${modelCallMeasurement.reason}); it will be ` +
        `reported without llm_call_count and is ineligible for verified ` +
        `on-policy training.`,
      );
    }
    try {
      // SPOOLED BEFORE IT IS SENT, and never merely awaited. `deliver` writes
      // the outcome to the outbox before the first network call and settles
      // the file on the answer, so a control plane that is down, a key without
      // the report scope, and a process killed mid-POST all end with the
      // result on disk and an operator told where -- instead of one warning
      // and a rollout the reaper marks `abandoned` twenty minutes later. It
      // does not throw: the failure IS the return value.
      const delivered = await spool.deliver(rollout, {
        finalText,
        // `undefined`, never `[]`. The recorder owns tool calls and writes
        // them to the trajectory; asserting zero here would overwrite what it
        // observed with a claim this function cannot make.
        success: event?.success === true ? true : undefined,
        // Counted from the host's provider-call lifecycle and reconciled by
        // run/call ids. Never copied from the control plane's gateway.
        llmCallCount: modelCallMeasurement.count ?? undefined,
        // SDK-reconciled execution identity only. The tracker returns null on
        // absent/incomplete adapter evidence or a mixed run, and this lane
        // never manufactures policy identity from the current serving config.
        agentFingerprint: (
          executionIdentity?.consumeFingerprintFor?.(event, ctx)
          ?? executionIdentity?.fingerprintFor?.(event, ctx)
          ?? undefined
        ),
      });
      // `null` still means "the control plane does not have this yet", which
      // is what every caller already reads it as. What changed is that it no
      // longer means the outcome is gone.
      return delivered ? rollout : null;
    } finally {
      // Keep renewing through the result POST itself; stop only once it has
      // either landed or failed, not merely when the agent produced an answer.
      if (reporting.get(sessionKey) === rollout) reporting.delete(sessionKey);
      stopHeartbeat(sessionKey);
    }
  }

  /**
   * The session ended with a rollout still in flight, so no answer ever
   * arrived. Give it back rather than reporting an empty result: a report with
   * no final text is a report about nothing, and it would count as a completed
   * rollout.
   *
   * `entrypoint_error`, NOT `cancelled`, and the difference is the whole
   * point of giving it back. `cancelled` is the ONE reason Mission Control
   * never requeues -- `RolloutRepository.abandon` computes
   * `requeue = attempt < max_attempts and reason != "cancelled"` -- so it
   * retires the rollout with its remaining attempts unused. Nothing in this
   * lane is an operator cancelling anything: the ordinary case is a session
   * opened and closed before a second turn, and the task never ran. That is
   * exactly `entrypoint_error` ("the agent could not be STARTED -- nothing
   * ran, so there is nothing to learn from and the work is worth handing
   * back"), which is what the other give-back sites above already use.
   */
  async function onSessionEnd(event) {
    const sessionKey = event?.sessionKey ?? event?.sessionId;
    const rollout = sessionKey ? inFlight.get(sessionKey) : null;
    if (sessionKey) {
      activeRuns.delete(sessionKey);
      blockNextRun.delete(sessionKey);
      revokedRuns.delete(sessionKey);
    }
    if (!rollout) return null;
    await giveBack(
      sessionKey, rollout, "entrypoint_error",
      `the session ended (${event?.reason ?? "unknown"}) before the agent ` +
      `answered, so no trajectory was produced`,
    );
    return rollout;
  }

  // `track` and `giveBack` are what the UNATTENDED runner needs: it does its
  // own claiming and turn-starting, but reporting and typed abandon must stay
  // in one place, or an unattended rollout and an attended one would end two
  // different ways.
  return {
    onSessionStart, onAgentEnd, onSessionEnd, onBeforeAgentRun,
    onBeforeToolCall,
    onModelCallStarted, onModelCallEnded,
    inFlight, track, giveBack, heartbeats, activeRuns, blockNextRun,
    revokedRuns, reporting,
    // `claim` is what the UNATTENDED runner claims through -- not
    // `transport.claim` -- so the drain in front of it cannot be skipped by a
    // lane that forgot about it. `outbox` is exposed for diagnostics and for
    // the tests that pin durability.
    claim, outbox: spool,
  };
}

/**
 * Subscribe the driver. CALLED ONLY IN TRAINING MODE.
 *
 * Returns `null` when this install must not drive, having said why once. The
 * caller does not branch on mode -- `index.js` decides that -- so there is one
 * place where "may this install claim work" is answered.
 */
export function registerRolloutDriver(api, {
  config, transport, pluginId, logger = null, executionIdentity = null,
  // A PARAMETER, matching `resolveConfig` and `captureRoot` rather than
  // inventing a second convention: it is the one thing that decides where
  // undelivered results are held (PERCEPTEYE_HOME), and a read of the global
  // here would be untestable without mutating the process's environment.
  env = process.env,
}) {
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

  // Registration starts without blocking because OpenClaw requires plugin
  // registration itself to return synchronously. The first claim in either
  // lane awaits this one cached attempt, so no rollout can be leased before
  // compatibility was checked and the worker was authenticated and recorded.
  const registrationFingerprint = executionIdentity?.registrationFingerprint;
  const registrationDescription = executionIdentity?.registrationDescription;
  const registrationSpec = {
    agent_id: config.agentId,
    mode: "rollout",
    sdk: SDK_UA,
    contract_version: CONTRACT_VERSION,
    reports_tool_calls: true,
    isolation: "inprocess",
    concurrency: 1,
    input_shape: "text",
    entrypoint: "openclaw-plugin",
    // A startup observation is optional. When an adapter can provide one, the
    // same immutable exact evidence drives both discovery and the execution
    // digest registration sends before the first claim. Otherwise null says
    // discovery ran but was unreadable; it never invents a worker identity.
    discovered_agent: registrationDescription ?? null,
  };
  if (isLowerSha256(registrationFingerprint?.execution_sha256)) {
    registrationSpec.agent_execution_sha256 =
      registrationFingerprint.execution_sha256;
  }
  let registration = null;
  function ensureRegistered() {
    if (registration !== null) return registration;
    registration = (async () => {
      if (typeof transport?.health !== "function") {
        throw new ConfigurationError(
          "the rollout transport cannot check control-plane compatibility",
        );
      }
      const health = await transport.health();
      const served = health?.contract_versions_supported
        || [health?.contract_version];
      if (
        !Array.isArray(served)
        || !served.filter(Boolean).includes(CONTRACT_VERSION)
      ) {
        throw new ConfigurationError(
          `control plane speaks ${JSON.stringify(served)}, this SDK speaks ` +
          `${CONTRACT_VERSION}. Upgrade agent-flywheel.`,
        );
      }
      if (typeof transport?.register !== "function") {
        throw new ConfigurationError(
          "the rollout transport cannot register this worker",
        );
      }
      return transport.register(registrationSpec);
    })()
      .then(() => true)
      .catch((err) => {
        logger?.warn?.(
          `[${pluginId}] rollouts are disabled for this run because worker ` +
          `registration failed: ${err?.message ?? err}. Local capture is ` +
          `unaffected.`,
        );
        return false;
      });
    return registration;
  }

  // Start now, without awaiting: host registration remains synchronous, while
  // an incompatible or unreachable control plane is diagnosed at startup
  // instead of waiting for a person's first session to reveal it. Every claim
  // still awaits this exact cached promise.
  void ensureRegistered();

  // Both the attended hook and the unattended cron loop call this same claim
  // method. A failed registration looks like an empty queue locally; it never
  // reaches `/rollouts/claim`, and the warning above names the real cause once.
  const registeredTransport = {
    get leaseMs() { return transport.leaseMs; },
    // FORWARDED, because the outbox is keyed by agent: two installs sharing
    // one PERCEPTEYE_HOME would otherwise replay each other's held results.
    // A wrapper that silently dropped it would key every one of them "agent".
    get agentId() { return transport.agentId; },
    async claim(...args) {
      if (!(await ensureRegistered())) {
        return { rollouts: [], pollAfterMs: 5_000 };
      }
      return transport.claim(...args);
    },
    report: (...args) => transport.report(...args),
    abandon: (...args) => transport.abandon(...args),
    heartbeat: (...args) => transport.heartbeat(...args),
  };

  const driver = createRolloutDriver({
    transport: registeredTransport,
    enqueue: (injection) => enqueueFn.call(api.session?.workflow ?? api, injection),
    logger,
    executionIdentity,
    env,
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
  // This gate MUST return its decision. The observation-only wrapper above
  // deliberately fire-and-forgets, which would discard a block result and
  // let a revoked rollout reach the model anyway.
  api.on(BEFORE_AGENT_RUN, async (event, ctx) => {
    try {
      return await driver.onBeforeAgentRun(event, ctx);
    } catch (err) {
      logger?.warn?.(
        `[${pluginId}] rollout run gate failed: ${err?.message ?? err}`,
      );
      return undefined;
    }
  });
  // Like the run gate, this policy hook must return synchronously/through its
  // promise. It is registered only in training mode and becomes active only
  // after the control plane has revoked this exact rollout lease.
  api.on(BEFORE_TOOL_CALL, (event, ctx) => {
    try {
      return driver.onBeforeToolCall(event, ctx);
    } catch (err) {
      logger?.warn?.(
        `[${pluginId}] rollout tool fence failed: ${err?.message ?? err}`,
      );
      return {
        block: true,
        blockReason: "PerceptEye could not verify the active rollout lease",
      };
    }
  });

  // ── RUNNING THE ROLLOUTS THIS LANE CLAIMS ─────────────────────────────
  //
  // Not behind its own switch. `PERCEPTEYE_AGENT_MODE` already answers "does
  // this install drive?" -- training means it claims rollouts and runs them,
  // production means it does not -- and a second flag was a second answer to
  // that same question. The state it would have named, "claim rollouts but
  // wait for a human to start each turn", is a distinction with no customer
  // behind it: an operator who wants the agent left alone sets production.
  //
  // Reached only from training mode, because that is the only mode in which
  // this function is called at all. Note what is NOT done here: the hooks
  // above stay subscribed regardless, so if the cron seam is unavailable the
  // plugin keeps claiming and delivering through injection rather than losing
  // rollouts entirely. Starting turns is an ADDITION to that lane, not a
  // replacement for it -- which is what makes the degradation path safe.
  //
  // The other half of that path lives in the runner: on a degraded start it
  // STOPS POLLING, so the injection lane is left as the only claimer instead
  // of competing with a loop that claims and hands back every 30 seconds.
  // `capture` below is what can re-arm it, and only because both hooks it is
  // bound to mean the host has just handed over a cron context.
  let unattended = null;
  {
    // `getCron` lives on the gateway hook CONTEXT and nowhere else, so it has
    // to be captured when the hook fires and resolved lazily afterwards -- the
    // service may not be up at `gateway_start`, which is why this stores the
    // context rather than the service. `cron_changed` carries the same
    // context and is captured too, so a cron that arrives later is still
    // reachable.
    let gatewayCtx = null;
    unattended = createUnattendedRunner({
      // No transport of its own: it claims through `driver.claim`, which is
      // both the registration gate and the outbox drain. See `claim` above.
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
      `[${pluginId}] training mode: this plugin claims rollouts and runs them, ` +
      `starting its own turns in dedicated 'percepteye-rollout-*' sessions, ` +
      `one at a time. Set PERCEPTEYE_AGENT_MODE=production to stop.`,
    );
  }

  driver.unattended = unattended;
  // Exposed for diagnostics and focused tests; invoking it performs the same
  // single cached registration the first claim would perform.
  driver.ensureRegistered = ensureRegistered;
  return driver;
}

// Re-exported for the tests that pin these behaviours against this lane.
export { conversationAccessGranted, lastAssistantText };
