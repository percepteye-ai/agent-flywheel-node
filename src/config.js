/**
 * Where the plugin's settings come from, and the ONE decision that gates the
 * network entirely.
 *
 * THE CONSENT BOUNDARY. If no API key resolves, `contributing()` returns null
 * and every control-plane path stays inert -- no claim, no report, no
 * registration, nothing leaves the machine. Local capture still runs, which is
 * the plugin's day-one value: your agent's real tool-failure rate, no account,
 * no network. A customer with no key is not misconfigured; they are the
 * ordinary first install.
 *
 * Precedence is OpenClaw config first, environment second. The config path is
 * preferred because it is hot-reloaded and puts the secret under OpenClaw's own
 * secret-ref machinery, while a gateway process reads its environment once at
 * launch and cannot be re-keyed without a restart.
 */
import { resolveModeSource } from "./mode.js";

export const PLUGIN_ID = "percepteye-agent-flywheel";

/**
 * The settings this plugin accepts, declared ONCE.
 *
 * `openclaw.plugin.json` carries a copy because that is the file the host
 * reads before any of this code loads. The copy is not a second answer: a test
 * asserts the two are identical, which is the only thing that keeps them so --
 * and they had already diverged. `index.js` declared
 * `{additionalProperties: false, properties: {}}`, which does not merely fail
 * to read the settings, it REJECTS them: a customer following the manifest and
 * setting `apiKey` would have had it refused by the schema the module exports.
 *
 * NO PROPERTY HERE DECLARES A `default`, and that absence is load-bearing.
 * OpenClaw validates `plugins.entries.<id>.config` with
 * `validateJsonSchemaValue({..., applyDefaults: true})`
 * (dist/loader-D8d2EvVh.js:1381-1412 -> dist/schema-validator-BRkrm3P2.js:239)
 * and hands the RESULT over as `api.pluginConfig`. A schema default is
 * therefore NOT "what happens when nobody said": the host materialises it into
 * an EXPLICIT config value for every install, including one with no `config`
 * block at all. `mode: "training"` then outranked PERCEPTEYE_AGENT_MODE,
 * `capture: true` outranked PERCEPTEYE_CAPTURE and `agentId: "openclaw"`
 * outranked PERCEPTEYE_AGENT_ID -- so a gateway serving real end users, with
 * PERCEPTEYE_AGENT_MODE=production set exactly as the README instructs, claimed
 * rollouts and started unattended turns anyway, and the operator got no signal
 * because the production-mode log is on the branch that was never taken.
 *
 * `resolveConfig` below is the ONE place a default is decided. A schema default
 * is a second answer to a question already answered there, and this host turns
 * it into the winning one. `test/config-gate.test.js` asserts the absence.
 */
export const CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    apiKey: {
      type: "string",
      minLength: 1,
      description:
        "PerceptEye flywheel key (pefw_...). Without it the plugin records " +
        "locally and contacts nothing.",
    },
    agentId: {
      type: "string",
      minLength: 1,
      description:
        "The agent name this install reports as. Unset means " +
        'PERCEPTEYE_AGENT_ID, then "openclaw".',
    },
    controlPlaneUrl: {
      type: "string",
      format: "uri",
      description: "Override the control-plane base URL.",
    },
    capture: {
      type: ["string", "boolean"],
      description:
        "Set false/0/off to disable local capture entirely. Unset means " +
        "PERCEPTEYE_CAPTURE, then on.",
    },
    applyPrompt: {
      type: ["string", "boolean"],
      description:
        "Set false/0/off to stop applying the control plane's approved " +
        "system prompt in production mode. Unset means " +
        "PERCEPTEYE_APPLY_PROMPT, then on.",
    },
    applyModel: {
      type: ["string", "boolean"],
      description:
        "Set false/0/off to stop pointing this agent at the control " +
        "plane's approved model in production mode. Unset means " +
        "PERCEPTEYE_APPLY_MODEL, then on. Needs " +
        "hooks.allowConversationAccess=true to take effect at all.",
    },
    executionSnapshot: {
      type: "object",
      additionalProperties: false,
      required: [
        "adapterName", "executionIdentityComplete", "executionComponents",
      ],
      properties: {
        adapterName: { type: "string", minLength: 1 },
        executionIdentityComplete: { type: "boolean" },
        executionComponents: {
          type: "object",
          minProperties: 1,
          propertyNames: { type: "string", minLength: 1 },
          additionalProperties: { type: "string", pattern: "^[0-9a-f]{64}$" },
        },
      },
      description:
        "Host-adapter evidence for exact execution identity. Component names " +
        "are opaque to the SDK; incomplete or invalid evidence emits no identity.",
    },
    mode: {
      type: "string",
      enum: [
        "training", "train", "rollout", "rollouts", "fine-tuning",
        "finetuning", "improving", "production", "prod", "serving",
      ],
      description:
        "training: this install claims rollouts and drives turns. " +
        "production: claims no rollout and starts no turn -- those hooks are " +
        "never registered -- but captures the turns you serve and applies " +
        "the system prompt your control plane approved. Unset means " +
        "PERCEPTEYE_AGENT_MODE, then training; a value here overrides the " +
        "environment.",
    },
  },
};

/**
 * Where this plugin dials when nothing names a control plane.
 *
 * `launch.percepteye.ai` is the live API domain. Named in the README's
 * configuration table too, because a default a customer cannot see is a
 * default they cannot tell apart from a control plane that is down.
 */
const DEFAULT_CONTROL_PLANE = "https://launch.percepteye.ai/api/flywheel/v1";

/** The spellings that mean OFF. One list, because one typo rule applies. */
const OFF = ["0", "false", "no", "off"];

/** `pluginConfig.<key> ?? env.<ENV>`, ON unless DELIBERATELY switched off. */
const enabledUnlessOff = (configured, fromEnv) =>
  !OFF.includes(String(configured ?? fromEnv ?? "").trim().toLowerCase());

const firstString = (...values) => {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
};

/**
 * @param {object} pluginConfig  `plugins.entries.<id>.config`, as OpenClaw hands it
 * @param {object} env           defaults to process.env
 */
export function resolveConfig(pluginConfig = {}, env = process.env) {
  const apiKey = firstString(pluginConfig.apiKey, env.PERCEPTEYE_API_KEY);
  // THROWS on an unrecognised mode, and is meant to. A typo here decides
  // whether this process claims rollouts on the customer's credentials, and
  // there is no value to fall back to that is right in both directions.
  const { mode, source: modeSource } = resolveModeSource(pluginConfig.mode, env);
  return {
    apiKey,
    mode,
    modeSource,
    agentId: firstString(
      pluginConfig.agentId, env.PERCEPTEYE_AGENT_ID,
    ) ?? "openclaw",
    // ONE NAME FOR ONE QUESTION. This also read an unprefixed
    // `CONTROL_PLANE_ENV_URL`, at the LOWEST precedence -- while the Python
    // SDK's harness recorder read the same variable at the HIGHEST. Nothing in
    // the platform has ever set it, neither README named it, and it is not in
    // `CONFIG_SCHEMA`, so no customer could discover it existed; what it could
    // do was collide with an unrelated variable of that generic name in a
    // customer's environment and send this agent's telemetry somewhere else.
    // Two components of one product resolving the control plane differently is
    // not something a precedence rule fixes -- it is a second answer, so it is
    // gone rather than aligned.
    controlPlaneUrl: firstString(
      pluginConfig.controlPlaneUrl,
      env.PERCEPTEYE_CONTROL_PLANE_URL,
    ) ?? DEFAULT_CONTROL_PLANE,
    // Capture is on unless DELIBERATELY disabled. A typo must not silently
    // switch it off and leave the operator believing it is on.
    captureEnabled: enabledUnlessOff(
      pluginConfig.capture, env.PERCEPTEYE_CAPTURE,
    ),
    // The same rule for the same reason, and the same list of off-spellings --
    // a customer who learned `capture=off` must not discover that
    // `applyPrompt=off` was a typo that left the prompt being applied.
    // Default ON: a capability that ships dormant is a capability nobody gets.
    applyPromptEnabled: enabledUnlessOff(
      pluginConfig.applyPrompt, env.PERCEPTEYE_APPLY_PROMPT,
    ),
    // The model half's own switch, mirroring the prompt one exactly -- same
    // off-spellings, same precedence, same default. The two halves of a
    // certified pair are separately refusable because they fail separately:
    // an operator may want the approved prompt on their own provider, or the
    // trained checkpoint under a prompt they wrote themselves.
    applyModelEnabled: enabledUnlessOff(
      pluginConfig.applyModel, env.PERCEPTEYE_APPLY_MODEL,
    ),
    // Adapter-owned opaque evidence. Validation and fail-closed reconciliation
    // live with the identity code; configuration only transports the snapshot.
    executionSnapshot: pluginConfig.executionSnapshot ?? null,
    contributing: Boolean(apiKey),
  };
}
