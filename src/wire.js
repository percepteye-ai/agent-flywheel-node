/**
 * The flywheel/1 wire types, and the rules that keep a report honest.
 *
 * Two ends of ONE contract: `percepteye_agent_flywheel/contract.py` is the
 * other, and `schema/flywheel-1.json` ($id
 * https://schemas.percepteye.ai/flywheel/1.json) is the arbiter. A test in
 * this package asserts CONTRACT_VERSION equals that schema's
 * `x-contract-version`, because two copies of a contract with no mechanism
 * keeping them in sync is not a contract.
 */
export const CONTRACT_VERSION = "flywheel/1";

/** Runtime mirrors of the production-turn limits published by the schema. */
export const PRODUCTION_IDENTIFIER_MAX_CHARS = 255;
export const PRODUCTION_TURN_BATCH_MAX_ITEMS = 64;

const PRODUCTION_IDENTIFIER_RE = /^(?!\s)(?!.*\s$)[^\u0000-\u001F\u007F-\u009F]+$/u;
const PRODUCTION_TURN_IDENTIFIER_RE = /^(?!\.{1,2}$)(?!\s)(?!.*\s$)(?!.*[\\/])[^\u0000-\u001F\u007F-\u009F]+$/u;

function withinProductionIdentifierLimit(value) {
  // Python's len() and JSON Schema's maxLength count Unicode code points,
  // whereas JavaScript's String.length counts UTF-16 code units.
  return [...value].length <= PRODUCTION_IDENTIFIER_MAX_CHARS;
}

/** Return an exact opaque production correlation id, or null. Never rewrite. */
export function productionIdentifier(value) {
  return typeof value === "string"
    && value.length > 0
    && withinProductionIdentifierLimit(value)
    && PRODUCTION_IDENTIFIER_RE.test(value)
    ? value
    : null;
}

/** Return an exact production id that is also one safe path segment. */
export function productionTurnIdentifier(value) {
  return typeof value === "string"
    && value.length > 0
    && withinProductionIdentifierLimit(value)
    && PRODUCTION_TURN_IDENTIFIER_RE.test(value)
    ? value
    : null;
}

/** Agent ids share the turn-id grammar because they also enter URL paths. */
export const productionAgentIdentifier = productionTurnIdentifier;

/**
 * Every key a report may carry. A CLOSED set, mirroring
 * `contract.py:292 WIRE_KEYS`.
 *
 * The closedness is the point: anything derived from the inference wire or
 * from the rollout record is absent BY CONSTRUCTION, so an agent cannot
 * assert a field it has no way to know. The server validates independently,
 * because a client-side check binds only honest clients.
 */
export const WIRE_KEYS = Object.freeze([
  "final_text", "tool_calls", "tool_calls_omitted_count", "artifacts",
  "events", "timing", "llm_call_count", "reward", "success",
  "agent_fingerprint", "exclusion",
]);

const WIRE_KEY_SET = new Set(WIRE_KEYS);

export class ContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContractError";
  }
}

/**
 * One rollout, as the control plane handed it to us.
 *
 * Field names are the SERVER's, not ours -- renaming them here would put a
 * translation layer between two things that must agree exactly.
 */
export function rolloutRequestFromWire(raw) {
  if (!raw || typeof raw !== "object") {
    throw new ContractError("rollout payload is not an object");
  }
  const rolloutId = raw.rollout_id ?? raw.rolloutId;
  if (!rolloutId) throw new ContractError("rollout payload has no rollout_id");
  const leaseExpiresTs = raw.lease_expires_ts ?? raw.leaseExpiresTs;
  return {
    rolloutId: String(rolloutId),
    turnInput: String(raw.turn_input ?? ""),
    llmUrl: raw.llm_url ?? null,
    apiKey: raw.api_key ?? null,
    artifactsDir: raw.artifacts_dir ?? null,
    deadlineTs: Number(raw.deadline_ts ?? 0) || 0,
    leaseToken: raw.lease_token ?? null,
    leaseExpiresTs: leaseExpiresTs !== null && leaseExpiresTs !== undefined
      && Number.isFinite(Number(leaseExpiresTs))
      ? Number(leaseExpiresTs)
      : null,
    metadata: raw.metadata && typeof raw.metadata === "object"
      && !Array.isArray(raw.metadata)
      ? raw.metadata
      : {},
  };
}

/**
 * Serialize a report, enforcing the two distinctions the Python end depends on.
 *
 * `toolCalls` defaults to `null`, NEVER `[]`. The distinction is load-bearing:
 * `null` means "not reported", `[]` means "I observed zero tool calls", which
 * is a positive assertion. An agent that reports nothing must not accidentally
 * assert zero, so the default is the honest one (`contract.py:300-310`).
 */
export function rolloutOutputToWire(output) {
  if (!output || typeof output !== "object") {
    throw new ContractError("report is not an object");
  }
  if (typeof output.finalText !== "string") {
    // `final_text` is the ONE required field of RolloutOutput. Sending a
    // report without it is a report about nothing.
    throw new ContractError("final_text is required and must be a string");
  }
  const wire = { final_text: output.finalText };

  if (output.toolCalls !== undefined && output.toolCalls !== null) {
    if (!Array.isArray(output.toolCalls)) {
      throw new ContractError("tool_calls must be an array or null");
    }
    wire.tool_calls = output.toolCalls.map(scrubToolCall);
  }
  // ALWAYS SENT, even at zero. Non-zero forbids the training grade, so a
  // reader must be able to tell "none omitted" from "the field was missing".
  wire.tool_calls_omitted_count = Number(output.toolCallsOmittedCount ?? 0) || 0;

  if (output.llmCallCount !== undefined && output.llmCallCount !== null) {
    if (!Number.isInteger(output.llmCallCount) || output.llmCallCount < 0) {
      throw new ContractError(
        "llm_call_count must be a nonnegative integer or null",
      );
    }
    wire.llm_call_count = output.llmCallCount;
  }

  for (const [key, value] of [
    ["artifacts", output.artifacts], ["events", output.events],
    ["timing", output.timing],
    ["reward", output.reward], ["success", output.success],
    ["agent_fingerprint", output.agentFingerprint],
    ["exclusion", output.exclusion],
  ]) {
    if (value !== undefined && value !== null) wire[key] = value;
  }

  for (const key of Object.keys(wire)) {
    if (!WIRE_KEY_SET.has(key)) {
      throw new ContractError(`report carries a key outside the contract: ${key}`);
    }
  }
  return wire;
}

/**
 * An `unknown` outcome must carry NO status and NO body.
 *
 * `contract.py:189-193` scrubs both so a scorer cannot recover a verdict from
 * the envelope of a call whose result we never saw. Leaving a status_code on
 * an `unknown` would let a reward function read success out of a field that
 * only describes the transport.
 */
function scrubToolCall(call) {
  const out = { ...call };
  if (out.outcome === "unknown") {
    out.status_code = null;
    delete out.body;
    delete out.response;
  }
  if ("environment" in out) {
    // `contract.py:253-258` refuses this outright: the environment is the
    // control plane's fact about the rollout, not the agent's to assert.
    throw new ContractError("tool call may not carry an 'environment' field");
  }
  return out;
}
