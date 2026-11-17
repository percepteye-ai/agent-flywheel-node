/**
 * The flywheel/1 wire types, and the rules that keep a report honest.
 *
 * Two ends of ONE contract: `agent_flywheel/contract.py` is the
 * other, and `schema/flywheel-1.json` ($id
 * https://schemas.percepteye.ai/flywheel/1.json) is the arbiter. A test in
 * this package asserts CONTRACT_VERSION equals that schema's
 * `x-contract-version`, because two copies of a contract with no mechanism
 * keeping them in sync is not a contract.
 */
import { jsonType } from "./declaration.js";
import { isLowerSha256 } from "./execution-identity.js";

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
  "agent_fingerprint", "exclusion", "checks", "termination", "seeds",
]);

/** The state a reported check is in. Only `measured` carries a `value`. */
export const CHECK_STATUSES = Object.freeze([
  "measured", "unavailable", "error", "abstained", "not_applicable",
]);
/** What a reported check proves. */
export const CHECK_ESTABLISHES = Object.freeze([
  "action_taken", "state_reached", "output_matched",
  "message_communicated", "call_returned_without_error",
]);
/**
 * How an episode ended. The agent states the class; who is answerable for it
 * is decided by the platform, from its own records.
 */
export const TERMINATION_CLASSES = Object.freeze([
  "completed", "turn_limit", "token_limit", "time_limit", "error", "cancelled",
]);
/** Most checks one report may carry. */
export const MAX_REPORTED_CHECKS = 200;

const WIRE_KEY_SET = new Set(WIRE_KEYS);

export class ContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContractError";
  }
}

/**
 * `reportOutcome` was handed something the outcome wire cannot carry: a word
 * outside the closed vocabulary, no turn or conversation to attach it to, an
 * id, number, note or time the published schema refuses. The Python SDK's
 * `InvalidOutcome`. Thrown BEFORE anything is stored or sent, whether or not
 * production capture is enabled.
 */
export class InvalidOutcome extends ContractError {
  constructor(message) {
    super(message);
    this.name = "InvalidOutcome";
  }
}

/**
 * THE closed vocabulary of `reportOutcome`: how a production turn or
 * conversation actually turned out. Asserted verbatim against
 * `schema/flywheel-1.json` (`ProductionOutcome.outcome`); the Python SDK's
 * `PRODUCTION_OUTCOMES`.
 */
export const PRODUCTION_OUTCOMES = Object.freeze([
  "resolved", "escalated", "reopened", "abandoned",
  "thumbs_up", "thumbs_down",
]);
/** A note is a short remark, not a transcript (code points, as the schema counts). */
export const PRODUCTION_OUTCOME_NOTE_MAX_CHARS = 1000;
export const PRODUCTION_OUTCOME_BATCH_MAX_ITEMS = 64;
/**
 * An RFC 3339 instant WITH its offset; the schema's `occurred_at.pattern`.
 * ASCII digits, spelled `[0-9]`: the Python SDK's `\\d` matched other
 * scripts' digits, and the pattern is one string both SDKs and the schema share.
 */
export const RFC3339_PATTERN =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?" +
  "(Z|[+-][0-9]{2}:[0-9]{2})$";
const RFC3339_RE = new RegExp(RFC3339_PATTERN, "u");

/**
 * Whether `text` is an RFC 3339 instant that EXISTS: the pattern, and then
 * every field in its range -- a real calendar day (`2026-02-30` is not one),
 * an hour of 0-23 (`T24:00` is not one), no leap second, an offset under a
 * day. A shape alone let an impossible time reach the control plane, which
 * refused the whole batch around it. The Python SDK's `_is_rfc3339_instant`,
 * the same arithmetic.
 */
export function isRfc3339Instant(text) {
  if (typeof text !== "string" || !RFC3339_RE.test(text)) return false;
  const num = (a, b) => Number(text.slice(a, b));
  const [year, month, day] = [num(0, 4), num(5, 7), num(8, 10)];
  const [hour, minute, second] = [num(11, 13), num(14, 16), num(17, 19)];
  if (!(year >= 1 && month >= 1 && month <= 12)) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!(day >= 1 && day <= days[month - 1] && hour <= 23 && minute <= 59
        && second <= 59)) return false;
  if (!text.endsWith("Z")) {
    if (num(text.length - 5, text.length - 3) > 23
        || num(text.length - 2, text.length) > 59) return false;
  }
  return true;
}
const OUTCOME_WIRE_KEYS = new Set([
  "outcome_id", "outcome", "turn_id", "conversation_id", "value", "note",
  "occurred_at",
]);

/**
 * One reported outcome exactly as the wire carries it, or `InvalidOutcome`
 * naming what is wrong.
 *
 * THE one validator: `reportOutcome` builds its record through it, and
 * `AttachTransport.reportOutcomes` passes every outcome through it again
 * before a batch leaves. The Python SDK's `production_outcome`, rule for rule
 * and message for message (`test_report_outcome.py` runs both).
 *
 * Absent optional fields are OMITTED, never null. Nothing is rewritten.
 */
export function productionOutcome(wire) {
  if (!wire || typeof wire !== "object" || Array.isArray(wire)) {
    throw new InvalidOutcome(`an outcome must be an object, got ${jsonType(wire)}`);
  }
  const unknown = Object.keys(wire).filter((k) => !OUTCOME_WIRE_KEYS.has(k)).sort();
  if (unknown.length) {
    throw new InvalidOutcome(`an outcome has no field ${JSON.stringify(unknown[0])}`);
  }
  const present = (v) => v !== undefined && v !== null;
  const { outcome } = wire;
  if (typeof outcome !== "string" || !PRODUCTION_OUTCOMES.includes(outcome)) {
    const got = typeof outcome === "string" ? JSON.stringify(outcome) : jsonType(outcome ?? null);
    throw new InvalidOutcome(
      `outcome must be one of ${PRODUCTION_OUTCOMES.join(", ")}; got ${got}`);
  }
  if (productionTurnIdentifier(wire.outcome_id) === null) {
    throw new InvalidOutcome("outcome_id is not a valid identifier");
  }
  const out = { outcome_id: wire.outcome_id, outcome };
  if (present(wire.turn_id)) {
    if (productionTurnIdentifier(wire.turn_id) === null) {
      throw new InvalidOutcome("turn_id is not a valid turn identifier");
    }
    out.turn_id = wire.turn_id;
  }
  if (present(wire.conversation_id)) {
    if (productionIdentifier(wire.conversation_id) === null) {
      throw new InvalidOutcome("conversation_id is not a valid identifier");
    }
    out.conversation_id = wire.conversation_id;
  }
  if (!("turn_id" in out) && !("conversation_id" in out)) {
    throw new InvalidOutcome(
      "an outcome names the turn_id or the conversation_id it is the outcome of");
  }
  if (present(wire.value)) {
    if (typeof wire.value !== "number" || !Number.isFinite(wire.value)) {
      throw new InvalidOutcome("value must be a finite number");
    }
    out.value = wire.value;
  }
  if (present(wire.note)) {
    if (
      typeof wire.note !== "string" || wire.note.length === 0
      || [...wire.note].length > PRODUCTION_OUTCOME_NOTE_MAX_CHARS
    ) {
      throw new InvalidOutcome(
        "note must be a non-empty string of at most " +
        `${PRODUCTION_OUTCOME_NOTE_MAX_CHARS} characters`);
    }
    out.note = wire.note;
  }
  if (!isRfc3339Instant(wire.occurred_at)) {
    throw new InvalidOutcome(
      "occurred_at must be an RFC 3339 time with its offset, such as " +
      "2026-11-10T09:00:00Z");
  }
  out.occurred_at = wire.occurred_at;
  return out;
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
    // The task this rollout was handed, by the id it was claimed under -- for
    // a task the customer registered, THEIR id (Python: `current_task_id()`).
    // Only a safe opaque id; anything else is absent, never rewritten.
    taskId: raw.metadata && typeof raw.metadata === "object"
      && !Array.isArray(raw.metadata)
      ? productionIdentifier(raw.metadata.task_id)
      : null,
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
const CHECK_KEYS = new Set(["id", "status", "value", "basis", "required", "establishes"]);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function shortText(value, limit, what) {
  if (typeof value !== "string" || value.length === 0 || [...value].length > limit) {
    throw new ContractError(
      `${what} must be a non-empty string of at most ${limit} characters`,
    );
  }
  return value;
}

function unknownKeys(obj, allowed, what) {
  const extra = Object.keys(obj).filter((k) => !allowed.has(k)).sort();
  if (extra.length) {
    throw new ContractError(`${what} carries unknown key(s) ${extra.join(", ")}`);
  }
}

/**
 * The wire form of the checks an agent's own environment ran on an episode:
 * `[{id, status, value, basis, required, establishes}]`, only `id` and
 * `status` required. Mirrors `contract.py checks_to_wire`.
 */
export function checksToWire(checks) {
  if (!Array.isArray(checks)) throw new ContractError("checks must be a list");
  if (checks.length > MAX_REPORTED_CHECKS) {
    throw new ContractError(
      `checks carries ${checks.length} rows; at most ${MAX_REPORTED_CHECKS} are accepted`,
    );
  }
  return checks.map((row, i) => {
    const where = `checks[${i}]`;
    if (!isObject(row)) throw new ContractError(`${where} must be an object`);
    unknownKeys(row, CHECK_KEYS, where);
    const out = { id: shortText(row.id, 200, `${where}.id`) };
    if (!CHECK_STATUSES.includes(row.status)) {
      throw new ContractError(
        `${where}.status must be one of ${CHECK_STATUSES.join(", ")}`,
      );
    }
    out.status = row.status;
    if (row.value !== undefined && row.value !== null) {
      if (typeof row.value !== "number" || !Number.isFinite(row.value)) {
        throw new ContractError(`${where}.value must be a finite number or null`);
      }
      if (row.status !== "measured") {
        throw new ContractError(
          `${where}.value is stated but its status is ${row.status}; ` +
          `only a measured check has a value`,
        );
      }
      out.value = row.value;
    }
    if (row.basis !== undefined && row.basis !== null) {
      out.basis = shortText(row.basis, 200, `${where}.basis`);
    }
    if (row.required !== undefined && row.required !== null) {
      if (typeof row.required !== "boolean") {
        throw new ContractError(`${where}.required must be a boolean`);
      }
      out.required = row.required;
    }
    if (row.establishes !== undefined && row.establishes !== null) {
      if (!CHECK_ESTABLISHES.includes(row.establishes)) {
        throw new ContractError(
          `${where}.establishes must be one of ${CHECK_ESTABLISHES.join(", ")}`,
        );
      }
      out.establishes = row.establishes;
    }
    return out;
  });
}

/** The wire form of how the episode ended: `{class, detail}`. */
export function terminationToWire(termination) {
  if (!isObject(termination)) throw new ContractError("termination must be an object");
  unknownKeys(termination, new Set(["class", "detail"]), "termination");
  if (!TERMINATION_CLASSES.includes(termination.class)) {
    throw new ContractError(
      `termination.class must be one of ${TERMINATION_CLASSES.join(", ")}`,
    );
  }
  const out = { class: termination.class };
  if (termination.detail !== undefined && termination.detail !== null) {
    out.detail = shortText(termination.detail, 500, "termination.detail");
  }
  return out;
}

/** The wire form of the seeds the episode ran under: `{environment, sampling}`. */
export function seedsToWire(seeds) {
  if (!isObject(seeds)) throw new ContractError("seeds must be an object");
  unknownKeys(seeds, new Set(["environment", "sampling"]), "seeds");
  const out = {};
  for (const key of ["environment", "sampling"]) {
    const value = seeds[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      shortText(value, 128, `seeds.${key}`);
    } else if (!Number.isSafeInteger(value)) {
      throw new ContractError(`seeds.${key} must be an integer or a string`);
    }
    out[key] = value;
  }
  return out;
}

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

  if (Array.isArray(output.checks) ? output.checks.length : output.checks != null) {
    wire.checks = checksToWire(output.checks);
  }
  if (output.termination !== undefined && output.termination !== null) {
    wire.termination = terminationToWire(output.termination);
  }
  if (output.seeds !== undefined && output.seeds !== null) {
    const seeds = seedsToWire(output.seeds);
    if (Object.keys(seeds).length) wire.seeds = seeds;
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

/**
 * A Product-rulebook declaration's two wire shapes, hand-written to match
 * `schema/flywheel-1.json` `$defs.RulebookRequest` and `$defs.RulebookReceipt`
 * -- as the Python SDK's `contract.py` `RulebookRequest` / `RulebookReceipt`
 * are -- and held equal to them by `test/wire.test.js`. Each refusal below is
 * worded as the Python end words it.
 *
 * @typedef {{rules: string[]}} RulebookRequest
 * @typedef {{
 *   status: "registered" | "retracted" | "unchanged",
 *   product_id: string,
 *   version_id: string | null,
 *   version: number | null,
 *   content_sha256: string | null,
 *   parent_sha256: string | null,
 *   rule_count: number,
 * }} RulebookReceipt
 */
export const RULEBOOK_RECEIPT_KEYS = Object.freeze([
  "status", "product_id", "version_id", "version", "content_sha256",
  "parent_sha256", "rule_count",
]);

/** What a registration did, in the schema's enum order. */
export const RULEBOOK_RECEIPT_STATUSES = Object.freeze([
  "registered", "retracted", "unchanged",
]);

/**
 * The body of `POST /agents/{id}/rulebook`, or a `ContractError` before
 * anything is sent.
 *
 * STRINGS ONLY, IN ORDER: a rule's id is derived from its text by the control
 * plane, never authored here, and the list is the rulebook as written.
 *
 * SHAPE ONLY. What makes a rule acceptable -- its length, a duplicate, JSON
 * text, a control character, a credential value, how many there may be -- is
 * the control plane's to decide, and it refuses by cause and rule index. A
 * second copy of those bounds here would be one more thing to drift, so this
 * refuses only what cannot be a list of rules at all.
 *
 * @returns {RulebookRequest}
 */
export function rulebookRequestToWire(rules) {
  if (!Array.isArray(rules)) {
    const hint = typeof rules === "string"
      ? " (a single string is one rule: pass it inside a list)"
      : "";
    throw new ContractError(
      "rules must be a list of strings, one rule per string; got " +
      `${jsonType(rules)}${hint}`,
    );
  }
  rules.forEach((rule, index) => {
    if (typeof rule !== "string") {
      throw new ContractError(
        `rule ${index} must be a string; got ${jsonType(rule)}`,
      );
    }
  });
  return { rules: [...rules] };
}

/**
 * The control plane's receipt, checked against the contract, or a
 * `ContractError` naming what it lacks or carries wrongly. A key the contract
 * does not declare is dropped, not refused -- a newer control plane may say
 * more.
 *
 * @returns {RulebookReceipt}
 */
export function rulebookReceiptFromWire(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ContractError("a rulebook receipt must be a JSON object");
  }
  const missing = RULEBOOK_RECEIPT_KEYS.filter((key) => !Object.hasOwn(raw, key));
  if (missing.length) {
    throw new ContractError(
      `RulebookReceipt missing required field(s): ${pyList(missing)}`,
    );
  }
  const nullableSha = (v) => v === null || isLowerSha256(v);
  const wrong = [
    ["status", RULEBOOK_RECEIPT_STATUSES.includes(raw.status)],
    ["product_id", typeof raw.product_id === "string" && raw.product_id !== ""],
    ["version_id", raw.version_id === null || typeof raw.version_id === "string"],
    ["version", raw.version === null
      || (Number.isInteger(raw.version) && raw.version >= 1)],
    ["content_sha256", nullableSha(raw.content_sha256)],
    ["parent_sha256", nullableSha(raw.parent_sha256)],
    ["rule_count", Number.isInteger(raw.rule_count) && raw.rule_count >= 0],
  ].filter(([, ok]) => !ok).map(([key]) => key);
  if (wrong.length) {
    throw new ContractError(
      `RulebookReceipt carries invalid field(s): ${pyList(wrong)}`,
    );
  }
  return Object.fromEntries(RULEBOOK_RECEIPT_KEYS.map((key) => [key, raw[key]]));
}

/** A list of field names as Python prints one, so both SDKs say it alike. */
const pyList = (names) => `[${names.map((n) => `'${n}'`).join(", ")}]`;
