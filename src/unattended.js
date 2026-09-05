/**
 * UNATTENDED ROLLOUTS: the plugin starts the turn itself.
 *
 * WHAT TRAINING MODE DOES. There is no switch of its own here, and there were
 * two wrong answers before this one.
 *
 * First it was opt-in, on the argument that this reaches past a restriction
 * the host states for its own scheduling API. That treated "the plugin runs
 * the rollout" as something beyond what was asked for, and it is not:
 * `PERCEPTEYE_AGENT_MODE=training` already means "this install claims rollouts
 * and runs them", and in that mode the plugin already claims work and puts
 * tasks into the agent's context. Starting the turn is how that promise is
 * kept, so opt-in only meant the flywheel sat idle waiting to be enabled.
 *
 * Then it was default-on with its own kill switch, which was the same mistake
 * one step smaller: `PERCEPTEYE_AGENT_MODE` already answers "does this install
 * drive?", so a second flag was a second answer to a settled question. The one
 * state it could have named -- claim rollouts but wait for a human to start
 * each turn -- has no customer behind it. An operator who wants the agent left
 * alone sets `production`, and gets a stronger guarantee than a flag: this
 * module is never even reached.
 *
 * The real risk is handled below by DEGRADING, not by a switch: a flag never
 * made the host seam more stable, it only meant somebody had to know about it.
 *
 * ── WHAT IT REACHES PAST, AND WHY THAT IS SURVIVABLE ──────────────────────
 *
 * OpenClaw's documented API for starting a turn from a plugin,
 * `api.session.workflow.scheduleSessionTurn`, is restricted to plugins bundled
 * with the host: `schedulePluginSessionTurn` returns immediately for any other
 * origin (registry-B8eQDFB4.js:1186), silently.
 *
 * The capability underneath is not restricted. `gateway_start` and
 * `cron_changed` hand every plugin the raw host cron service as
 * `ctx.getCron()` (server-startup-post-attach-B3O9knW5.js:765,
 * server-cron-Cwg2hJro.js:4384); `registerTypedHook` gates conversation hooks
 * by origin and prompt-injection hooks by policy, and `gateway_start` is in
 * neither set; and `server-cron` carries no origin check at all. A job with
 * `payload.kind: "agentTurn"` reaches `runIsolatedAgentJob` (:2433) and
 * `runCronIsolatedAgentTurn` (:4484), which runs the agent. The job built
 * below is deliberately the same shape the bundled-only wrapper builds
 * (registry-B8eQDFB4.js:1240-1254).
 *
 * So this reaches past a restriction the host states explicitly, by way of a
 * service it hands out elsewhere. That may be an inconsistency rather than an
 * intention, which means it can be closed in a patch release. Two consequences
 * are designed in rather than discovered later:
 *
 *   1. It is confined to TRAINING mode, structurally. A process serving real
 *      users never reaches this module, whatever the setting says.
 *   2. It DEGRADES to the default lane instead of failing. If `getCron()`
 *      returns nothing -- the seam closed, or cron is simply unavailable --
 *      the plugin says so once and keeps claiming through injection. A
 *      capability that disappears must not take rollouts down with it.
 *
 * ── ONE ROLLOUT AT A TIME, IN ITS OWN SESSION ─────────────────────────────
 *
 * Each rollout runs under `percepteye-rollout-<id>`, never a session a person
 * is using. Commandeering a human's session to run training work would be
 * indefensible, and an isolated session is also what makes `agent_end`
 * attributable: the key the turn runs under is the key the report is looked up
 * by.
 *
 * Serial by construction -- the runner claims only when nothing is in flight.
 * A concurrency knob would be the second thing to get wrong here, and a
 * customer's gateway is not the place to discover that.
 */
import { taskText } from "./rollout.js";

export const JOB_PREFIX = "percepteye:rollout:";

/** How often to look for work when idle. */
export const DEFAULT_POLL_MS = 30_000;

/**
 * Turn the raw cron service into "start a turn", or say why it cannot.
 *
 * `getCron` is a FUNCTION, not a service, because the context that carries it
 * only exists during `gateway_start`/`cron_changed` and the service may not be
 * up yet at that moment -- the bundled memory-core plugin has the same problem
 * and defers the same way. Resolving it per call keeps a later-arriving cron
 * usable instead of caching an `undefined` forever.
 */
export function cronTurnStarter(getCron) {
  return async function startTurn({ sessionKey, message, rolloutId }) {
    const cron = typeof getCron === "function" ? getCron() : null;
    if (!cron || typeof cron.add !== "function") {
      return {
        started: false,
        degraded: true,
        reason:
          "the host cron service is unavailable to this plugin, so no turn " +
          "can be started",
      };
    }
    try {
      await cron.add({
        name: `${JOB_PREFIX}${rolloutId}`,
        // Idempotent per rollout: a retried claim of the same work cannot
        // queue a second turn for it.
        declarationKey: `${JOB_PREFIX}${rolloutId}`,
        enabled: true,
        // One-shot, effectively now. `at` is what the host's own wrapper uses
        // for a `delayMs`, clamped to at least 1ms.
        schedule: { kind: "at", at: new Date(Date.now() + 1).toISOString() },
        sessionTarget: `session:${sessionKey}`,
        payload: { kind: "agentTurn", message },
        deleteAfterRun: true,
        wakeMode: "now",
        // NOT "announce". Announcing would deliver the rollout's output into
        // whatever chat the customer last used, which is training work
        // appearing in a human's conversation.
        delivery: { mode: "none" },
      });
      return { started: true, degraded: false, reason: null };
    } catch (err) {
      return {
        started: false,
        // NOT degraded: cron answered and refused. Falling back to the
        // injection lane on a genuine rejection would hide a real error behind
        // a quieter mode.
        degraded: false,
        reason: `the host refused the rollout turn: ${err?.message ?? err}`,
      };
    }
  };
}

/** The session a rollout runs in. Never a session a person is using. */
export const sessionKeyFor = (rolloutId) => `percepteye-rollout-${rolloutId}`;

/**
 * Claim, start, and keep going -- one rollout at a time.
 *
 * `driver` is the same one the attended lane uses, so reporting and typed
 * abandon happen in exactly one place for both lanes.
 */
export function createUnattendedRunner({
  transport, driver, startTurn, logger = null, pollMs = DEFAULT_POLL_MS,
}) {
  let timer = null;
  let running = false;
  let degradedAnnounced = false;

  async function tick() {
    // Serial: never claim while a rollout is still running.
    if (running || driver.inFlight.size > 0) return null;
    running = true;
    try {
      let claimed;
      try {
        claimed = await transport.claim(1);
      } catch (err) {
        logger?.warn?.(
          `[percepteye] could not claim a rollout: ${err?.message ?? err}`);
        return null;
      }
      const rollout = claimed?.rollouts?.[0];
      if (!rollout) return null;

      const sessionKey = sessionKeyFor(rollout.rolloutId);
      driver.track(sessionKey, rollout);

      const result = await startTurn({
        sessionKey, rolloutId: rollout.rolloutId, message: taskText(rollout),
      });
      if (result.started) {
        logger?.info?.(
          `[percepteye] rollout ${rollout.rolloutId} started unattended in ` +
          `session ${sessionKey}.`);
        return rollout;
      }

      // The turn will never run, so the work goes back NOW rather than sitting
      // until its lease lapses.
      await driver.giveBack(
        sessionKey, rollout, "entrypoint_error", result.reason);
      if (result.degraded && !degradedAnnounced) {
        degradedAnnounced = true;
        logger?.warn?.(
          `[percepteye] unattended rollouts are configured but ${result.reason}. ` +
          `Falling back to the default lane: tasks are delivered into the next ` +
          `turn you start. Nothing else changes.`);
      }
      return null;
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => { tick().catch(() => {}); }, pollMs);
      // Never hold a customer's gateway open on our account.
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
