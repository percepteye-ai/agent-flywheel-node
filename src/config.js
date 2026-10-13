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
import { ConfigurationError } from "./errors.js";
import {
  PRODUCTION_IDENTIFIER_MAX_CHARS, productionAgentIdentifier,
} from "./wire.js";

export const PLUGIN_ID = "agent-flywheel";

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
 * THE SAME HOST REFUSES A WRONG TYPE THE SAME WAY: a value its validator
 * rejects fails the plugin load. So the on/off switches take a NUMBER too --
 * `capture: 0` is documented as off, and a schema of string|boolean refused it
 * and skipped the plugin -- and NULL, which `resolveConfig` reads as unset;
 * and `describe` and `rules` declare no type at all.
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
      maxLength: 255,
      pattern: "^(?!\\.{1,2}$)(?!\\s)(?!.*\\s$)(?!.*[\\\\/])[^\\u0000-\\u001F\\u007F-\\u009F]+$",
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
      type: ["string", "boolean", "number", "null"],
      description:
        "Set false/0/off to disable local capture entirely. Unset means " +
        "PERCEPTEYE_CAPTURE, then on.",
    },
    applyPrompt: {
      type: ["string", "boolean", "number", "null"],
      description:
        "Set false/0/off to stop applying the control plane's approved " +
        "system prompt in production mode. Unset means " +
        "PERCEPTEYE_APPLY_PROMPT, then on.",
    },
    applyModel: {
      type: ["string", "boolean", "number", "null"],
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
        startupObservation: {
          type: "object",
          additionalProperties: false,
          required: ["systemPrompt", "tools", "provider", "model"],
          properties: {
            systemPrompt: { type: "string", minLength: 1 },
            tools: {
              type: "array",
              items: { type: "object" },
            },
            provider: { type: "string", minLength: 1 },
            model: { type: "string", minLength: 1 },
          },
          description:
            "Optional exact prompt/tool/provider/model observation available " +
            "before the first claim. It lets registration carry the same " +
            "SDK-authored execution fingerprint later reports must match.",
        },
      },
      description:
        "Host-adapter evidence for exact execution identity. Component names " +
        "are opaque to the SDK; incomplete or invalid evidence emits no identity. " +
        "A startup observation enables pre-claim registration binding.",
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
    introspect: {
      type: ["string", "boolean", "number", "null"],
      description:
        "Set false/0/off to register this agent with no description at all; " +
        "the control plane records that as your opt-out. " +
        "PERCEPTEYE_INTROSPECT=0 refuses too, whatever this says. Unset " +
        "means on.",
    },
    // NO `type`, deliberately. A value the host's validator refuses fails the
    // whole plugin load and takes local capture down with it, so any value
    // passes here and declaration.js decides -- refusing a bad one with a
    // warning, the plugin still loaded.
    describe: {
      description:
        "The agent's own description, for what this plugin cannot observe " +
        "(OpenClaw's llm_input carries no tools): system_prompt, tools (the " +
        "list the agent sends its model -- OpenAI function specs, Anthropic " +
        "tools, or {name, description, input_schema, read_only}) and model " +
        "(a name, or {model_name, provider, temperature, max_tokens}). What " +
        "you declare wins where given; it anchors no execution identity.",
    },
    // NO `type`, for `describe`'s reason: a wrong one would fail the plugin
    // load, and local capture with it. A value that is not a whole number of
    // turns is dropped with a warning naming it (`capture.js:
    // retentionTurnsFrom`), the Python SDK's refusal in this host's idiom.
    retentionTurns: {
      description:
        "Keep only this many most recently written captured turns on disk, " +
        "pruning the rest every 256 turns, so the directory holds at most " +
        "retentionTurns + 256. Unset keeps every turn: nothing deletes your " +
        "capture unless you ask. A whole number, 0 or more.",
    },
    // NO `type` either, for `describe`'s reason: a wrong one would fail the
    // plugin load. The control plane is the one validator of the rules and
    // names what it refuses; the refusal is logged, never fatal.
    rules: {
      description:
        "The workflow rules this agent follows, one prose rule per string " +
        "(a list of strings), registered once per start, with an API key " +
        "and capture on, as the rulebook of the one Product that declares " +
        "it -- training guidance, " +
        "never added to the served agent's prompt. Every start that sets it " +
        "declares it again, so the last writer wins; [] retracts. Unset sends " +
        "nothing and leaves the rulebook in force alone.",
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

const agentIdentifier = (...values) => {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const exact = productionAgentIdentifier(value);
    if (exact !== null) return exact;
    throw new ConfigurationError(
      "agentId must be a non-empty, control-free identifier without edge " +
      "whitespace, path separators, or dot segments, with at most " +
      `${PRODUCTION_IDENTIFIER_MAX_CHARS} characters`,
    );
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
    agentId: agentIdentifier(
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
    // CONSENT to describe this agent, asked as the Python SDK asks it and
    // refusable from EITHER side: `introspect: false` here (Python's
    // `serve(introspect=False)`) or PERCEPTEYE_INTROSPECT=0 (for an operator
    // who cannot edit the config). Unlike the switches above, neither side
    // overrides the other -- one refusal is enough, as it is in Python.
    introspect:
      enabledUnlessOff(pluginConfig.introspect, undefined) &&
      enabledUnlessOff(undefined, env.PERCEPTEYE_INTROSPECT),
    // The operator's own description, transported only. It is checked in
    // index.js, where a bad one can be refused loudly without failing the
    // plugin load; see declaration.js.
    describe: pluginConfig.describe ?? null,
    // The operator's workflow rules, transported only and config-only, like
    // `describe`. Null sends nothing -- which is not `[]`, a retraction. The
    // control plane validates them; see `AttachTransport.registerRulebook`.
    rules: pluginConfig.rules ?? null,
    // Config-only, like the Python SDK's `attach(retention_turns=...)`, which
    // has no environment form either. Transported raw and checked where a bad
    // value can be named without failing the plugin load (`capture.js`).
    retentionTurns: pluginConfig.retentionTurns ?? null,
    contributing: Boolean(apiKey),
  };
}
