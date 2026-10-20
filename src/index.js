/**
 * agent-flywheel — an OpenClaw plugin that records tool-call outcomes.
 *
 * WHY THIS HOOK. OpenClaw exposes three places to see a tool result, and only
 * one of them is both complete and incapable of changing the run:
 *
 *   registerAgentToolResultMiddleware
 *     A waterfall. Its return value REPLACES the result the model reads --
 *     that is what the bundled output-compacting plugin uses it for. A bug
 *     here would silently rewrite a customer's agent output. It is also
 *     manifest-gated and refused unless the plugin is explicitly enabled.
 *     Rejected: a recorder must not sit on a mutation seam.
 *
 *   registerAgentEventSubscription (streams: ["tool"])
 *     A genuine observer -- the host `structuredClone`s the event and discards
 *     the return. But it is a UI/monitor stream: `data` is untyped, the
 *     arguments arrive on a separate `phase:"start"` event, and exec results
 *     are capped before dispatch. Correlating the two phases needs a pending
 *     map that either leaks or drops.
 *
 *   api.on("after_tool_call", ...)                            <-- what we use
 *     Also void-returning, so structurally incapable of altering, blocking or
 *     delaying anything; the host runs it best-effort inside its own
 *     try/catch. And it carries the whole call in one event: `params`,
 *     `result`, `error`, `durationMs`, `toolCallId`, plus agent and session
 *     identity on the context.
 *
 * The rule behind the choice: capturing evidence must never be able to change
 * the behaviour being measured. A collector that can corrupt the run it is
 * measuring is worse than no collector.
 *
 * Zero dependencies.
 *
 * WHAT THIS WRITES, PER MODE. This used to read "inert unless
 * PERCEPTEYE_TRAJECTORY_DIR is set, so one install is a no-op in production and
 * a recorder during a rollout". Once production mode gained turn capture that
 * was not merely stale, it was INVERTED -- production became the mode that
 * writes unconditionally -- and what it understated was the recording of
 * somebody's END USERS' message text. The truth:
 *
 *   training    tool outcomes go to the rollout's PERCEPTEYE_TRAJECTORY_DIR.
 *               With the variable unset nothing is written.
 *   production  every served turn -- the user's message, the tool calls, and
 *               (with allowConversationAccess) the agent's answer -- is written
 *               under PERCEPTEYE_CAPTURE_DIR, default ~/.percepteye/captured,
 *               whether or not PERCEPTEYE_TRAJECTORY_DIR is set. Nothing is
 *               uploaded without a key AND the control plane's per-agent
 *               consent, but it is on disk either way.
 *
 * The off switch is `capture: false` / PERCEPTEYE_CAPTURE=0, which returns from
 * `register` before any hook is subscribed, in either mode.
 *
 * WHAT PRODUCTION MODE ALSO DOES, and it is not observation. It applies BOTH
 * halves of what the control plane has APPROVED for this agent:
 *
 *   the system prompt  `{systemPrompt}` returned from `before_prompt_build`,
 *                      a full replacement of the prompt the host assembled.
 *   the model          `{providerOverride, modelOverride}` returned from
 *                      `before_model_resolve`, plus a registered provider
 *                      whose `normalizeTransport` supplies the base URL. That
 *                      hook is CONVERSATION-gated, so it needs the same
 *                      `allowConversationAccess=true` opt-in that capturing
 *                      the agent's answer needs.
 *
 * They are a certified PAIR, which is why they are applied together and why
 * applying one alone is reported as such. That is the last mile of the loop
 * this package exists to close, and the only thing here that changes what the
 * agent does rather than recording it. `policy.js` holds both decisions, the
 * pair check, the per-agent scope, and the two off switches --
 * `applyPrompt: false` / PERCEPTEYE_APPLY_PROMPT=0 and `applyModel: false` /
 * PERCEPTEYE_APPLY_MODEL=0.
 */
import { createRecorder } from "./record.js";
import { createWriter, TRAJECTORY_DIR_ENV } from "./trajectory.js";
import { registerDescriber, DESCRIBE_HOOK_NAME } from "./describe.js";
import { CONFIG_SCHEMA, resolveConfig } from "./config.js";
import { ControlPlaneClient } from "./http.js";
import { AttachTransport, rulesNeverSent, sentence } from "./transport.js";
import { PRODUCTION, TRAINING } from "./mode.js";
import { ConfigurationError } from "./errors.js";
import { registerRolloutDriver } from "./rollout.js";
import { PENDING_ANSWER_REASON, registerServingPolicy } from "./policy.js";
import { conversationAccessGranted } from "./host.js";
import {
  captureRoot, createTurnCapture, registerTurnCapture,
} from "./capture.js";
import {
  createExecutionIdentityTracker, withholdFingerprints,
} from "./execution-identity.js";
import { resolveDeclaration } from "./declaration.js";
import {
  CredentialsError, credentialsPath, loadStored, loginHint,
} from "./credentials.js";

export const PLUGIN_ID = "agent-flywheel";
export const HOOK_NAME = "after_tool_call";
export { DESCRIBE_HOOK_NAME };

/**
 * The operator's `describe`, validated -- or null, having said why.
 *
 * NOT A THROW, and that is the one place this differs from the Python SDK,
 * which refuses to start on a bad declaration. Here a throw fails the plugin
 * load and takes local capture down with it (see the mode fallback below), so
 * a bad declaration is dropped with a warning that names the same cause
 * Python's refusal names, and the agent registers what was observed.
 *
 * A STATIC declaration is checked whatever consent says, as Python checks it:
 * lifting the opt-out later must not be the moment a typo surfaces. A
 * FUNCTION runs only with consent -- nothing of the customer's runs for a
 * description that will not be sent.
 *
 * Anything thrown is caught, not only a ConfigurationError: this runs inside
 * `register()`, and the promise is that a declaration never costs the load.
 */
/**
 * The stored keys for `resolveConfig`, or `[]`. Unless a key is already
 * named (the plugin config's `apiKey` or PERCEPTEYE_API_KEY, which outrank
 * any stored one), the file under `percepteyeHome(env)` is read; an unusable
 * one is said once and read as none.
 */
function readStoredKeys(env, logger) {
  try {
    return loadStored(env);
  } catch (err) {
    if (!(err instanceof CredentialsError)) throw err;
    logger?.warn?.(`[${PLUGIN_ID}] ignoring stored keys: ${err.message}`);
    return [];
  }
}

function declarationFor(config, logger) {
  if (config.describe === null) return null;
  const refusal = (err) => (err instanceof ConfigurationError
    ? err.message
    : `describe could not be read (${err?.message ?? typeof err})`);
  if (!config.introspect) {
    if (typeof config.describe !== "function") {
      try {
        resolveDeclaration(config.describe);
      } catch (err) {
        logger?.warn?.(
          `[${PLUGIN_ID}] ${refusal(err)}. Fix ` +
          `plugins.entries.${PLUGIN_ID}.config.describe before turning ` +
          `introspection back on.`,
        );
      }
    }
    logger?.warn?.(
      `[${PLUGIN_ID}] introspection is off (introspect / ` +
      `PERCEPTEYE_INTROSPECT), and it wins: the description declared with ` +
      `describe is not sent, and this agent registers no description at all.`,
    );
    return null;
  }
  try {
    return resolveDeclaration(config.describe);
  } catch (err) {
    logger?.warn?.(
      `[${PLUGIN_ID}] ${refusal(err)}. The declaration is ignored, so this ` +
      `agent registers only what was observed. Fix ` +
      `plugins.entries.${PLUGIN_ID}.config.describe.`,
    );
    return null;
  }
}


export function register(api, pluginConfig = {}, env = process.env) {
  if (typeof api?.on !== "function") return null;

  const logger = api.logger ?? api.runtime?.logger ?? null;

  // THE KILL SWITCH, honoured. `openclaw.plugin.json` promises "Set
  // false/0/off to disable local capture entirely", and `resolveConfig`
  // computed `captureEnabled` for exactly that -- but nothing read it, and
  // `trajectory.js` records on the trajectory dir alone. A customer who set
  // PERCEPTEYE_CAPTURE=0 kept being recorded, which is the worst kind of
  // defect: a promise about somebody's data that the code does not keep.
  //
  // `pluginConfig` is a SECOND parameter with a default rather than a
  // required one, so this works whether or not the host passes config to
  // register(). Where it does, config wins; where it does not, the
  // environment still switches capture off. A fix that only worked once we
  // learned the host's calling convention would leave the promise broken in
  // the meantime.
  // `env` is a parameter, not a read of the global, so the gate is testable
  // without mutating process.env under a parallel test runner -- and it
  // matches resolveConfig's own signature rather than inventing a second
  // convention for the same thing.
  // WHERE THE HOST ACTUALLY PUTS CONFIG: `api.pluginConfig`
  // (OpenClaw 2026.7.1-2, dist/types-DaHgOqFX.d.ts:12076 declares
  // `pluginConfig?: Record<string, unknown>` on the plugin api). The loader
  // validates `plugins.entries.<id>.config` against the MANIFEST's
  // configSchema and hands the result over on the api object -- it does NOT
  // pass it as a second argument to register().
  //
  // Reading only an argument therefore honoured PERCEPTEYE_CAPTURE from the
  // environment and IGNORED `capture: false` in the customer's OpenClaw
  // config: half the promise, and the half the manifest documents first. The
  // explicit parameter is kept because it is what makes this gate testable
  // without constructing a whole host api.
  const supplied = Object.keys(pluginConfig).length
    ? pluginConfig
    : (api.pluginConfig ?? {});
  let config;
  let degraded = null;
  try {
    config = resolveConfig(supplied, env);
  } catch (err) {
    if (!(err instanceof ConfigurationError)) throw err;
    // AN UNREADABLE MODE DEGRADES TO PRODUCTION, LOUDLY. It does not throw
    // and it does not fall back to `training`, and both of those matter.
    //
    // Throwing is what the Python SDK does, and it is right THERE: `serve()`
    // is a process entry point, so refusing to start is the whole remedy. Here
    // the same throw would fail the plugin load and take LOCAL CAPTURE down
    // with it -- the one feature that works with no account, no key and no
    // control plane -- over a typo in a setting it does not depend on.
    //
    // Falling back to `training` would be worse than either: someone typing
    // `PERCEPTEYE_AGENT_MODE=prodction` is trying to STOP contributing, and a
    // default that resumes claiming rollouts on their credentials is the exact
    // failure the closed alias set exists to prevent. Production is the safe
    // side of a mode we could not read: the worst case is that this install
    // does less than intended, and says so.
    degraded = { ...supplied, mode: PRODUCTION };
    config = resolveConfig(degraded, env);
    logger?.warn?.(
      `[${PLUGIN_ID}] ${err.message} Running in ${PRODUCTION} mode until ` +
      `this is corrected; no rollouts will be claimed. Note that production ` +
      `mode is not inert: it captures served turns and applies the approved ` +
      `system prompt (PERCEPTEYE_CAPTURE=0 / PERCEPTEYE_APPLY_PROMPT=0).`,
    );
  }
  // THE KEY `npx @percepteye/agent-flywheel login` STORED, consulted only
  // when it can matter: capture is on (with it off nothing below runs) and
  // neither the config's `apiKey` nor PERCEPTEYE_API_KEY names a key, both of
  // which outrank it. `resolveConfig` ranks it (credentials.js); the file is
  // read here, once. An unreadable file is said and read as none: it must not
  // take local capture down with it.
  if (config.captureEnabled && config.apiKey === null) {
    const stored = readStoredKeys(env, logger);
    if (stored.length > 0) config = resolveConfig(degraded ?? supplied, env, stored);
  }
  if (config.apiKeySource === "stored") {
    // NEVER SILENT (owner ruling 2026-10-20, R2): a stored key is consent,
    // and the operator is told which one is in use and how to withdraw it.
    logger?.info?.(
      `[${PLUGIN_ID}] using the key stored for agent ` +
      `${JSON.stringify(config.agentId)} in ${credentialsPath(env)} (control ` +
      `plane ${config.controlPlaneUrl}). Run \`npx @percepteye/agent-flywheel ` +
      `logout --agent-id ${config.agentId}\` to stop.`,
    );
  } else if (config.apiKey === null && config.storedKeyRefusal) {
    logger?.warn?.(
      `[${PLUGIN_ID}] ${config.storedKeyRefusal}; ${loginHint(config.agentId)}.`,
    );
  }
  if (!config.captureEnabled) {
    // Nothing below runs, so configured `rules` are never declared either --
    // said here, by the sentence every such path uses, or an operator who
    // switched capture off would believe the Product's rulebook was updated.
    const unsent = rulesNeverSent(
      config.rules, "this install registers nothing while capture is disabled",
    );
    logger?.info?.(
      `[${PLUGIN_ID}] capture is disabled by configuration; recording nothing. ` +
      `Unset PERCEPTEYE_CAPTURE (or plugins.entries.${PLUGIN_ID}.config.capture) ` +
      `to re-enable.` + (unsent ? ` ${sentence(unsent)}` : ""),
    );
    return null;
  }
  // What the operator says this agent is (see declaration.js), and whether
  // they consented to saying anything at all.
  const declaration = declarationFor(config, logger);
  const tracker = createExecutionIdentityTracker({
    // Refused discovery authors no identity: the Python SDK authors none when
    // PERCEPTEYE_INTROSPECT is off. (The describer below may still write
    // discovered_agent.json locally under PERCEPTEYE_TRAJECTORY_DIR; its one
    // reader, the Python SDK's warm-up, asks consent itself.)
    executionSnapshot: config.introspect ? config.executionSnapshot : null,
    mode: config.mode,
    agentId: config.agentId,
  });
  if (config.executionSnapshot !== null && !config.introspect) {
    logger?.warn?.(
      `[${PLUGIN_ID}] exact execution identity is disabled: introspection is ` +
      `off (introspect / PERCEPTEYE_INTROSPECT), and identity is derived from ` +
      `the description. Capture continues without an execution fingerprint.`,
    );
  } else if (config.executionSnapshot !== null && !tracker.enabled) {
    logger?.warn?.(
      `[${PLUGIN_ID}] exact execution identity is disabled: ` +
      `${tracker.refusal}. Capture continues without an affirmative ` +
      `execution fingerprint.`,
    );
  }
  // A DECLARED description is the customer's word, not an observation: it
  // merges over what was observed and anchors no fingerprint, anywhere.
  const executionIdentity = declaration === null
    ? tracker
    : withholdFingerprints(tracker);
  if (declaration !== null && tracker.enabled) {
    // Said, because an operator who configured an execution snapshot and then
    // added `describe` otherwise loses exact identity with no line anywhere.
    logger?.warn?.(
      `[${PLUGIN_ID}] exact execution identity is withheld: ` +
      `${executionIdentity.refusal}. Remove describe to restore it.`,
    );
  }
  // ── WHERE TOOL CALLS LAND, decided by mode ────────────────────────────
  //
  // In TRAINING mode a trajectory belongs to one ROLLOUT, and the rollout
  // driver names the directory through PERCEPTEYE_TRAJECTORY_DIR. Unchanged.
  //
  // In PRODUCTION mode there is no rollout: a trajectory belongs to one TURN,
  // so each call is routed to its own turn directory by `runId`. The env var
  // is not consulted there, because a single shared directory would merge
  // every end user's calls into one trajectory -- and `PERCEPTEYE_AGENT_MODE`
  // is the authority on which of the two this process is.
  const turns = config.mode === PRODUCTION
    ? createTurnCapture({ root: captureRoot(env), logger })
    : null;
  const writer = createWriter({
    resolveDir: turns ? turns.resolveToolDir : null,
    onError: (err) => logger?.warn?.(
      `[${PLUGIN_ID}] trajectory write failed; tool outcomes are not being ` +
      `recorded for this run: ${err?.message ?? err}`,
    ),
  });
  // Declared here, before the recorder that reads them: the rollout driver is
  // built further down, and a tool call is a rollout's only while the driver
  // holds one for that session.
  let rollouts = null;
  let capture = null;
  let serving = null;
  const recorder = createRecorder({
    writer,
    // THE PLUGIN CONFIG'S MODE, already resolved against the `env` this
    // plugin was registered with. Without it the recorder read the process
    // environment alone, so an install set to production in its plugin
    // config stamped every tool span as a rollout.
    mode: config.mode,
    rolloutFor: (ctx) => rollouts?.rolloutFor?.(ctx) ?? null,
    executionIdentity,
  });

  api.on(HOOK_NAME, (event, ctx) => {
    // The host already isolates hook failures, but it logs a warning per
    // failure. Swallowing here keeps a malformed event from filling a
    // customer's logs with our name -- one lost record, never a failed run,
    // never a noisy one.
    try {
      recorder.handle(event, ctx ?? {});
    } catch {
      /* one lost record is not worth an interrupted agent */
    }
  });

  // ── THE MODE SPLIT, STRUCTURALLY ──────────────────────────────────────
  //
  // In production mode the rollout driver is NOT CONSTRUCTED and its three
  // hooks are NOT SUBSCRIBED. That is what makes "claims no work, starts no
  // turn" a property of this file rather than a promise each handler keeps:
  // there is no code path from a production install to a claim, an injection
  // or a report, because the module that could do those things is never
  // reached. A `if (mode === "training")` inside each handler would be the
  // same behaviour with a worse failure mode -- one missed call site is a
  // silent breach instead of a hook that simply is not there.
  //
  // Local capture above is UNAFFECTED by mode. It never leaves the machine,
  // and it is the plugin's day-one value with no account at all.
  if (config.mode === TRAINING) {
    // WRAPPED, because the host requires `register` to be SYNCHRONOUS and
    // treats a throw here as a failed plugin load (loader-D8d2EvVh.js:762).
    // `new ControlPlaneClient` refuses a missing key or base URL by design, so
    // a misconfigured control plane would otherwise take the RECORDER down
    // with it -- losing the local capture that works without any of this.
    try {
      rollouts = registerRolloutDriver(api, {
        config,
        pluginId: PLUGIN_ID,
        logger,
        // Where an undelivered result waits, via PERCEPTEYE_HOME. Passed for
        // the same reason `captureRoot(env)` is above: one answer to "where
        // does this package write", and the same `env` for both lanes.
        env,
        transport: config.apiKey
          ? new AttachTransport(
            new ControlPlaneClient(config.controlPlaneUrl, config.apiKey),
            { agentId: config.agentId },
          )
          : null,
        executionIdentity,
        declaration,
      });
    } catch (err) {
      logger?.warn?.(
        `[${PLUGIN_ID}] rollouts are disabled for this run: ` +
        `${err?.message ?? err}. Local capture is unaffected.`,
      );
    }
  } else {
    // WHAT PRODUCTION MODE PROMISES, said exactly, and CONDITIONAL ON WHAT
    // WILL ACTUALLY HAPPEN. This used to end "and no prompt is injected --
    // those hooks are not registered at all", which stopped being true the
    // moment `registerServingPolicy` below started subscribing
    // `before_prompt_build`. Then it promised the opposite unconditionally --
    // "It DOES ... apply the system prompt your control plane has approved" --
    // and on a keyless install, which is the ordinary first install, that was
    // false in the other direction: with no key there is no transport,
    // `registerServingPolicy` subscribes nothing, and the operator was told
    // otherwise by the line immediately before the silence.
    //
    // So the claim is READ OFF THE SOURCE, after it has wired itself, rather
    // than re-derived here. It used to be computed from three facts -- a key,
    // the kill switch, the conversation opt-in -- and there are more than
    // three: a host that has no provider surface, or that refuses the provider
    // id, rules the model half out too, and only `registerServingPolicy` knows
    // that. A predicate assembled here from a SUBSET of the source's own
    // inputs is a second answer that drifts the moment a cause is added.
    const conversationAccess = conversationAccessGranted(api, PLUGIN_ID);
    capture = registerTurnCapture(api, {
      config, turns, pluginId: PLUGIN_ID, logger, env, declaration,
    });
    // THE LAST MILE. `capture` owns the one control-plane client, so this
    // reuses it rather than building a second against the same key -- and
    // waits on the registration chain rather than racing it.
    serving = registerServingPolicy(api, {
      config,
      pluginId: PLUGIN_ID,
      logger,
      transport: capture?.transport ?? null,
      after: capture?.started ?? null,
      // The host's own config, for the agent scope, and the host's own answer
      // about whether it will deliver `before_model_resolve` at all.
      hostConfig: api?.config,
      conversationAccess,
    });
    // PENDING is the only value either half can hold here that is not a
    // settled refusal: the read has not happened yet, so anything else is a
    // cause that has already ruled that half out.
    const applying = [
      serving.refusal === PENDING_ANSWER_REASON ? "the system prompt" : null,
      serving.modelRefusal === PENDING_ANSWER_REASON ? "the model" : null,
    ].filter(Boolean);
    logger?.info?.(
      `[${PLUGIN_ID}] mode=${config.mode} (from ${config.modeSource}): this ` +
      `install claims no rollout and starts no turn -- those hooks are not ` +
      `registered at all. It DOES capture the turns you serve. ` +
      (applying.length
        ? `It also applies ${applying.join(" and ")} your control plane has ` +
          "approved."
        : "It applies NOTHING your control plane has approved; the lines " +
          "above say why.") +
      ` Tool outcomes are still recorded locally.`,
    );
  }

  // The describer answers a different question from the recorder: not "what
  // did this call do" but "what IS this agent". See describe.js -- it is the
  // only way a CLI agent can reach `introspection_state = described`, because
  // Python reflection cannot cross a process and a language boundary.
  const describer = registerDescriber(api, {
    logger,
    // Identity rides the same observer hook but is independent of description
    // persistence: it must work in production, where the trajectory env var
    // is normally absent and the describer writes nothing.
    onObservation: (event, ctx) => {
      // The run's first model input, for production model-content capture
      // (capture.js). Asked here because this is the plugin's one
      // `llm_input` subscription; it records nothing without the control
      // plane's model-content consent, and cannot cost the identity below.
      if (turns) {
        try {
          turns.onLlmInput(event, ctx ?? {});
        } catch { /* one lost observation */ }
      }
      const observation = executionIdentity.observe(event, ctx ?? {});
      if (turns && observation) {
        turns.onExecutionIdentity(event, ctx ?? {}, observation);
      }
    },
  });

  // `llm_input` is a CONVERSATION hook, and the host REFUSES to register it
  // for a non-bundled plugin unless the operator sets
  // `plugins.entries.<id>.hooks.allowConversationAccess=true`. The refusal is
  // a warn-level diagnostic on the host's side, so without this line a
  // missing opt-in is indistinguishable from a working install: the plugin
  // loads, the recorder works, and the agent registers as `unreadable`
  // forever with nothing anywhere saying why. Said once at startup, and only
  // when a trajectory dir makes it relevant.
  if (describer?.active) {
    logger?.info?.(
      `[${PLUGIN_ID}] describing this agent via ${DESCRIBE_HOOK_NAME}. That is ` +
      `a conversation hook: if you do not see ${"discovered_agent.json"} in ` +
      `${TRAJECTORY_DIR_ENV} after the first model call, set ` +
      `plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess=true in ` +
      `your OpenClaw config -- the host blocks the hook without it.`,
    );
  }

  return {
    recorder, writer, describer, rollouts, capture, serving, executionIdentity,
    mode: config.mode,
  };
}

export default {
  id: PLUGIN_ID,
  name: "PerceptEye Agent Flywheel",
  // THE STRING `openclaw plugins list` PRINTS, so it has to be true of the
  // install the reader is looking at. It said "Inert unless
  // PERCEPTEYE_TRAJECTORY_DIR is set" while production mode captured every
  // served turn to disk with that variable unset -- an operator who left the
  // plugin installed "because it is inert" was accumulating their end users'
  // messages.
  description:
    "Records tool-call outcomes (ok/failed/unknown). In training mode they " +
    `go to the active rollout's trajectory under ${TRAJECTORY_DIR_ENV}. In ` +
    "production mode every served turn -- the user's message, the tool " +
    "calls and the agent's answer -- is captured under " +
    "PERCEPTEYE_CAPTURE_DIR (default ~/.percepteye/captured) even when " +
    `${TRAJECTORY_DIR_ENV} is unset, and uploaded only with a key and the ` +
    "control plane's per-agent consent; production mode also APPLIES what " +
    "your control plane has approved for this agent -- the system prompt, and " +
    "the model it was certified with -- which changes what the agent does. " +
    "Set capture=false (or PERCEPTEYE_CAPTURE=0) to record nothing, " +
    "applyPrompt=false (or PERCEPTEYE_APPLY_PROMPT=0) to leave the prompt " +
    "alone, applyModel=false (or PERCEPTEYE_APPLY_MODEL=0) to leave the model " +
    "alone.",
  // THE SAME OBJECT the manifest declares, not a second one. This used to be
  // `{additionalProperties: false, properties: {}}` -- a schema that rejects
  // every setting openclaw.plugin.json tells a customer to write.
  configSchema: CONFIG_SCHEMA,
  register,
};
