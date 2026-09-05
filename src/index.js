/**
 * percepteye-agent-flywheel — an OpenClaw plugin that records tool-call outcomes.
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
 * Zero dependencies. Inert unless PERCEPTEYE_TRAJECTORY_DIR is set, so one
 * install is a no-op in production and a recorder during a rollout.
 */
import { createRecorder } from "./record.js";
import { createWriter, TRAJECTORY_DIR_ENV } from "./trajectory.js";
import { registerDescriber, DESCRIBE_HOOK_NAME } from "./describe.js";
import { CONFIG_SCHEMA, resolveConfig } from "./config.js";

export const PLUGIN_ID = "percepteye-agent-flywheel";
export const HOOK_NAME = "after_tool_call";
export { DESCRIBE_HOOK_NAME };

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
  const config = resolveConfig(
    Object.keys(pluginConfig).length ? pluginConfig : (api.pluginConfig ?? {}),
    env,
  );
  if (!config.captureEnabled) {
    logger?.info?.(
      `[${PLUGIN_ID}] capture is disabled by configuration; recording nothing. ` +
      `Unset PERCEPTEYE_CAPTURE (or plugins.entries.${PLUGIN_ID}.config.capture) ` +
      `to re-enable.`,
    );
    return null;
  }
  const writer = createWriter({
    onError: (err) => logger?.warn?.(
      `[${PLUGIN_ID}] trajectory write failed; tool outcomes are not being ` +
      `recorded for this run: ${err?.message ?? err}`,
    ),
  });
  const recorder = createRecorder({ writer });

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

  // The describer answers a different question from the recorder: not "what
  // did this call do" but "what IS this agent". See describe.js -- it is the
  // only way a CLI agent can reach `introspection_state = described`, because
  // Python reflection cannot cross a process and a language boundary.
  const describer = registerDescriber(api, { logger });

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

  return { recorder, writer, describer };
}

export default {
  id: PLUGIN_ID,
  name: "PerceptEye Agent Flywheel",
  description:
    "Records tool-call outcomes (ok/failed/unknown) into the active " +
    `rollout's trajectory. Inert unless ${TRAJECTORY_DIR_ENV} is set.`,
  // THE SAME OBJECT the manifest declares, not a second one. This used to be
  // `{additionalProperties: false, properties: {}}` -- a schema that rejects
  // every setting openclaw.plugin.json tells a customer to write.
  configSchema: CONFIG_SCHEMA,
  register,
};
