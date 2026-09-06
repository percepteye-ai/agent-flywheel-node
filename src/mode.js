/**
 * WHICH MODE THIS PROCESS IS IN, and what that permits.
 *
 * TWO GATES, AND THEY ARE NOT THE SAME GATE. Conflating them is how a package
 * ends up either uploading somebody's end users' messages without consent, or
 * refusing to do the training work it was installed for.
 *
 *   MODE           -- a CLIENT-side deployment switch, `PERCEPTEYE_AGENT_MODE`.
 *                     `training` means this install does training work: it
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
 * WHAT PRODUCTION MODE PROMISES, precisely. This was once "OBSERVE-ONLY,
 * absolutely", which was already a promise this package could not keep once it
 * grew a rollout driver, and stopped being true a second time when production
 * mode began applying the control plane's approved system prompt. An untrue
 * promise about somebody's agent is worse than a narrower true one, so here is
 * the narrow one, which holds:
 *
 *   production mode -- CLAIMS NO WORK AND STARTS NO TURN. It does not claim a
 *                      rollout, does not start or schedule a turn, does not
 *                      queue an injection, and does not alter a tool result.
 *                      The rollout hooks are NOT REGISTERED, so that much is
 *                      the absence of a subscription rather than a branch
 *                      inside a handler that a later edit could invert.
 *                      It DOES capture the turns the agent serves, and it DOES
 *                      apply what the control plane has approved -- replacing
 *                      the agent's system prompt, and pointing it at the model
 *                      that prompt was certified with. That is the last mile
 *                      of the loop, off with PERCEPTEYE_APPLY_PROMPT=0 and
 *                      PERCEPTEYE_APPLY_MODEL=0 respectively. See `policy.js`;
 *                      those are deliberate changes to what the agent does and
 *                      the only things in this mode that are not observation.
 *                      Both are scoped to THIS agent's own served turns --
 *                      never a subagent's, never a cron turn's, never another
 *                      agent's in the same process (`scope.js`).
 *   training mode   -- the plugin drives: it claims a rollout, starts a turn
 *                      carrying the task, and contributes the trajectory. It
 *                      applies NEITHER half: a rollout is evidence about the
 *                      agent as configured, and changing its prompt or its
 *                      model under one moves the behaviour with no weight
 *                      change behind it.
 *
 * That distinction is structural on purpose. `registerRolloutDriver` is called
 * from ONE place, under one predicate, and in production mode it is never
 * reached -- and `registerServingPolicy` is called from the other branch of
 * that same predicate, so neither can leak into the other's mode. As against a
 * `if (mode === "training")` inside each handler, where a missed call site is a
 * silent breach of the promise rather than a hook that is simply not there.
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
      `(this process does training work: it claims rollouts and runs them) ` +
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

// THE SECOND GATE LIVES IN `capture.js`.
//
// Uploading a captured PRODUCTION turn needs a second yes, separate from mode:
// Mission Control's per-agent `production_capture_enabled`, which is opt-in
// (NULL is not consent) because a production turn carries the customer's END
// USERS' messages. It arrives as `capture: {turns, reason}` on the
// registration response, precisely so a client never learns its permission BY
// uploading, and `capture.js:captureVerdict` is the only thing that reads it.
//
// It was written HERE first and removed before commit, because nothing then
// uploaded turns and a predicate with no consumer is the shape this codebase
// keeps finding. It came back with its consumer, in the module that owns the
// question -- not here, where it would have been a second place to look.
