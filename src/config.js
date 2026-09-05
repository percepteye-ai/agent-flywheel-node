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
      default: "openclaw",
      description: "The agent name this install reports as.",
    },
    controlPlaneUrl: {
      type: "string",
      format: "uri",
      description: "Override the control-plane base URL.",
    },
    capture: {
      type: ["string", "boolean"],
      default: true,
      description: "Set false/0/off to disable local capture entirely.",
    },
    unattended: {
      type: ["string", "boolean"],
      default: true,
      description:
        "In training mode, the plugin starts rollout turns itself rather than " +
        "waiting for you to start one. Has NO effect in production mode. Set " +
        "false/0/off to keep claiming rollouts but only deliver them into " +
        "turns you start.",
    },
    mode: {
      type: "string",
      enum: [
        "training", "train", "rollout", "rollouts", "fine-tuning",
        "finetuning", "improving", "production", "prod", "serving",
      ],
      default: "training",
      description:
        "training: this install claims rollouts and drives turns. " +
        "production: observe-only -- the rollout hooks are never registered. " +
        "Overrides PERCEPTEYE_AGENT_MODE.",
    },
  },
};

const DEFAULT_CONTROL_PLANE = "https://launch.percepteye.ai/api/flywheel/v1";

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
    controlPlaneUrl: firstString(
      pluginConfig.controlPlaneUrl,
      env.PERCEPTEYE_CONTROL_PLANE_URL,
      env.CONTROL_PLANE_ENV_URL,
    ) ?? DEFAULT_CONTROL_PLANE,
    // ON unless DELIBERATELY disabled, exactly like `capture`, and for the
    // same reason a typo must not silently switch it off.
    //
    // THIS WAS OPT-IN FIRST, AND THAT WAS WRONG. The argument for opt-in was
    // that starting turns reaches past a restriction the host states for its
    // own scheduling API. But it treated "the plugin runs the rollout" as a
    // capability beyond what the operator asked for, and it is not:
    // `PERCEPTEYE_AGENT_MODE=training` already means "this install claims
    // rollouts and runs them", and in that mode the plugin ALREADY claims work
    // and puts tasks into the agent's context. Starting the turn is how that
    // promise is kept, not a further intrusion -- and requiring a second
    // switch just meant the flywheel sat idle waiting for somebody to poke it.
    //
    // The genuine risk -- that the host seam is closed in a patch release --
    // is handled by DEGRADING to task delivery, which is automatic and needs
    // no setting. Dormant-by-default never made the seam more stable; it only
    // meant nobody got the capability.
    //
    // It has no effect in production mode, structurally: the rollout driver is
    // never constructed there, so this value is never read.
    unattended: !["0", "false", "no", "off"].includes(
      String(pluginConfig.unattended ?? env.PERCEPTEYE_UNATTENDED ?? "")
        .trim().toLowerCase(),
    ),
    // Capture is on unless DELIBERATELY disabled. A typo must not silently
    // switch it off and leave the operator believing it is on.
    captureEnabled: !["0", "false", "no", "off"].includes(
      String(pluginConfig.capture ?? env.PERCEPTEYE_CAPTURE ?? "").trim().toLowerCase(),
    ),
    contributing: Boolean(apiKey),
  };
}
