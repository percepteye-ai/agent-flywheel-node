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
import { jsonType, pythonJson } from "./declaration.js";
import { IDENTITY_FIELDS } from "./evidence.js";
import { isLowerSha256 } from "./execution-identity.js";

export const CONTRACT_VERSION = "flywheel/1";

/** Runtime mirrors of the production-turn limits published by the schema. */
export const PRODUCTION_IDENTIFIER_MAX_CHARS = 255;
export const PRODUCTION_TURN_BATCH_MAX_ITEMS = 64;

/**
 * The published identifier patterns, the strings `schema/flywheel-1.json`
 * carries and the Python SDK's `contract.py` compiles -- ONE ANSWER IN EVERY
 * ENGINE THAT READS THEM. So no `.`: ECMA-262's does not match U+2028/U+2029
 * and Python's does, which let `"a\u2028 "` and `"a\u2028/b"` through here
 * while Python refused them; `[\s\S]` is "any character" in both. And no
 * `\s`: ECMA's includes U+FEFF and Python's does not, so the whitespace an id
 * may not start or end with is spelled out as ECMA's set.
 */
const EDGE_WHITESPACE =
  "[\\t-\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]";
export const PRODUCTION_IDENTIFIER_PATTERN =
  `^(?!${EDGE_WHITESPACE})(?![\\s\\S]*${EDGE_WHITESPACE}$)` +
  "[^\\u0000-\\u001F\\u007F-\\u009F]+$";
export const PRODUCTION_TURN_IDENTIFIER_PATTERN =
  `^(?!\\.{1,2}$)(?!${EDGE_WHITESPACE})(?![\\s\\S]*${EDGE_WHITESPACE}$)` +
  "(?![\\s\\S]*[\\\\/])[^\\u0000-\\u001F\\u007F-\\u009F]+$";
/**
 * The schema's `task_id` pattern: as much of `productionTaskIdentifier`'s
 * rule as an ECMA-262 pattern can name in every engine. The predicate below,
 * not this, is what the SDK applies; this is what a schema validator applies.
 */
export const TASK_IDENTIFIER_PATTERN =
  "^(?! )(?![\\s\\S]* $)" +
  "[^\\u0000-\\u001F\\u007F-\\u00A0\\u00AD\\u0378\\u0379\\u0600-\\u0605\\u061C" +
  "\\u06DD\\u070F\\u1680\\u180E\\u2000-\\u200F\\u2028-\\u202F\\u205F-\\u206F" +
  "\\u3000\\uE000-\\uF8FF\\uFEFF\\uFFF9-\\uFFFB]+$";
const PRODUCTION_IDENTIFIER_RE = new RegExp(PRODUCTION_IDENTIFIER_PATTERN, "u");
const PRODUCTION_TURN_IDENTIFIER_RE = new RegExp(PRODUCTION_TURN_IDENTIFIER_PATTERN, "u");
/**
 * A character Python's `str.isprintable()` refuses: every "Other" category
 * (control, format, surrogate, private use, unassigned) and every separator
 * but the ASCII space.
 */
const NOT_PRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/u;

function withinProductionIdentifierLimit(value) {
  // Python's len() and JSON Schema's maxLength count Unicode code points,
  // whereas JavaScript's String.length counts UTF-16 code units.
  return [...value].length <= PRODUCTION_IDENTIFIER_MAX_CHARS;
}

/**
 * A string with a LONE SURROGATE is not Unicode text a JSON parser takes:
 * `JSON.stringify` escapes it, and the control plane refuses the whole batch
 * (422), after which the split drops the record. Refused at the call instead,
 * so what is refused at the call and at the wire cannot differ. The Python
 * SDK's `contract._well_formed_text`.
 */
function wellFormedText(value) {
  return value.isWellFormed();
}

/** Return an exact opaque production correlation id, or null. Never rewrite. */
export function productionIdentifier(value) {
  return typeof value === "string"
    && value.length > 0
    && wellFormedText(value)
    && withinProductionIdentifierLimit(value)
    && PRODUCTION_IDENTIFIER_RE.test(value)
    ? value
    : null;
}

/** Return an exact production id that is also one safe path segment. */
export function productionTurnIdentifier(value) {
  return typeof value === "string"
    && value.length > 0
    && wellFormedText(value)
    && withinProductionIdentifierLimit(value)
    && PRODUCTION_TURN_IDENTIFIER_RE.test(value)
    ? value
    : null;
}

/**
 * A task id the control plane accepts, or null. THE CONTROL PLANE'S PREDICATE,
 * MIRRORED EXACTLY (Mission Control's `is_canonical_task_id`, and the Python
 * SDK's `contract._task_identifier`): a non-empty string of at most 255
 * characters, equal to its own Python `strip()`, every character
 * `str.isprintable()`. The shared identifier grammar let U+200B, U+2028,
 * U+00AD, U+FEFF, U+00A0, unassigned and private-use code points through,
 * and each 422'd the WHOLE turn batch it rode in. A failing id is OMITTED,
 * as an invalid one always was -- never rewritten.
 */
export function productionTaskIdentifier(value) {
  return typeof value === "string"
    && value.length > 0
    && wellFormedText(value)
    && withinProductionIdentifierLimit(value)
    && !value.startsWith(" ") && !value.endsWith(" ")
    && !NOT_PRINTABLE_RE.test(value)
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
  "agent_fingerprint", "exclusion", "checks", "checks_dropped",
  "termination", "seeds",
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
 * outside the closed vocabulary, no turn, conversation or episode to attach it
 * to, an id, number, note or time the published schema refuses. The Python SDK's
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
 * `reportTurnFeedback` was handed something the feedback wire cannot carry: a
 * word outside the closed vocabulary (the message names the allowed ones), an
 * episode id or turn index that is none, or a time the published schema
 * refuses. The Python SDK's `InvalidFeedback`. Thrown BEFORE anything is
 * stored or sent.
 */
export class InvalidFeedback extends ContractError {
  constructor(message) {
    super(message);
    this.name = "InvalidFeedback";
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
  "outcome_id", "outcome", "turn_id", "conversation_id", "episode_id",
  "value", "note", "occurred_at",
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
  if (present(wire.episode_id)) {
    // The `rolloutId` the platform handed the agent with the episode.
    if (productionIdentifier(wire.episode_id) === null) {
      throw new InvalidOutcome("episode_id is not a valid identifier");
    }
    out.episode_id = wire.episode_id;
  }
  if (!("turn_id" in out) && !("conversation_id" in out) && !("episode_id" in out)) {
    throw new InvalidOutcome(
      "an outcome names the turn_id, the conversation_id or the episode_id " +
      "it is the outcome of");
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
    if (!wellFormedText(wire.note)) {
      throw new InvalidOutcome("note must be well-formed Unicode text");
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
 * Whether a reported outcome names an episode and nothing else. Such an
 * outcome is about a platform-run episode, not the agent's end users'
 * traffic, so it is sent without the production-capture consent a turn's or a
 * conversation's outcome needs. The Python SDK's `names_only_an_episode`.
 */
export function namesOnlyAnEpisode(outcome) {
  return "episode_id" in outcome && !("turn_id" in outcome)
    && !("conversation_id" in outcome);
}

/**
 * THE closed vocabulary of `reportTurnFeedback`: what the user did with one
 * turn. Asserted verbatim against `schema/flywheel-1.json`
 * (`TurnFeedback.signal`); the Python SDK's `TURN_FEEDBACK_SIGNALS`.
 */
export const TURN_FEEDBACK_SIGNALS = Object.freeze([
  "accepted", "corrected", "repeated", "escalated", "abandoned",
]);
/** A turn index is a position inside one episode (the schema's `maximum`). */
export const TURN_FEEDBACK_TURN_INDEX_MAX = 100000;
export const TURN_FEEDBACK_BATCH_MAX_ITEMS = 64;
const FEEDBACK_WIRE_KEYS = new Set([
  "feedback_id", "episode_id", "turn_index", "signal", "occurred_at",
]);
/** Either way of naming the turn: an episode's, or a production turn's. */
const FEEDBACK_OR_TURN_KEYS = new Set([...FEEDBACK_WIRE_KEYS, "turn_id"]);
/** A report that names its turn both ways. */
const NAMES_ONE_TURN =
  "feedback names one turn: a production turn's turn_id, or an episode's " +
  "episode_id and turn_index, not both";

/**
 * One per-turn feedback report exactly as the wire carries it, or
 * `InvalidFeedback` naming what is wrong.
 *
 * It names ONE turn: an episode's `episode_id` and `turn_index`, or a
 * production turn's `turn_id` (then `{feedback_id, turn_id, signal,
 * occurred_at}`, `turnFeedbackOnASpan`'s rules).
 *
 * THE one validator, as `productionOutcome` is for outcomes:
 * `reportTurnFeedback` builds its record through it and the transport passes
 * every report through it again before a batch leaves. The Python SDK's
 * `turn_feedback`, rule for rule and message for message.
 */
export function turnFeedback(wire) {
  const signal = feedbackHead(wire, FEEDBACK_OR_TURN_KEYS);
  if (wire.turn_id !== undefined && wire.turn_id !== null) {
    // A PRODUCTION TURN, named by its own id in place of an episode and a
    // position (design 2026-11-21, contract A).
    if ((wire.episode_id !== undefined && wire.episode_id !== null)
        || (wire.turn_index !== undefined && wire.turn_index !== null)) {
      throw new InvalidFeedback(NAMES_ONE_TURN);
    }
    return turnFeedbackOnASpan(Object.fromEntries(
      [...SPAN_FEEDBACK_KEYS].filter((k) => k in wire).map((k) => [k, wire[k]])));
  }
  if (productionIdentifier(wire.episode_id) === null) {
    throw new InvalidFeedback("episode_id is not a valid identifier");
  }
  const turnIndex = wire.turn_index;
  if (
    typeof turnIndex !== "number" || !Number.isInteger(turnIndex)
    || turnIndex < 0 || turnIndex > TURN_FEEDBACK_TURN_INDEX_MAX
  ) {
    throw new InvalidFeedback(
      `turn_index must be a whole number from 0 to ${TURN_FEEDBACK_TURN_INDEX_MAX}`);
  }
  feedbackTime(wire);
  return {
    feedback_id: wire.feedback_id, episode_id: wire.episode_id,
    turn_index: turnIndex, signal, occurred_at: wire.occurred_at,
  };
}

/**
 * The checks every per-turn feedback report shares, in their order -- an
 * object, no field outside `keys`, a `signal` from the vocabulary, a
 * `feedback_id` -- and the signal. The Python SDK's `_feedback_head`.
 */
function feedbackHead(wire, keys) {
  if (!wire || typeof wire !== "object" || Array.isArray(wire)) {
    throw new InvalidFeedback(`feedback must be an object, got ${jsonType(wire)}`);
  }
  const unknown = Object.keys(wire).filter((k) => !keys.has(k)).sort();
  if (unknown.length) {
    throw new InvalidFeedback(`feedback has no field ${JSON.stringify(unknown[0])}`);
  }
  const { signal } = wire;
  if (typeof signal !== "string" || !TURN_FEEDBACK_SIGNALS.includes(signal)) {
    const got = typeof signal === "string" ? JSON.stringify(signal) : jsonType(signal ?? null);
    throw new InvalidFeedback(
      `signal must be one of ${TURN_FEEDBACK_SIGNALS.join(", ")}; got ${got}`);
  }
  if (productionTurnIdentifier(wire.feedback_id) === null) {
    throw new InvalidFeedback("feedback_id is not a valid identifier");
  }
  return signal;
}

function feedbackTime(wire) {
  if (!isRfc3339Instant(wire.occurred_at)) {
    throw new InvalidFeedback(
      "occurred_at must be an RFC 3339 time with its offset, such as " +
      "2026-11-10T09:00:00Z");
  }
}

/**
 * What feedback on a PRODUCTION TURN carries: the turn's own id in place of
 * an episode and a position. Sent to `POST /turn-feedback` (which takes
 * either), and recorded as an event on that turn's trace.
 */
const SPAN_FEEDBACK_KEYS = new Set(["feedback_id", "turn_id", "signal", "occurred_at"]);

/**
 * Per-turn feedback on a production turn, `{feedback_id, turn_id, signal,
 * occurred_at}`, or `InvalidFeedback` naming what is wrong: `turnFeedback`'s
 * vocabulary, ids and time, with the turn named by the `turn_id` its span
 * carries (`percepteye.turn.id`). What `recordTurnFeedbackSpan` emits. The
 * Python SDK's `contract.turn_feedback_on_a_span`, same rules, same messages.
 */
export function turnFeedbackOnASpan(wire) {
  const signal = feedbackHead(wire, SPAN_FEEDBACK_KEYS);
  if (productionTurnIdentifier(wire.turn_id) === null) {
    throw new InvalidFeedback("turn_id is not a valid turn identifier");
  }
  feedbackTime(wire);
  return {
    feedback_id: wire.feedback_id, turn_id: wire.turn_id, signal,
    occurred_at: wire.occurred_at,
  };
}

/**
 * An RFC 3339 instant (one `isRfc3339Instant` takes) as Unix nanoseconds, a
 * BigInt, exactly: the fraction's first nine digits, the offset applied. What
 * an OTel event's `timeUnixNano` carries. The Python SDK's
 * `contract.rfc3339_unix_nanos`.
 */
export function rfc3339UnixNanos(value) {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?(Z|([+-])([0-9]{2}):([0-9]{2}))$/
    .exec(String(value));
  if (m === null) {
    throw new InvalidFeedback(
      "occurred_at must be an RFC 3339 time with its offset, such as " +
      "2026-11-10T09:00:00Z");
  }
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number);
  // setUTCFullYear, not Date.UTC: Date.UTC reads a year below 100 as 19xx.
  const at = new Date(0);
  at.setUTCFullYear(y, mo - 1, d);
  at.setUTCHours(h, mi, sec, 0);
  let seconds = BigInt(at.getTime() / 1000);
  if (m[8] !== "Z") {
    const offset = BigInt(Number(m[10]) * 3600 + Number(m[11]) * 60);
    seconds -= m[9] === "+" ? offset : -offset;
  }
  const fraction = BigInt(`${m[7] ?? ""}000000000`.slice(0, 9));
  return seconds * 1_000_000_000n + fraction;
}

/** The longest rollout id accepted: the Python SDK's `_PATH_SEGMENT_MAX_CHARS`. */
export const ROLLOUT_ID_MAX_CHARS = 256;

/**
 * Why `value` cannot be a rollout id, or null when it can. The id goes into
 * every request path this lane makes (heartbeat, report, abandon) and names
 * a session and an outbox file, so it must be ONE path segment: refused are a
 * non-string, an empty string, `.` and `..` (a proxy that normalises the path
 * moves the request to a different route), a `/` or `\\` (a second segment),
 * a control character, a lone surrogate, and more than
 * `ROLLOUT_ID_MAX_CHARS` characters. The Python SDK's `_path_segment` rule.
 */
export function rolloutIdRefusal(value) {
  if (typeof value !== "string") {
    return `rollout_id must be a string, got ${jsonType(value)}`;
  }
  if (!value) return "rollout_id must not be empty";
  if (value === "." || value === "..") {
    return `rollout_id ${JSON.stringify(value)} is a dot segment, not an id`;
  }
  if (value.includes("/") || value.includes("\\")) {
    return `rollout_id must not contain a path separator, got ${JSON.stringify(value)}`;
  }
  if (/[\u0000-\u001F\u007F-\u009F]/u.test(value)) {
    return `rollout_id must not contain a control character, got ${JSON.stringify(value)}`;
  }
  if (!wellFormedText(value)) return "rollout_id must be well-formed Unicode text";
  const length = [...value].length;
  if (length > ROLLOUT_ID_MAX_CHARS) {
    return `rollout_id must be at most ${ROLLOUT_ID_MAX_CHARS} characters, got ${length}`;
  }
  return null;
}

/** The fields a claimed rollout must carry: `contract.py RolloutRequest.from_wire`. */
export const ROLLOUT_REQUEST_REQUIRED = Object.freeze([
  "rollout_id", "turn_input", "llm_url", "api_key", "artifacts_dir", "deadline_ts",
]);

/**
 * One rollout, as the control plane handed it to us.
 *
 * Field names are the SERVER's, not ours -- renaming them here would put a
 * translation layer between two things that must agree exactly. Refused, as
 * the Python SDK's `RolloutRequest.from_wire` refuses them: a missing
 * required field (an `llm_url` and `api_key` above all -- a rollout with no
 * gateway to sample through cannot be run as the checkpoint being trained),
 * an `environment` key (that channel was removed: configuration never
 * reaches a running process by payload), and a rollout id that is not one
 * path segment.
 */
export function rolloutRequestFromWire(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ContractError("rollout payload is not an object");
  }
  const missing = ROLLOUT_REQUEST_REQUIRED.filter((key) => !Object.hasOwn(raw, key));
  if (missing.length) {
    throw new ContractError(
      `RolloutRequest missing required field(s): ${pyList(missing)}`,
    );
  }
  if (Object.hasOwn(raw, "environment")) {
    throw new ContractError(
      "RolloutRequest carries an 'environment' key. This channel was " +
      "removed: configuration reaches the agent through subprocess env at " +
      "spawn, never by mutating a running process.",
    );
  }
  const idRefusal = rolloutIdRefusal(raw.rollout_id);
  if (idRefusal) throw new ContractError(idRefusal);
  const deadlineTs = Number(raw.deadline_ts);
  if (!Number.isFinite(deadlineTs)) {
    throw new ContractError("RolloutRequest deadline_ts must be a number");
  }
  const leaseExpiresTs = raw.lease_expires_ts;
  const metadata = isObject(raw.metadata) ? raw.metadata : {};
  return {
    rolloutId: raw.rollout_id,
    turnInput: String(raw.turn_input ?? ""),
    llmUrl: String(raw.llm_url ?? ""),
    apiKey: String(raw.api_key ?? ""),
    artifactsDir: String(raw.artifacts_dir ?? ""),
    deadlineTs,
    leaseToken: raw.lease_token ?? null,
    leaseExpiresTs: leaseExpiresTs !== null && leaseExpiresTs !== undefined
      && Number.isFinite(Number(leaseExpiresTs))
      ? Number(leaseExpiresTs)
      : null,
    metadata,
    // The task this rollout was handed, by the id it was claimed under -- for
    // a task the customer registered, THEIR id (Python: `current_task_id()`).
    // Only one the control plane's own task-id rule accepts; anything else
    // is absent, never rewritten.
    taskId: productionTaskIdentifier(metadata.task_id),
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
 *
 * AT MOST `MAX_REPORTED_CHECKS` ROWS, THE FIRST ONES. A longer list used to
 * be refused whole, which cost the episode every check it ran for stating
 * one too many. The rows past the limit are not carried and not read;
 * `checksOverLimit` counts them, and the report states the count as
 * `checks_dropped` (`rolloutOutputToWire`).
 */
export function checksToWire(checks) {
  if (!Array.isArray(checks)) throw new ContractError("checks must be a list");
  return checks.slice(0, MAX_REPORTED_CHECKS).map((row, i) => {
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

/**
 * How many of `checks` `checksToWire` leaves behind: the rows past
 * `MAX_REPORTED_CHECKS`. 0 for anything that is not a list.
 */
export function checksOverLimit(checks) {
  return Array.isArray(checks)
    ? Math.max(checks.length - MAX_REPORTED_CHECKS, 0) : 0;
}

/** A count of dropped checks an output states: a positive whole number, else 0. */
function statedDropped(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * `checks_dropped` for a report that carries NONE of `output`'s checks: every
 * row the episode ran, and the ones it already counted as dropped. The one
 * evidence part with a place on the wire to say it went missing. Never throws.
 */
export function checksNotCarried(output) {
  return (Array.isArray(output?.checks) ? output.checks.length : 0)
    + statedDropped(output?.checksDropped);
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

/**
 * The wire form of the seeds the episode ran under: `{environment, sampling}`,
 * each an integer or a short string.
 *
 * ONE RULE WITH THE PYTHON SDK's `seeds_to_wire`, which reads the same
 * `outcome.json`: a string is 1 to 128 characters; an integer is one a JSON
 * number carries exactly in every language (`Number.isSafeInteger`). A
 * boolean, a fraction, NaN and a larger integer are refused. The Python
 * suite drives one table through both (`tests/test_reported_outcome_parity.py`).
 */
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

/**
 * What an agent's own environment stated about the episode in
 * `$PERCEPTEYE_TRAJECTORY_DIR/outcome.json`, as output fields:
 * `{reward, success, checks, checksDropped, termination, seeds}`, each present
 * only when the file states it well-formed. `data` is the parsed file.
 *
 * THE PYTHON SDK READS THE SAME FILE BY THE SAME RULES
 * (`runner.py _attach_reported_outcome`), and its suite drives one table of
 * files through both (`tests/test_reported_outcome_parity.py`). Only a finite
 * number is a reward and only a boolean a success; anything else is ignored,
 * never coerced. Each evidence part is kept when well-formed and ignored
 * whole when not -- a malformed part must not cost the episode its report.
 * More checks than a report carries is not malformed: the first are kept and
 * the rest counted. Never throws.
 */
export function reportedOutcome(data) {
  const stated = {};
  if (!isObject(data)) return stated;
  if (typeof data.reward === "number" && Number.isFinite(data.reward)) {
    stated.reward = data.reward;
  }
  if (typeof data.success === "boolean") stated.success = data.success;
  for (const [name, toWire] of [
    ["checks", checksToWire], ["termination", terminationToWire],
    ["seeds", seedsToWire],
  ]) {
    if (data[name] === undefined || data[name] === null) continue;
    let part;
    try {
      part = toWire(data[name]);
    } catch {
      continue;
    }
    if (!(Array.isArray(part) ? part.length : Object.keys(part).length)) continue;
    stated[name] = part;
    if (name === "checks") {
      const over = checksOverLimit(data[name]);
      if (over) stated.checksDropped = over;
    }
  }
  return stated;
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
    wire.tool_calls = output.toolCalls.map(toolCallToWire);
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

  // A boolean is not a reward and NaN or infinity are not JSON: the first
  // would train as 1/0, the second is refused by the control plane as the
  // whole report. `contract.py RolloutOutput.to_wire`'s refusal.
  if (output.reward !== undefined && output.reward !== null
      && !(typeof output.reward === "number" && Number.isFinite(output.reward))) {
    throw new ContractError(
      `reward must be a finite number or null, got ${String(output.reward)}`);
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

  // `checks_dropped`: how many checks the episode ran that this report does
  // not carry -- what the output already counted, plus the rows past the
  // limit here. Present only when positive.
  let dropped = statedDropped(output.checksDropped);
  if (Array.isArray(output.checks) ? output.checks.length : output.checks != null) {
    wire.checks = checksToWire(output.checks);
    dropped += checksOverLimit(output.checks);
  }
  if (dropped) wire.checks_dropped = dropped;
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

/** Keys that carry a machine-readable status: `contract.py _STATUS_KEYS`,
 *  compared lowercased, so `Status`, `STATUS_CODE` and `statusCode` are all
 *  found -- a body's own spelling is the server's choice, not ours. */
const STATUS_KEYS = new Set(["status_code", "status", "http_status", "code", "statuscode"]);
/**
 * An HTTP status spelled in text -- `HTTP 200`, and the status line's own
 * spelling, `HTTP/1.1 200`, `HTTP/2 200`: `contract.py _HTTP_IN_TEXT`, the
 * same pattern character for character. ASCII classes only (`[0-9]`, the
 * six ASCII spaces), so Python's `re` and ECMA-262 match the same strings.
 */
const HTTP_IN_TEXT = /\bHTTP(?:\/[0-9](?:\.[0-9])?)?[\t\n\v\f\r ]*[0-9]{3}\b/gi;

/**
 * JSON text as a value, with the three constants Python's `json` reads and
 * writes for a non-finite number -- `NaN`, `Infinity`, `-Infinity` -- read
 * as `null` (how `JSON.stringify` spells them, and how the Python SDK's
 * readers map them). Throws on anything else that is not JSON. Strings are
 * matched first and kept, so a constant's name inside one is left alone.
 */
export function parseJsonWithConstants(text) {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(text.replace(
      /"(?:[^"\\]|\\.)*"|-?\bInfinity\b|\bNaN\b/g,
      (found) => (found[0] === '"' ? found : "null"),
    ));
  }
}

/**
 * Remove machine-readable status from a tool result body: the Python SDK's
 * `contract._scrub_status`, rule for rule.
 *
 * EVERY STRING IS READ THE SAME WAY, wherever it sits: one that parses as a
 * JSON object or array is scrubbed as that body and written back as JSON --
 * an object's `{"body": "{\"status_code\": 200}"}` included, which used to
 * keep its status -- and any other (prose, or a JSON scalar) loses its
 * `HTTP 200` / `HTTP/1.1 200`. An object loses every status key, compared
 * lowercased; a list is scrubbed item by item. Everything else is kept.
 *
 * WRITTEN BACK AS PYTHON WRITES IT (`pythonJson`: `json.dumps`'s ", " and
 * ": ", non-ASCII escaped), so both SDKs send the same bytes for the same
 * body -- except where `JSON.parse` has already lost what Python keeps: a
 * float's spelling (12.0 reads as 12), an integer past 2^53, and the order
 * of integer-like keys (an object lists them first).
 */
export function scrubStatus(output) {
  if (typeof output === "string") {
    let body = null;
    try {
      body = parseJsonWithConstants(output);
    } catch {
      body = null;
    }
    if (body !== null && typeof body === "object") return pythonJson(scrubStatus(body));
    return output.replace(HTTP_IN_TEXT, "");
  }
  if (Array.isArray(output)) return output.map(scrubStatus);
  if (isObject(output)) {
    const out = {};
    for (const [key, value] of Object.entries(output)) {
      if (STATUS_KEYS.has(String(key).toLowerCase())) continue;
      out[key] = scrubStatus(value);
    }
    return out;
  }
  return output;
}

/**
 * A tool call's `entity_ids` under the field names they were validated as:
 * each key trimmed and lowercased, which must be a high-entropy identity
 * field (`IDENTITY_FIELDS`), each value a non-empty string, and no field
 * named twice in two spellings. `contract.py ToolCallOutcome`'s rule: the
 * schema's key enum is lowercase, so `{"ID": ...}` was sent and refused
 * there. Throws `ContractError` naming what is wrong.
 */
function entityIdsToWire(entityIds) {
  if (!isObject(entityIds)) {
    throw new ContractError(
      `tool call entity_ids must be an object, got ${jsonType(entityIds)}`);
  }
  const out = {};
  for (const [key, value] of Object.entries(entityIds)) {
    const name = String(key).trim().toLowerCase();
    if (!IDENTITY_FIELDS.has(name)) {
      throw new ContractError(
        `tool call entity_ids key ${JSON.stringify(key)} is not a high-entropy ` +
        `identity field (${[...IDENTITY_FIELDS].join(", ")})`);
    }
    if (typeof value !== "string" || !value.trim()) {
      throw new ContractError(
        `tool call entity_ids[${JSON.stringify(key)}] must be a non-empty string`);
    }
    if (Object.hasOwn(out, name)) {
      throw new ContractError(
        `tool call entity_ids names the identity field ${JSON.stringify(name)} ` +
        `twice (${JSON.stringify(key)} and another spelling)`);
    }
    out[name] = value;
  }
  return out;
}

/**
 * One recorded tool call as the wire carries it, or a `ContractError`: what
 * `contract.py ToolCallOutcome` makes of a record. ONE RULE FOR EVERY PATH a
 * tool call leaves by -- `readTrajectory` (production turns and rollouts
 * alike, where a refused row is counted malformed, as Python's
 * `Trajectory.read` counts it) and `rolloutOutputToWire`.
 *
 * An `unknown` outcome carries NO status, in the field or in the body:
 * `status_code` is null and `output` goes through `scrubStatus`, so a scorer
 * cannot recover a verdict from the envelope of a call whose result was
 * never seen. `entity_ids` leave under their canonical names
 * (`entityIdsToWire`) and are never scrubbed: an identity claims nothing
 * about the outcome.
 */
export function toolCallToWire(call) {
  if (!isObject(call)) {
    throw new ContractError(`a tool call must be an object, got ${jsonType(call)}`);
  }
  const out = { ...call };
  if ("environment" in out) {
    // `contract.py` refuses this outright: the environment is the control
    // plane's fact about the rollout, not the agent's to assert.
    throw new ContractError("tool call may not carry an 'environment' field");
  }
  if (out.entity_ids !== undefined && out.entity_ids !== null) {
    const ids = entityIdsToWire(out.entity_ids);
    if (Object.keys(ids).length) out.entity_ids = ids;
    else delete out.entity_ids;
  }
  if (out.outcome === "unknown") {
    out.status_code = null;
    if (out.output !== undefined && out.output !== null) {
      out.output = scrubStatus(out.output);
    }
    // Not contract keys, and never written by this SDK's recorder; a caller
    // that put a raw response on a call loses it rather than carrying it.
    delete out.body;
    delete out.response;
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
