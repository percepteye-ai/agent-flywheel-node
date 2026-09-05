/**
 * WHICH MODE THIS PROCESS IS IN, and what that permits.
 *
 * TWO GATES, AND THEY ARE NOT THE SAME GATE. Conflating them is how a package
 * ends up either uploading somebody's end users' messages without consent, or
 * refusing to do the training work it was installed for.
 *
 *   MODE           -- a CLIENT-side deployment switch, `PERCEPTEYE_AGENT_MODE`.
 *                     `training` means this install contributes capacity: it
 *                     claims rollouts, hands them to the agent, and reports
 *                     what happened. `production` means it does not.
 *
 *   CAPTURE CONSENT -- a SERVER-side, per-agent decision, echoed to us at
 *                     registration as `capture: {turns, reason}` and backed by
 *                     `FlywheelAgent.production_capture_enabled`. It governs
 *                     whether captured PRODUCTION turns may be uploaded.
 *
 * A customer in training mode has consented to nothing about their end users;
 * a customer with capture consent has not thereby volunteered to run rollouts.
 * So each question is asked separately and neither answer is derived from the
 * other.
 *
 * WHAT "OBSERVE-ONLY" MEANS NOW, precisely. It was previously stated flatly,
 * which was a promise this package could not keep once it grew a rollout
 * driver -- and an untrue promise about somebody's data is worse than a
 * narrower true one. Scoped, it is stronger, because it says WHEN it applies:
 *
 *   production mode -- OBSERVE-ONLY, absolutely. Nothing here starts a turn,
 *                      queues an injection, or alters a tool result. The
 *                      rollout hooks are NOT REGISTERED, so the guarantee is
 *                      the absence of a subscription rather than a branch
 *                      inside a handler that a later edit could invert.
 *   training mode   -- the plugin drives: it claims a rollout, starts a turn
 *                      carrying the task, and contributes the trajectory.
 *
 * That distinction is structural on purpose. `registerRolloutDriver` is called
 * from ONE place, under one predicate, and in production mode it is never
 * reached -- as against a `if (mode === "training")` inside each handler,
 * where a missed call site is a silent breach of the promise rather than a
 * hook that is simply not there.
 *
 * The vocabulary is the PYTHON SDK's, verbatim (`percepteye_agent_flywheel`'s
 * `_MODE_ALIASES`). A customer switching harnesses must not have to learn a
 * second spelling of the same switch -- they deploy one package or the other,
 * never both, and `PERCEPTEYE_AGENT_MODE=prod` has to mean the same thing in
 * whichever one they chose.
 */
import { ConfigurationError } from "./errors.js";

export const ENV_MODE = "PERCEPTEYE_AGENT_MODE";

export const TRAINING = "training";
export const PRODUCTION = "production";

/**
 * Every accepted spelling, mapped to the mode it means.
 *
 * A CLOSED SET, and that is the point. `rollout` is here because it is the
 * legacy value and its meaning never changed; `serving` because that is what
 * an ops team calls the same deployment. Anything NOT in this table is a
 * refusal, never a default -- see `ConfigurationError`.
 */
export const MODE_ALIASES = Object.freeze({
  training: TRAINING,
  train: TRAINING,
  rollout: TRAINING,        // the legacy value, unchanged in meaning
  rollouts: TRAINING,
  "fine-tuning": TRAINING,
  finetuning: TRAINING,
  improving: TRAINING,
  production: PRODUCTION,
  prod: PRODUCTION,
  serving: PRODUCTION,
});

function modeFrom(raw, source) {
  const key = String(raw).trim().toLowerCase();
  if (!Object.hasOwn(MODE_ALIASES, key)) {
    throw new ConfigurationError(
      `${source}${JSON.stringify(String(raw))} is not a mode. Use 'training' ` +
      `(this process contributes capacity: it claims rollouts and runs them) ` +
      `or 'production' (it does not). Recognised spellings: ` +
      `${Object.keys(MODE_ALIASES).sort().join(", ")}.`,
    );
  }
  return MODE_ALIASES[key];
}

/**
 * The mode, and which of `config`/`environment`/`default` decided it.
 *
 * An EMPTY explicit value falls through to the environment rather than being
 * honoured. `{mode: cfg.mode ?? ""}` is the ordinary way a config layer says
 * "not set", and treating that as a value pinned the process to `training`
 * without ever reading the environment -- so an operator who had flipped the
 * switch to stop contributing kept contributing, on their own credentials,
 * silently. Same reasoning as the Python SDK's `_resolve_mode_source`.
 */
export function resolveModeSource(explicit = null, env = process.env) {
  if (explicit !== null && explicit !== undefined && String(explicit).trim() !== "") {
    return { mode: modeFrom(explicit, "mode="), source: "config" };
  }
  const raw = env?.[ENV_MODE];
  if (raw !== null && raw !== undefined && String(raw).trim() !== "") {
    return { mode: modeFrom(raw, `${ENV_MODE}=`), source: "environment" };
  }
  return { mode: TRAINING, source: "default" };
}

/**
 * `"training"` or `"production"`. Throws `ConfigurationError` on a typo.
 *
 * Precedence is the plugin config, then `PERCEPTEYE_AGENT_MODE`, then
 * `training` -- the same order and the same default as Python's
 * `resolve_mode`, so one env var configures either package identically.
 */
export function resolveMode(explicit = null, env = process.env) {
  return resolveModeSource(explicit, env).mode;
}

// WHERE THE SECOND GATE WILL LIVE.
//
// Uploading a captured PRODUCTION turn needs a second yes, separate from mode:
// Mission Control's per-agent `production_capture_enabled`, which is opt-in
// (NULL is not consent) because a production turn carries the customer's END
// USERS' messages. The registration response carries it as
// `capture: {turns, reason}` precisely so a client never learns its permission
// BY uploading.
//
// A `captureVerdict(registration)` reader for it was written here and REMOVED
// before commit, because this package has no turn-upload path yet and nothing
// would have called it. Two things have to be true before it comes back, and
// both belong with the upload path rather than ahead of it:
//
//  1. A consumer -- the upload itself.
//  2. A way to ASK that is not a write. The only surface carrying the verdict
//     today is the registration response, and registering merely to read it
//     has a side effect: a registration with no `discovered_agent` is recorded
//     as introspection `disabled`, which is an INSTRUCTION ("the customer
//     turned it off") and stops that agent's description driving workflow
//     generation. Sending `discovered_agent: null` avoids the write but
//     asserts introspection failed, which would be untrue. The flywheel-key
//     routes need a read-only verdict for this.
