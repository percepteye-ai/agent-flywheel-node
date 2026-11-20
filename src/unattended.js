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
 *      the plugin says so once, STOPS POLLING, and leaves the `session_start`
 *      injection lane as the only claimer. A capability that disappears must
 *      not take rollouts down with it.
 *
 *      STOPPING IS THE WHOLE OF THE DEGRADATION, and the first version of it
 *      left that part out: it announced the fallback, handed the rollout
 *      back, and then polled again `pollMs` later, forever. Mission Control's
 *      `claim` increments `attempt`, and its `abandon` requeues only while
 *      `attempt < max_attempts` -- so a runner that claims and hands back
 *      every 30 seconds walks the whole org's queue to ABANDONED at three
 *      attempts each, having run none of it, while reporting itself as having
 *      fallen back. A seam that is gone must make this lane QUIET, not busy.
 *
 *      `start()` (gateway_start) and `resume()` (cron_changed) are the only
 *      things that undo it, because both events mean the host has just
 *      handed over a cron context. That keeps a LATER-ARRIVING cron usable
 *      (see `cronTurnStarter` below) without reopening the churn: a host with
 *      no cron service emits neither event, so nothing restarts the loop.
 *
 * ── ONE ROLLOUT AT A TIME, IN ITS OWN SESSION ─────────────────────────────
 *
 * Each rollout runs under `percepteye-rollout-<id>`, never a session a person
 * is using. Commandeering a human's session to run training work would be
 * indefensible, and an isolated session is also what makes `agent_end`
 * attributable: the key the turn runs under is the key the report is looked up
 * by.
 *
 * Serial by construction, and ACROSS BOTH LANES: the runner claims only
 * through the driver's one concurrency gate (`driver.reserve`), which the
 * attended `session_start` lane takes too and which admits as many rollouts
 * as registration declared (`concurrency: 1`). Each lane used to check only
 * its own work, so an injected rollout and an unattended one could be held
 * at once by a worker registered to run one.
 *
 * ── STOPPING ──────────────────────────────────────────────────────────────
 *
 * `stop()` (gateway_stop) is final until the next `start()` (gateway_start):
 * a `cron_changed` after it does not restart the poller, a tick in flight
 * when it lands hands back what it claimed rather than starting it, and no
 * timer is left behind. The poller paces itself by the control plane's
 * `pollAfterMs` when it gives one, by `pollMs` otherwise.
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
 *
 * AND CLAIMING TOO, now. This used to hold its own `transport` and call
 * `transport.claim` directly, which made it the second of two claim sites --
 * and the drain that has to run in front of a claim (a finished result is
 * worth more than the next rollout) would then have had to be remembered in
 * both. `driver.claim` is the one seam; there is no transport here to walk
 * around it with.
 */
export function createUnattendedRunner({
  driver, startTurn, logger = null, pollMs = DEFAULT_POLL_MS,
}) {
  let timer = null;
  /** Whether the poller is armed: what `polling` reports. */
  let armed = false;
  let running = false;
  /** gateway_stop happened, and no gateway_start since. */
  let stopped = false;
  /** The control plane's `pollAfterMs` from the last claim, if it gave one. */
  let pollAfterMs = null;
  /** A host logger that throws must not reject a timer callback. */
  const warn = (message) => { try { logger?.warn?.(message); } catch { /* telemetry */ } };
  const info = (message) => { try { logger?.info?.(message); } catch { /* telemetry */ } };
  /**
   * The turn-starting seam is gone, so this lane claims nothing.
   *
   * ONE FLAG, NOT TWO. It used to be `degradedAnnounced`, gating only the
   * warning, which meant the loop went on claiming and handing back -- see the
   * header. "Have we said it" and "should we still claim" are the same
   * question here: the announcement IS the fallback taking effect.
   */
  let degraded = false;

  function stopTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
    armed = false;
  }

  /** Arm the next wake-up: `pollAfterMs` when the control plane gave one. */
  function schedule() {
    if (!armed || stopped || degraded) return;
    const delay = Number.isFinite(pollAfterMs) && pollAfterMs > 0 ? pollAfterMs : pollMs;
    timer = setTimeout(() => {
      timer = null;
      tick().catch(() => {}).finally(schedule);
    }, delay);
    // Never hold a customer's gateway open on our account.
    timer.unref?.();
  }

  async function tick() {
    // Never claim once the seam is known dead: a claim we cannot start still
    // costs the rollout an attempt, and three of those retire it unrun.
    // Checked HERE rather than in `start()` alone, so a directly driven tick
    // cannot walk around it either. Nor once the gateway has stopped.
    if (stopped || degraded || running) return null;
    // THE ONE CONCURRENCY GATE, shared with the attended lane.
    if (!driver.reserve()) return null;
    running = true;
    try {
      let claimed;
      try {
        claimed = await driver.claim(1);
      } catch (err) {
        warn(`[agent-flywheel] could not claim a rollout: ${err?.message ?? err}`);
        return null;
      }
      const hint = Number(claimed?.pollAfterMs);
      pollAfterMs = Number.isFinite(hint) && hint > 0 ? hint : null;
      const rollout = claimed?.rollouts?.[0];
      if (!rollout) return null;

      const sessionKey = sessionKeyFor(rollout.rolloutId);
      if (stopped) {
        // The gateway stopped during the claim: nothing will run it here.
        await driver.giveBack(
          sessionKey, rollout, "entrypoint_error",
          "the gateway stopped while the rollout was being claimed");
        return null;
      }
      driver.track(sessionKey, rollout);

      let result;
      try {
        result = await startTurn({
          sessionKey, rolloutId: rollout.rolloutId, message: taskText(rollout),
        });
      } catch (err) {
        // A starter that throws instead of answering: the turn did not start,
        // and the rollout must not stay tracked with a heartbeat renewing a
        // lease nothing will ever report.
        result = {
          started: false, degraded: false,
          reason: `starting the rollout's turn failed: ${err?.message ?? err}`,
        };
      }
      if (result?.started) {
        info(
          `[agent-flywheel] rollout ${rollout.rolloutId} started unattended in ` +
          `session ${sessionKey}.`);
        return rollout;
      }

      // The turn will never run, so the work goes back NOW rather than sitting
      // until its lease lapses.
      await driver.giveBack(
        sessionKey, rollout, "entrypoint_error", result?.reason ?? "no turn started");
      if (result?.degraded) {
        degraded = true;
        // The fallback, actually taken: stop looking for work. Anything else
        // spends one rollout's attempt per poll on a turn that cannot start.
        stopTimer();
        warn(
          `[agent-flywheel] unattended rollouts are configured but ${result.reason}. ` +
          `Falling back to the default lane: this plugin has stopped polling ` +
          `for rollouts and tasks are delivered into the next turn you start. ` +
          `Nothing else changes.`);
      }
      return null;
    } finally {
      running = false;
      driver.release();
    }
  }

  return {
    tick,
    /**
     * Is this lane still looking for work?
     *
     * The observable half of the degradation. `tick`'s own guard is what stops
     * the claiming, and a test that only counts claims passes just as happily
     * with `stopTimer()` deleted -- leaving a poll interval waking every 30
     * seconds forever to return immediately, in a customer's gateway, in a
     * lane the operator was told had gone quiet.
     */
    get polling() { return armed; },
    /**
     * `gateway_start`: the host has just handed over a cron context -- the
     * one event that can undo a degradation, and that ends a stop.
     */
    start() {
      stopped = false;
      degraded = false;
      if (armed) return;
      armed = true;
      schedule();
    },
    /**
     * `cron_changed`: a cron context too, so it undoes a degradation and
     * arms the poller -- but NOT after `gateway_stop`, which only the next
     * `gateway_start` ends. It used to restart the loop in a stopping
     * gateway.
     */
    resume() {
      if (stopped) return;
      degraded = false;
      if (armed) return;
      armed = true;
      schedule();
    },
    /** `gateway_stop`: no more claims, no timer left behind. */
    stop() {
      stopped = true;
      stopTimer();
    },
  };
}
