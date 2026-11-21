/**
 * PRODUCTION MODE: capture the turns this agent is already serving, and -- with
 * the operator's consent -- upload them.
 *
 * This is the production half of the package, and it is the mirror of the
 * Python SDK's `attach()`. Same on-disk format (see `turns.js`), same wire
 * shape, same consent rule, same cadence. A customer runs one package or the
 * other, so "same" has to mean the same, not similar.
 *
 * ── WHAT A TURN IS BUILT FROM, AND WHAT EACH PART COSTS ───────────────────
 *
 *   the user's message  `message_received`   UNGATED, void-returning. Also
 *                                            carries the UPLOAD CADENCE, for
 *                                            exactly the reason below.
 *   the tool calls      `after_tool_call`    UNGATED, void-returning. Already
 *                                            recorded; only the routing is new.
 *   the answer          `agent_end`          CONVERSATION-GATED. Dropped for a
 *                                            non-bundled plugin unless the
 *                                            operator sets
 *                                            `allowConversationAccess=true`.
 *
 * NOTHING PERIODIC MAY HANG OFF THE GATED HOOK. The cadence counter used to
 * live on `agent_end`, which meant that in the default install -- the one this
 * file spends two paragraphs describing -- it never advanced, and the only
 * other trigger is shutdown, which a gateway that keeps running never reaches.
 * A long-lived install uploaded nothing, ever, while the startup log told the
 * operator its turns were being uploaded. Python counts in `turn()`, the
 * turn-OPENING path, and this now matches it.
 *
 * `before_agent_finalize` carries more -- sessionKey, turnId and
 * lastAssistantMessage in one event -- and is deliberately NOT used. Its result
 * type accepts `action: "revise"` and a `retry` instruction, so it is a
 * MUTATION seam: a handler there can send the agent round again. This package's
 * first rule is that capturing evidence must never be able to change the
 * behaviour being measured, and a recorder on a mutation seam breaks it whether
 * or not it currently returns undefined.
 *
 * SO A DEFAULT INSTALL CAPTURES A TURN WITHOUT ITS ANSWER, and that is a
 * designed-for state rather than a gap: the intake documents `final_text: null`
 * as "an ordinary state, not an error", stores the turn, grades it advisory
 * with an explicit reason, and excludes it from objectives that need a
 * completion. The plugin says once, at startup, which half it is missing and
 * what to set -- because a customer who sees turns arriving with no answers
 * deserves the cause, not a mystery.
 *
 * And such a turn IS UPLOADED. "Hold back a turn with no answer, one may still
 * be coming" is only true where answers come at all; where the host drops
 * `agent_end` there is no answer coming for any turn, and holding them back is
 * holding them back forever. See `createTurnUploader({answersExpected})`.
 *
 * ── WHERE `message_received` DOES AND DOES NOT FIRE ───────────────────────
 *
 * It is emitted from the inbound CHANNEL dispatch path
 * (`dispatch-DnzGTpPs.js:1436`), so it covers an agent served over Slack,
 * WhatsApp, Discord and the like -- which is the population production turn
 * capture is for. It does NOT fire for a local terminal session. A turn with
 * tool calls and an answer but no `input_text` is still uploaded: the intake
 * accepts a null input for the same reason it accepts a null answer, and
 * inventing the user's message from the model's prompt would be manufacturing
 * the one field we cannot observe.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync,
  statSync, unlinkSync, writeFileSync,
} from "node:fs";
import {
  mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { GET_A_KEY } from "./config.js";
import {
  applyDeclaration,
  declarationRegistrationFields,
} from "./declaration.js";
import { OPENCLAW_HOST } from "./describe.js";
import { nowUnixNano } from "./genai-otlp.js";
import {
  conversationAccessGranted, conversationIdOf, lastAssistantText, taskIdOf,
} from "./host.js";
import { ControlPlaneClient, SDK_UA } from "./http.js";
import { inputFromLlmInput, operationsFromRun } from "./model-boundary.js";
import { pathSegment } from "./outbox.js";
import { resolveServedAgent, scopeDecision } from "./scope.js";
import { percepteyeHome } from "./session.js";
import {
  AttachTransport, declareRulebook, rulesNeverSent, sentence,
} from "./transport.js";
import {
  CONTRACT_VERSION, InvalidFeedback, InvalidOutcome,
  PRODUCTION_OUTCOME_BATCH_MAX_ITEMS, TURN_FEEDBACK_BATCH_MAX_ITEMS,
  namesOnlyAnEpisode, productionOutcome, rfc3339UnixNanos, turnFeedback,
  turnFeedbackOnASpan,
} from "./wire.js";
import { recordTurnFeedbackSpan } from "./tracing.js";
import { TOOL_CALLS_FILENAME } from "./trajectory.js";
import {
  CONVERSATION_ID_FILENAME, TURNS_FILENAME,
  lastWrittenAt, listTurnDirs, readConversationId, readModelBoundary,
  readTaskId, recordConversationId,
  recordModelBoundary, recordModelBoundaryEnd, recordModelOperation,
  recordTaskId, recordTurnText,
  recordExecutionFingerprint, recordExecutionFingerprintConflict, safeTurnId,
  scanTurns, turnDir, turnIndices, turnWire,
} from "./turns.js";

/**
 * Replace `path` with `data` atomically: a unique temp file (pid + random)
 * renamed over it, so a reader -- or a second process -- sees the old bytes
 * or the new, never a truncated file, and two writers never share one temp
 * name (`${path}.tmp` was fixed). Throws; callers decide what a failure costs.
 */
function replaceFile(path, data) {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never written */ }
    throw err;
  }
}

/** `replaceFile`, off the event loop, for the flush path. */
async function replaceFileAsync(path, data) {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, data, "utf8");
    await rename(tmp, path);
  } catch (err) {
    try { await unlink(tmp); } catch { /* never written */ }
    throw err;
  }
}

/** Give the event loop a turn: what was waiting runs before what follows. */
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/** Turns between automatic upload attempts. The Python SDK's `_FLUSH_EVERY`. */
export const FLUSH_EVERY = 32;

/**
 * The most bytes of model input the turn store holds for runs whose
 * `agent_end` has not arrived: the oldest go first. One input larger than
 * this alone is not held, and its run records no model boundary.
 */
export const PENDING_INPUT_MAX_BYTES = 64 * 1024 * 1024;

/** Turns per request. The intake's `TURN_BATCH_MAX`. */
export const BATCH_SIZE = 64;

/**
 * Turns between automatic prunes when `retentionTurns` is set. The Python
 * SDK's `_PRUNE_EVERY`: one directory scan over many turns, so the ceiling is
 * `retentionTurns + PRUNE_EVERY`, not `retentionTurns` exactly -- besides the
 * turns still running, which are never pruned (`pruneTurns`'s `active`).
 */
export const PRUNE_EVERY = 256;

/**
 * `retentionTurns` as configured: `{retentionTurns, refusal}`.
 *
 * A whole number of turns, 0 or more, or `null` when unset -- the Python
 * SDK's `attach(retention_turns=...)`, which refuses anything else with the
 * same sentence. Python raises; a throw from `register()` would fail the
 * plugin load and take local capture with it, so here the value is dropped,
 * nothing is pruned, and `refusal` says why.
 */
export function retentionTurnsFrom(value) {
  if (value === undefined || value === null) {
    return { retentionTurns: null, refusal: null };
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return { retentionTurns: value, refusal: null };
  }
  return {
    retentionTurns: null,
    refusal: "retentionTurns must be a whole number of turns, 0 or more, " +
      `not ${describeValue(value)}`,
  };
}

/**
 * A configured value, said in a refusal. NEVER THROWS: `JSON.stringify`
 * throws on a BigInt and on a cyclic object, and `String` on an object with
 * no prototype -- and a throw here, inside `register()`, failed the plugin
 * load and took local capture with it.
 */
function describeValue(value) {
  if (typeof value === "bigint") return `${value}n`;
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch { /* cyclic, or holds a BigInt */ }
  try {
    return String(value);
  } catch {
    return `a value of type ${typeof value}`;
  }
}

/** Whether a turn directory holds anything an upload could carry; Python's
 *  `Attachment._holds_a_record`. Unreadable counts as held: the warning this
 *  feeds is about data about to be destroyed, so fail towards telling. */
function holdsARecord(path) {
  try {
    return turnWire(path) !== null || readModelBoundary(path) !== null;
  } catch {
    return true;
  }
}

/**
 * Delete captured turns from `root`. Returns how many.
 *
 * THE PYTHON SDK'S `Attachment.prune`, rule for rule. Capture is append-only
 * and nothing else removes it, so a long-running production gateway keeps one
 * directory per recording turn forever. Deleting is never a default: the
 * capture is the customer's data, so it happens only when they ask, with
 * `retentionTurns` or a call to `prune`.
 *
 * - `keepLast` keeps that many most recently written turns and deletes the
 *   rest; `olderThanS` deletes turns last written longer ago than that. Both
 *   may be given, and a turn goes if EITHER says so. Neither deletes nothing
 *   and returns 0: an unqualified prune is not a request to delete everything.
 * - `uploaded`, the set of turn ids the control plane already holds, is given
 *   only while uploading is on. Then already-uploaded turns are deleted FIRST:
 *   the same number goes, but a turn still waiting to be sent (one whose
 *   answer may still be coming) is kept over one that is safe at the control
 *   plane. One that does go anyway is warned about, once per prune.
 * - Never throws. A turn that cannot be removed is left and does not stop the
 *   others; retention failing must not take down the agent it protects.
 */
export function pruneTurns({
  root, keepLast = null, olderThanS = null, uploaded = null, logger = null,
  now = Date.now(), active = null,
} = {}) {
  if (keepLast === null && olderThanS === null) return 0;
  // A count that is not a whole number of turns, or an age that is not a
  // number of seconds, deletes NOTHING: `slice(NaN)` is `slice(0)`, which
  // read `keepLast: NaN` as "keep none" and deleted every turn.
  if (keepLast !== null && !(Number.isInteger(keepLast) && keepLast >= 0)) return 0;
  if (olderThanS !== null
      && !(typeof olderThanS === "number" && Number.isFinite(olderThanS)
        && olderThanS >= 0)) return 0;
  // Newest first, so "keepLast" is a slice. With uploading on, the ones not
  // yet uploaded sort ahead of the ones that were, newest first within each.
  // A turn still RUNNING (`active`, from the turn store) is never a
  // candidate: at `retentionTurns: 0` the turn whose message just arrived
  // was deleted before its tool calls and answer landed.
  const pendingFirst = (e) => (uploaded && !uploaded.has(e.name) ? 1 : 0);
  const entries = listTurnDirs(root)
    .filter((e) => !active?.has(e.name))
    .sort((a, b) => pendingFirst(b) - pendingFirst(a) || b.mtime - a.mtime);
  const doomed = [];
  if (keepLast !== null) doomed.push(...entries.slice(Math.max(0, keepLast)));
  if (olderThanS !== null) {
    // The ones `keepLast` kept, or every turn when it was not given.
    const head = keepLast === null ? entries : entries.slice(0, Math.max(0, keepLast));
    const cutoff = now - olderThanS * 1000;
    doomed.push(...head.filter((e) => e.mtime < cutoff));
  }
  const victims = [...new Set(doomed)];
  let removed = 0;
  let unsent = 0;
  for (const e of victims) {
    if (uploaded && !uploaded.has(e.name) && holdsARecord(e.path)) unsent += 1;
    try {
      rmSync(e.path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Left in place; the next prune tries again.
    }
  }
  if (unsent) {
    logger?.warn?.(
      `[agent-flywheel] retention deleted ${unsent} captured turn(s) that had ` +
      `not been uploaded -- including any still waiting on an answer, which ` +
      `the periodic upload holds back. They are gone. Raise retentionTurns, or ` +
      `check why uploads are not succeeding (the startup line says if consent ` +
      `is the reason).`);
  }
  if (removed) {
    // The upload index describes this tree, so it is bounded by this tree.
    const index = join(root, UPLOADED_INDEX);
    try {
      if (existsSync(index)) {
        const gone = new Set(victims.map((e) => e.name));
        const here = new Set(listTurnDirs(root).map((e) => e.name)
          .filter((n) => !gone.has(n)));
        const kept = readFileSync(index, "utf8").split("\n")
          .map((l) => l.trim()).filter((id) => id && here.has(id)).sort();
        replaceFile(index, kept.map((id) => `${id}\n`).join(""));
      }
    } catch { /* the index is a cache of what was sent; a resend is deduped */ }
  }
  return removed;
}

/**
 * How long an unanswered turn must sit UNTOUCHED before the cadence will send
 * it.
 *
 * Only consulted when no answer is coming at all (see `answersExpected`).
 * `final_text` is otherwise the signal that a turn is FINISHED -- the answer is
 * written after the last tool call -- so without it there is nothing left to
 * say "this one is done" except quiescence. And the cadence fires from inside
 * the handler for the NEWEST turn, whose tool calls have not been made yet: a
 * flush with no settle window would upload that turn with `tool_calls: null`,
 * mark it sent, and never send the calls it went on to make. That is a worse
 * loss than the one the cadence exists to fix.
 *
 * Shutdown does NOT wait: nothing more is coming for anything by then.
 */
export const UNANSWERED_SETTLE_MS = 5 * 60_000;

/**
 * Which turns have already been sent.
 *
 * A FILE AT THE ROOT, never inside a turn directory. Writing a marker into a
 * turn's own directory bumps that directory's MTIME -- which retention reads
 * as "most recently written", and which `turn_index` was once ordered by --
 * so uploading would have reordered what it touched. The Python SDK carries
 * the same file for the same reason; this is not a coincidence to be tidied
 * away.
 *
 * Rewritten whole and renamed into place (`replaceFile`): a reader never
 * sees it half-written. The flush marks it off the event loop (a synchronous
 * write measured stalls of 230ms under disk contention); flushes never
 * overlap, and retention's trim interleaving with a mark costs at most the
 * ids of turns already deleted, which the next trim drops. A write lost
 * across processes costs a resend, which the intake dedupes.
 */
export const UPLOADED_INDEX = ".uploaded";

/**
 * Where captured production turns live when nothing else says:
 * `<home>/captured/<agent>`, keyed by AGENT with the rule the outbox is
 * (`pathSegment`). Two installs sharing one home -- two agents on one host --
 * used to share one root, and each uploaded the other's turns and outcomes
 * under its own id and its own consent. `PERCEPTEYE_CAPTURE_DIR`, when set,
 * is the operator's exact choice and is used as given.
 */
export function captureRoot(env = process.env, agentId = null) {
  return env.PERCEPTEYE_CAPTURE_DIR
    || join(legacyCaptureRoot(env), pathSegment(agentId ?? "agent"));
}

/**
 * The unkeyed root releases before `captureRoot` was keyed by agent wrote
 * into. LEFT WHERE IT IS: whatever it holds was captured for every agent the
 * host ran under one id, so no one agent can upload it as its own -- moving
 * it under the configured agent would do exactly what keying exists to stop.
 * `registerTurnCapture` says once that it is there.
 */
export function legacyCaptureRoot(env = process.env) {
  return join(percepteyeHome(env), "captured");
}

/** Whether `legacyCaptureRoot` still holds a turn an earlier release wrote:
 * a directory with a turn's own files in it (an agent's keyed root holds
 * turn DIRECTORIES, never these). Stops at the first. Never throws. */
function legacyTurnsRemain(env) {
  try {
    for (const entry of readdirSync(legacyCaptureRoot(env), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(legacyCaptureRoot(env), entry.name);
      if ([TURNS_FILENAME, TOOL_CALLS_FILENAME, CONVERSATION_ID_FILENAME]
        .some((name) => existsSync(join(dir, name)))) return true;
    }
  } catch { /* no legacy root */ }
  return false;
}

/**
 * May captured turns be uploaded, per the control plane's own answer?
 *
 * THE SERVER DECIDES; this only reads the verdict. `capture.turns` is computed
 * in Mission Control from BOTH the per-agent consent flag
 * (`production_capture_enabled`, opt-in, NULL is not consent) AND whether this
 * flywheel key carries the `turn.report` scope. Re-deriving either half here
 * would be a second answer to a settled question, and it fails in the one
 * direction that costs a debugging session: the client believing it may upload
 * while every batch 403s, or the reverse.
 *
 * ABSENCE IS NOT CONSENT. A registration that failed, or a control plane too
 * old to send `capture` at all, yields `false` with a reason saying so.
 */
export function captureVerdict(registration) {
  const capture = registration && typeof registration === "object"
    ? registration.capture : null;
  // `Array.isArray` beside the `typeof` check, because `typeof [] === "object"`
  // in JavaScript: without it a JSON ARRAY is accepted as a capture block,
  // finds no `turns` on it, and falls through to "production capture is not
  // enabled for this agent" -- naming a switch an operator can flip when what
  // actually happened is that the control plane sent something that is not an
  // answer. Both branches refuse, so consent was never at risk; the defect was
  // that the refusal named the wrong cause. Python has always said "the
  // control plane did not answer" for this body, and the two SDKs owe the same
  // sentence to the same input.
  if (!capture || typeof capture !== "object" || Array.isArray(capture)) {
    const unanswered =
      "the control plane did not answer whether this agent may upload " +
      "production turns, so nothing is uploaded. Turns are still captured " +
      "locally.";
    return {
      mayUpload: false,
      reason: unanswered,
      // The Python verdict's `answered`: whether the control plane answered
      // at all. A re-read that comes back with nothing is a blip, and must
      // not overwrite a sentence it did send.
      answered: false,
      mayCaptureModelContent: false,
      modelContentReason: unanswered,
    };
  }
  // `=== true`, not truthiness: a consent question is answered by the exact
  // value. `turns: "false"` is truthy.
  const mayUpload = capture.turns === true;
  if (mayUpload) {
    // THE SECOND TIER, read by the same rules: the exact value, and only
    // where turns may flow, because a trace rides on a turn. It decides
    // whether model content is RECORDED at all, not merely uploaded -- see
    // `createTurnCapture`.
    const mayCaptureModelContent = capture.model_content === true;
    const served = capture.model_content_reason;
    return {
      mayUpload,
      reason: null,
      answered: true,
      mayCaptureModelContent,
      modelContentReason: mayCaptureModelContent ? null
        : (typeof served === "string" && served.trim()
          ? served.trim()
          : MODEL_CONTENT_NOT_ENABLED),
    };
  }
  // The server's own sentence when it sent one -- it names the switch and
  // who can flip it, which anything written here could only paraphrase.
  const reason = typeof capture.reason === "string" && capture.reason.trim()
    ? capture.reason.trim()
    : "production capture is not enabled for this agent.";
  // A refused turn refuses its trace for the same reason, and says THAT one.
  return {
    mayUpload,
    reason,
    answered: true,
    mayCaptureModelContent: false,
    modelContentReason: reason,
  };
}

/**
 * How the turn intake names a trace it refused for want of model-content
 * consent (the control plane's `governance.MODEL_CONTENT_NOT_ENABLED`).
 */
export const MODEL_CONTENT_REFUSED = "model_content_capture_not_enabled";

/**
 * Every name the turn intake refuses a trace by that means "stop recording
 * model content": no consent, or a turn attributed to no Product (a shared or
 * undeclared agent), whose trace the intake never keeps. The capture verdict
 * withholds the tier for both, and `recheck` picks it back up when either is
 * fixed. A non-conformant trace is not here: that one is this renderer's bug,
 * not a decision anyone made about this agent. The Python SDK's
 * `_MODEL_CONTENT_REFUSALS`.
 */
export const MODEL_CONTENT_REFUSALS = new Set([
  MODEL_CONTENT_REFUSED,
  "genai_trace_turn_not_attributed_to_a_product",
]);

/**
 * The model-content refusal when the control plane granted turns, withheld
 * model content and sent no sentence of its own. The Python SDK's
 * `_MODEL_CONTENT_NOT_ENABLED`, word for word -- the parity test compares them.
 */
export const MODEL_CONTENT_NOT_ENABLED =
  "model-content capture is not enabled for this agent, so the system " +
  "prompt, the conversation history and the tool results its model calls " +
  "saw are neither recorded nor uploaded.";

/** How `http.js` spells a terminal 403 in the error it throws. */
const REFUSED_MARKER = "-> HTTP 403";

/**
 * A 4xx about the ROUTE or the KEY, never the records in an `/outcomes`
 * batch: an absent route (404, 405 -- a control plane older than
 * `POST /outcomes`), a key it does not accept (401), a gone resource (410).
 * Sending stops for the flush and the outcomes stay. The Python SDK's
 * `_outcome_route_refused`.
 */
export function outcomeRouteRefused(status) {
  return [401, 404, 405, 410].includes(status);
}

/**
 * Whether an `/outcomes` refusal was about how LARGE the body was (413: a
 * proxy's limit, or the control plane's). Both halves of a batch too large
 * for a proxy answer it in the same words, so it is never read as a refusal
 * of the batch: the split goes on, and a record that draws it alone is too
 * large on its own. The Python SDK's `_outcome_refused_for_size`.
 */
export function outcomeRefusedForSize(status) {
  return status === 413;
}

/**
 * A refusal's detail that NAMES A RECORD: a 422's `loc` carrying an item
 * index (`["body","outcomes",3,"note"]`, as the control plane's validation
 * answers every batch route), or a handler's `"index"`. Read off the detail
 * as both SDKs render it -- compact JSON, `http.js`'s `detail` and the Python
 * client's `_detail` -- so this is the Python SDK's
 * `_REFUSAL_NAMES_A_RECORD`, byte for byte.
 */
export const REFUSAL_NAMES_A_RECORD =
  /"loc":\[(?:"(?:[^"\\]|\\.)*",)*\d+[,\]]|"index":\d/;

/**
 * Whether a refusal CAN be about the batch rather than a record in it. Never
 * one about the body's size (`outcomeRefusedForSize`), and never one whose
 * detail names a record (`REFUSAL_NAMES_A_RECORD`). That location is the
 * index WITHIN the half that was sent, so two bad records at the same offset
 * of each half answered in identical words, and reading those as a refusal
 * of the batch held every healthy record beside them, flush after flush --
 * turns for good, since turns never expire. The Python SDK's
 * `_refusal_may_be_of_the_batch`.
 */
export function refusalMayBeOfTheBatch(status, cause) {
  return !outcomeRefusedForSize(status)
    && !REFUSAL_NAMES_A_RECORD.test(String(cause ?? ""));
}

/**
 * A record's size as the wire spells it: compact JSON, UTF-8 -- the Python
 * SDK's `_outcome_wire_bytes`.
 */
function outcomeWireBytes(wire) {
  return Buffer.byteLength(JSON.stringify(wire), "utf8");
}

/**
 * Whether an `/outcomes` answer refused THIS BATCH: any other 4xx (400, 409,
 * 413, 422 ...) -- not 403 (consent), 408 or 429 (blips the client already
 * retried). Final for the batch, which is split to find the records it
 * refused, or -- both halves refused alike for what they say, never for their
 * size (`outcomeRefusedForSize`) -- kept as a refusal of the batch itself.
 * The Python SDK's `_outcome_batch_refused`.
 */
export function outcomeBatchRefused(status) {
  return Number.isInteger(status) && status >= 400 && status < 500
    && ![401, 403, 404, 405, 408, 410, 429].includes(status);
}

/**
 * Whether an answer says THE ROUTE IS NOT THERE: a control plane older than
 * it answers 404, or 405 where another method has the path. Every other 4xx
 * is about the key or the records, and must never be read as this: per-turn
 * feedback deletes its queue on it (`flushFeedback`). The Python SDK's
 * `_route_absent`.
 */
export function routeAbsent(status) {
  return status === 404 || status === 405;
}

/**
 * What `sendReports` needs to know about each of the two report routes: how
 * to say it (`many`, `counted`, `one`), where the reply lists its records
 * (`results`) and a record names itself (`id`), the route's batch limit, and
 * the transport method that sends one batch. The Python SDK's `_ReportKind`.
 */
const OUTCOMES = Object.freeze({
  many: "reported outcomes", counted: "reported outcome(s)",
  one: "an outcome", results: "outcomes", id: "outcome_id",
  batchMax: PRODUCTION_OUTCOME_BATCH_MAX_ITEMS, send: "reportOutcomes",
});
/**
 * The captured turns, through the same sender (`sendReports`): the intake's
 * per-record results are `turns[].accepted`, and a batch is `BATCH_SIZE`.
 * `stopOnBlip`: a transport failure or 5xx stops the flush -- a turn batch
 * can carry megabytes of trace, and sending the next chunk to a control
 * plane that just failed to answer the last costs a full retry ladder each.
 */
const TURNS = Object.freeze({
  many: "captured turns", counted: "captured turn(s)",
  one: "a turn", results: "turns", id: "turn_id",
  batchMax: BATCH_SIZE, send: "reportTurns", stopOnBlip: true,
});
const FEEDBACK = Object.freeze({
  many: "per-turn feedback reports", counted: "per-turn feedback report(s)",
  one: "a feedback report", results: "feedback", id: "feedback_id",
  batchMax: TURN_FEEDBACK_BATCH_MAX_ITEMS, send: "reportTurnFeedback",
});

/** The per-record answers of an acknowledged batch; `[]` when it has none. */
function replyRecords(reply, kind) {
  const results = reply?.[kind.results];
  return Array.isArray(results)
    ? results.filter((r) => r !== null && typeof r === "object") : [];
}

/**
 * Each record of an acknowledged batch the control plane did NOT record
 * (`accepted: false`), as `<its id> (<the control plane's word>)`. The Python
 * SDK's `_refused_by_name`.
 */
function refusedByName(reply, kind) {
  return replyRecords(reply, kind).filter((r) => r.accepted === false)
    .map((r) => `${r[kind.id] || "unnamed"} (${r.error || "refused"})`);
}

/**
 * Each record the control plane recorded WITHOUT its note
 * (`note.stored: false`), as `<its id> (<the control plane's word>)`. The
 * Python SDK's `_notes_not_stored`.
 */
function notesNotStored(reply, kind) {
  return replyRecords(reply, kind)
    .filter((r) => r.accepted === true && r.note !== null
      && typeof r.note === "object" && r.note.stored === false)
    .map((r) => `${r[kind.id] || "unnamed"} (${r.note.error || "not stored"})`);
}

/**
 * The intake's sentence when it REFUSED a batch of turns, else `null`.
 *
 * THE PYTHON SDK'S `_capture_refusal`. A 403 is a DECISION -- an operator
 * turned capture off, or the key lost the `turn.report` scope -- and will not
 * become a 2xx by being sent again. Read as a blip, it left both consent tiers
 * on: every flush re-POSTed the same end users' messages, and the model-content
 * gate kept writing each run's system prompt, history and tool results to disk
 * while consent was withdrawn -- to be uploaded if it were ever granted again,
 * which would make that grant retroactive.
 *
 * Read off the STATUS `http.js` puts on its `TransportError`, not the English.
 * Anything else -- a timeout, a 5xx, a 429 that outlasted the retry ladder --
 * is a blip and stays retryable: mistaking a blip for a refusal would stop a
 * consenting customer's uploads.
 */
export function captureRefusal(err) {
  if (err?.statusCode !== 403) return null;
  const text = String(err?.message ?? "");
  const at = text.indexOf(REFUSED_MARKER);
  const detail = at < 0 ? ""
    : text.slice(at + REFUSED_MARKER.length).replace(/^[: ]+/, "").trim();
  return detail || "the control plane refused this agent's turns (HTTP 403).";
}

/**
 * The turn store: three hooks in, turn directories out.
 *
 * Exact host ids need no in-memory state. An invalid host id gets a fresh
 * storage-safe id instead of being rewritten; that one exceptional mapping is
 * bounded and exists only to keep the same run's observer hooks joined.
 *
 * ONLY THIS AGENT'S OWN TURNS. The host runs every hook for every agent,
 * subagent and cron session a gateway serves, and capture used to record all
 * of them -- uploaded under this agent's id and this agent's consent. Every
 * hook now asks `scopeDecision` against `servedAgent` (`resolveServedAgent`),
 * the one predicate the serving policy's two halves ask: a run it refuses is
 * not recorded at all, and each distinct reason is said once.
 */
export function createTurnCapture({
  root, logger = null, servedAgent = null,
  maxPendingInputBytes = PENDING_INPUT_MAX_BYTES,
}) {
  let warned = false;
  const served = servedAgent ?? resolveServedAgent({});
  // Once per DISTINCT reason, not per run: this sits in front of every turn.
  const saidScope = new Set();
  const inScope = (event, ctx) => {
    // `message_received` puts the session key on the EVENT; the agent hooks
    // put it, and the agent id, on the context.
    const scoped = {
      ...(ctx && typeof ctx === "object" ? ctx : {}),
      sessionKey: ctx?.sessionKey ?? event?.sessionKey,
      agentId: ctx?.agentId ?? event?.agentId,
    };
    const decision = scopeDecision(scoped, served);
    if (!decision.apply && !saidScope.has(decision.reason) && saidScope.size < 64) {
      saidScope.add(decision.reason);
      logger?.info?.(
        `[agent-flywheel] a run was NOT captured -- ${decision.reason}.`);
    }
    return decision.apply;
  };
  // THE SECOND CONSENT TIER, asked at the moment of recording. Until the
  // uploader is wired (`gateModelContent`), and whenever the control plane
  // has not said `model_content: true`, nothing a model call saw is written.
  let mayRecordModelContent = () => false;
  // The run's first model input, from `llm_input`, held until its
  // `agent_end`. Keyed by turn id; bounded like `generatedTurnIds`, so a run
  // whose `agent_end` never arrives is forgotten rather than held forever.
  const pendingInputs = new Map();
  // ...and bounded by BYTES as well as by count: one run's input is its whole
  // history, and 4,096 of them held at once is unbounded heap.
  const pendingSizes = new Map();
  let pendingBytes = 0;
  const forgetInput = (turnId) => {
    pendingBytes -= pendingSizes.get(turnId) ?? 0;
    pendingSizes.delete(turnId);
    pendingInputs.delete(turnId);
  };
  // THE TURNS WHOSE MODEL BOUNDARY IS RECORDED AS IT HAPPENS
  // (`onModelOperation`): every model call and tool execution, observed by a
  // framework adapter. Such a turn is never ALSO reconstructed from its first
  // `llm_input` and its `agent_end` -- that reconstruction sees one prefix and
  // a transcript, and the framework host's transcript is only the user's
  // message and the final answer. Bounded like the maps below.
  const directTurns = new Set();
  // Invalid host ids are never cleaned into a different caller id. They get a
  // fresh safe id, retained only long enough to keep this run's hooks joined.
  const generatedTurnIds = new Map();
  // THE TURNS STILL RUNNING, by when a hook last touched them: opened by
  // their message, a model input or a tool call, closed by their answer.
  // Retention never deletes one (`activeTurns`). Where the host drops
  // `agent_end` no answer closes them, so a turn counts as running only
  // within the settle window of its last hook; bounded like the maps above.
  const running = new Map();
  const touch = (turnId) => {
    running.delete(turnId);
    running.set(turnId, Date.now());
    while (running.size > 4096) running.delete(running.keys().next().value);
  };
  const turnIdFor = (value) => {
    const exact = safeTurnId(value);
    if (exact !== null) return exact;
    if (value === null || value === undefined || String(value).length === 0) {
      return null;
    }
    // Map keys retain primitive value and object identity; stringifying an
    // invalid host value would collapse every object to "[object Object]".
    const key = value;
    let generated = generatedTurnIds.get(key);
    if (!generated) {
      generated = `t_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      generatedTurnIds.set(key, generated);
      while (generatedTurnIds.size > 4096) {
        generatedTurnIds.delete(generatedTurnIds.keys().next().value);
      }
    }
    return generated;
  };
  const warnOnce = (err) => {
    if (warned) return;
    warned = true;
    logger?.warn?.(
      `[agent-flywheel] could not write a captured turn; production capture is ` +
      `not recording for this run: ${err?.message ?? err}`,
    );
  };

  /** The end user's message. */
  function onMessageReceived(event, ctx = {}) {
    if (!inScope(event, ctx)) return false;
    const runId = event?.runId ?? ctx?.runId;
    const text = event?.content;
    const turnId = turnIdFor(runId);
    if (turnId === null) return false;
    touch(turnId);
    const conversationId = conversationIdOf(event, ctx);
    const taskId = taskIdOf(event, ctx);
    const dir = turnDir(root, turnId);
    try {
      const wroteConversation = conversationId
        ? recordConversationId(dir, conversationId) : false;
      const wroteTaskId = taskId ? recordTaskId(dir, taskId) : false;
      const effectiveTaskId = readTaskId(dir);
      const wroteText = recordTurnText(dir, "task", text, {
        turn_id: turnId,
        conversation_id: conversationId ?? "",
        task_id: effectiveTaskId ?? "",
      });
      return wroteConversation || wroteTaskId || wroteText;
    } catch (err) {
      warnOnce(err);
      return false;
    }
  }

  /**
   * The run's first model input. OBSERVE ONLY: the host discards the return
   * of this hook, and it records nothing without model-content consent.
   */
  function onLlmInput(event, ctx = {}) {
    if (!mayRecordModelContent() || !inScope(event, ctx)) return false;
    const turnId = turnIdFor(event?.runId ?? ctx?.runId);
    if (turnId === null) return false;
    touch(turnId);
    if (directTurns.has(turnId)) return false;
    try {
      const prior = pendingInputs.get(turnId);
      // A SECOND llm_input in one run means the model saw a second prefix
      // (a retry, a re-assembly after compaction). Which one each answer
      // followed is not observable, so the run records no model boundary.
      let entry = prior
        ? { refused: "the run assembled more than one model input" }
        : inputFromLlmInput(event, nowUnixNano())
          ?? { refused: "the model input cannot be rendered faithfully" };
      let size = 0;
      try {
        size = Buffer.byteLength(JSON.stringify(entry) ?? "", "utf8");
      } catch {
        entry = { refused: "the model input cannot be rendered faithfully" };
      }
      if (size > maxPendingInputBytes) {
        entry = { refused: "the model input is too large to hold until its run ends" };
        size = 0;
      }
      forgetInput(turnId);
      pendingInputs.set(turnId, entry);
      pendingSizes.set(turnId, size);
      pendingBytes += size;
      while (pendingInputs.size > 4096 || pendingBytes > maxPendingInputBytes) {
        forgetInput(pendingInputs.keys().next().value);
      }
      return true;
    } catch {
      return false;
    }
  }

  /** The run's model calls, from its first input and its final transcript. */
  function recordRunBoundary(turnId, dir, messages) {
    const first = pendingInputs.get(turnId);
    forgetInput(turnId);
    if (!first || first.refused || !mayRecordModelContent()) return false;
    try {
      return recordModelBoundary(dir, operationsFromRun(first, messages, nowUnixNano()));
    } catch {
      return false;
    }
  }

  /**
   * One model call or tool execution of a running turn, observed by a
   * framework adapter as it happened (`op` is one operation of the model
   * boundary, see `genai-otlp.js`). `start` is the turn's start, decimal
   * nanoseconds. OBSERVE ONLY, and nothing is written without model-content
   * consent. Never throws.
   */
  function onModelOperation(op, ctx = {}, { start } = {}) {
    try {
      if (!mayRecordModelContent() || !inScope(null, ctx)) return false;
      const turnId = turnIdFor(ctx?.runId);
      if (turnId === null) return false;
      touch(turnId);
      if (!directTurns.has(turnId)) {
        directTurns.add(turnId);
        while (directTurns.size > 4096) directTurns.delete(directTurns.values().next().value);
      }
      // Whatever `llm_input` held for this turn is superseded: the calls
      // themselves are recorded.
      forgetInput(turnId);
      return recordModelOperation(turnDir(root, turnId), op,
        typeof start === "string" && start ? start : nowUnixNano());
    } catch {
      return false;
    }
  }

  /** The agent's answer. */
  function onAgentEnd(event, ctx = {}) {
    if (!inScope(event, ctx)) return false;
    const runId = event?.runId ?? ctx?.runId;
    const turnId = turnIdFor(runId);
    if (turnId === null) return false;
    // The answer closes the turn.
    running.delete(turnId);
    const dir = turnDir(root, turnId);
    const conversationId = conversationIdOf(event, ctx);
    const taskId = taskIdOf(event, ctx);
    const wroteConversation = conversationId
      ? recordConversationId(dir, conversationId) : false;
    const wroteTaskId = taskId ? recordTaskId(dir, taskId) : false;
    const wroteBoundary = directTurns.delete(turnId)
      ? (forgetInput(turnId), recordModelBoundaryEnd(dir, nowUnixNano()))
      : recordRunBoundary(turnId, dir, event?.messages);
    const text = lastAssistantText(event?.messages);
    if (!text) return wroteConversation || wroteTaskId || wroteBoundary;
    try {
      const wroteText = recordTurnText(dir, "answer", text, {
        turn_id: turnId,
        conversation_id: readConversationId(dir) ?? "",
        task_id: readTaskId(dir) ?? "",
      });
      return wroteConversation || wroteTaskId || wroteText || wroteBoundary;
    } catch (err) {
      warnOnce(err);
      return false;
    }
  }

  /**
   * Where a tool call belongs. Passed to `createWriter({resolveDir})`.
   *
   * `null` for a call with no run id, which DROPS the record rather than
   * putting it in a shared directory. An unattributable call landing in some
   * other turn's trajectory is the misattribution this package refuses
   * everywhere else.
   *
   * `callCtx` is the call's whole host context with its run id resolved, so
   * the conversation and task it names are recorded here as well: a turn
   * with no `message_received` (a terminal session) has no other writer.
   */
  function resolveToolDir(callCtx) {
    if (!inScope(null, callCtx)) return null;
    const runId = callCtx?.runId;
    const turnId = turnIdFor(runId);
    if (turnId === null) return null;
    touch(turnId);
    const dir = turnDir(root, turnId);
    const taskId = taskIdOf(null, callCtx);
    if (taskId) recordTaskId(dir, taskId);
    const conversationId = conversationIdOf(null, callCtx);
    if (conversationId) recordConversationId(dir, conversationId);
    return dir;
  }

  /** Bind a reconciled identity to this exact host-declared turn. */
  function onExecutionIdentity(event, ctx = {}, observation) {
    if (!inScope(event, ctx)) return false;
    const runId = event?.runId ?? ctx?.runId;
    const turnId = turnIdFor(runId);
    if (turnId === null || !observation) return false;
    const dir = turnDir(root, turnId);
    if (observation.conflict) return recordExecutionFingerprintConflict(dir);
    if (!observation.fingerprint) return false;
    return recordExecutionFingerprint(dir, observation.fingerprint);
  }

  /** Bind the model-content verdict: a function asked at each recording. */
  function gateModelContent(predicate) {
    mayRecordModelContent = typeof predicate === "function" ? predicate : () => false;
  }

  /** The ids of the turns still running: touched within the settle window
   *  and not yet answered. */
  function activeTurns() {
    const since = Date.now() - UNANSWERED_SETTLE_MS;
    return new Set([...running].filter(([, at]) => at >= since).map(([id]) => id));
  }

  return {
    root, onMessageReceived, onAgentEnd, onExecutionIdentity, onLlmInput,
    onModelOperation, gateModelContent, resolveToolDir, activeTurns,
    /** Whether a model call observed now may be recorded at all. */
    mayRecordModelContent: () => mayRecordModelContent() === true,
  };
}

/**
 * A reported outcome waiting to be uploaded is ONE FILE in the capture root,
 * `.outcome.<digest of its id>.json` -- the names and the bytes the Python
 * SDK's `Attachment.report_outcome` writes. A file and not a directory for the
 * reason `UPLOADED_INDEX` is: every directory under the root is read as a
 * turn. One file per outcome, written whole and renamed into place, so two
 * processes sharing a root never rewrite each other's pending outcomes.
 */
export const OUTCOME_FILE_PREFIX = ".outcome.";
export const OUTCOME_FILE_SUFFIX = ".json";
/**
 * Per-turn feedback waits the same way, under its own name:
 * `.feedback.<digest of its id>.json`. The outcomes' week and count bounds
 * apply to it. The Python SDK's `_FEEDBACK_FILE_PREFIX`.
 */
export const FEEDBACK_FILE_PREFIX = ".feedback.";
/**
 * How long an outcome that could not be delivered is kept: a week, the
 * rollout outbox's bound. An outbox nothing can drain (a control plane with no
 * `/outcomes` route yet) must not grow for the life of a deployment.
 */
export const OUTCOME_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
/**
 * How many outcomes are kept waiting: while consent is still UNKNOWN (the
 * verdict read has not been answered yet), and while it is granted but they
 * cannot be delivered. Bounded by count as well as age, because a week of a
 * busy agent's reports is not a small outbox; past it the oldest go, out
 * loud, naming which of the two it was. The Python SDK's
 * `_OUTCOME_MAX_KEPT_UNANSWERED`.
 */
export const OUTCOME_MAX_KEPT_UNANSWERED = 1000;

/**
 * The one sentence for outcomes dropped by the count bound while the consent
 * question is unanswered -- its cause, which is not a refusal: the control
 * plane has not answered (it could not be reached, or did not say). The Python
 * SDK's `_unanswered_outcomes_dropped`.
 */
export function unansweredOutcomesDropped(
  dropped, kept = OUTCOME_MAX_KEPT_UNANSWERED,
) {
  return (
    `[agent-flywheel] ${dropped} reported outcome(s) were dropped, oldest ` +
    `first: the control plane has not answered whether this agent may ` +
    `upload production traffic (it could not be reached, or did not say), ` +
    `and at most ${kept} outcomes that wait on that answer are kept until ` +
    `it does.`);
}
/**
 * How many requests one flush may spend splitting refused `/outcomes`
 * batches. Isolating one bad record of 64 costs 12; the bound stops a refusal
 * the split did not recognise as whole-batch from costing two requests per
 * outcome, each charged against the control plane's rate limit. The Python
 * SDK's `_OUTCOME_SPLIT_MAX_REQUESTS`.
 */
export const OUTCOME_SPLIT_MAX_REQUESTS = 32;

/** Where the outcome with this id waits: a digest of the id, never the id. */
export function outcomeFile(root, outcomeId) {
  const digest = createHash("sha256").update(outcomeId, "utf8")
    .digest("hex").slice(0, 32);
  return join(root, `${OUTCOME_FILE_PREFIX}${digest}${OUTCOME_FILE_SUFFIX}`);
}

/** Where the feedback with this id waits (`outcomeFile`). */
export function feedbackFile(root, feedbackId) {
  const digest = createHash("sha256").update(feedbackId, "utf8")
    .digest("hex").slice(0, 32);
  return join(root, `${FEEDBACK_FILE_PREFIX}${digest}${OUTCOME_FILE_SUFFIX}`);
}

/**
 * `occurredAt` as the wire spells it. Absent is now; a `Date` becomes UTC
 * with milliseconds and `Z` (what the Python SDK writes for a `datetime`); a
 * string goes through untouched for the validator to judge. A `Date` that is
 * not a time is refused: it names no instant.
 */
function rfc3339(value, Refusal = InvalidOutcome) {
  const at = value === undefined || value === null ? new Date() : value;
  if (at instanceof Date) {
    if (Number.isNaN(at.getTime())) {
      throw new Refusal("occurredAt is not a valid Date");
    }
    return at.toISOString();
  }
  return at;
}

/**
 * One `reportOutcome` call as the outcome wire carries it, validated
 * (`productionOutcome`); throws `InvalidOutcome`. The Python SDK's
 * `Attachment.report_outcome` builds the same record from the same arguments.
 */
export function outcomeWire(outcome, {
  turnId, conversationId, value, note, occurredAt, outcomeId, episodeId,
} = {}) {
  const wire = {
    outcome_id: outcomeId === undefined || outcomeId === null
      ? `o_${randomUUID().replaceAll("-", "")}` : outcomeId,
    outcome,
    occurred_at: rfc3339(occurredAt),
  };
  for (const [name, given] of [
    ["turn_id", turnId], ["conversation_id", conversationId],
    ["episode_id", episodeId], ["value", value], ["note", note],
  ]) {
    if (given !== undefined && given !== null) wire[name] = given;
  }
  return productionOutcome(wire);
}

/**
 * One `reportTurnFeedback` call as the feedback wire carries it, validated
 * (`turnFeedback`); throws `InvalidFeedback`. The Python SDK's
 * `Attachment.report_turn_feedback` builds the same record from the same
 * arguments.
 */
export function feedbackWire(signal, {
  episodeId, turnIndex, turnId, occurredAt, feedbackId,
} = {}) {
  const wire = {
    feedback_id: feedbackId === undefined || feedbackId === null
      ? `f_${randomUUID().replaceAll("-", "")}` : feedbackId,
    episode_id: episodeId,
    turn_index: turnIndex,
    signal,
    occurred_at: rfc3339(occurredAt, InvalidFeedback),
  };
  if (turnId !== undefined && turnId !== null) wire.turn_id = turnId;
  return turnFeedback(wire);
}

/** Whether a `reportTurnFeedback` call names a production turn (`turnId`). */
function namesAProductionTurn(options) {
  return options?.turnId !== undefined && options?.turnId !== null;
}

/**
 * `reportTurnFeedback`'s SPAN for a PRODUCTION TURN (`turnId`, the run id
 * the turn was captured under, in place of `episodeId` and `turnIndex`):
 * validated by `turnFeedbackOnASpan`, emitted by `recordTurnFeedbackSpan` --
 * an event on the turn's trace, through the customer's TracerProvider, for an
 * agent whose turns reach the control plane over OTLP. The same report is
 * ALSO uploaded over `POST /turn-feedback` by the uploader, which takes a
 * production turn by its `turn_id`. The id once the span is recorded, else
 * `null`. The Python SDK's `Attachment._report_turn_feedback_on_its_span`.
 */
export function reportTurnFeedbackOnItsSpan(signal, {
  turnId, episodeId, turnIndex, occurredAt, feedbackId,
} = {}) {
  if (episodeId !== undefined && episodeId !== null
      || turnIndex !== undefined && turnIndex !== null) {
    throw new InvalidFeedback(
      "feedback names one turn: a production turn's turn_id, or an " +
      "episode's episode_id and turn_index, not both");
  }
  const wire = turnFeedbackOnASpan({
    feedback_id: feedbackId === undefined || feedbackId === null
      ? `f_${randomUUID().replaceAll("-", "")}` : feedbackId,
    turn_id: turnId,
    signal,
    occurred_at: rfc3339(occurredAt, InvalidFeedback),
  });
  const recorded = recordTurnFeedbackSpan({
    turnId: wire.turn_id, signal: wire.signal,
    occurredAtUnixNano: rfc3339UnixNanos(wire.occurred_at),
    feedbackId: wire.feedback_id,
  });
  return recorded ? wire.feedback_id : null;
}

/** `JSON.stringify` with sorted keys: the bytes Python's `sort_keys` writes
 * are not promised, only that either SDK reads the other's file. */
function sortedJson(wire) {
  return JSON.stringify(Object.fromEntries(
    Object.keys(wire).sort().map((k) => [k, wire[k]])));
}

/**
 * Uploads captured turns. Periodic while traffic arrives, and once at shutdown.
 *
 * TWO TRIGGERS, because neither covers the other's case -- the same pair the
 * Python SDK needed, arrived at the same way. The cadence only runs while
 * requests are arriving; shutdown knows nothing more is coming, but never
 * fires for a gateway that keeps running.
 *
 * `answersExpected` IS THE HOST'S ANSWER, PASSED IN. The cadence holds back a
 * turn with no `final_text` because an answer may still be coming -- but that
 * is only true when this host actually delivers `agent_end` to this plugin.
 * When it does not (the default install; see `host.js`), NO turn ever gets an
 * answer, "may still be coming" is false for every one of them, and holding
 * them back holds them back forever: a long-lived gateway would upload
 * literally nothing while telling the operator its turns were being uploaded.
 * The question is asked once, at registration, by the one predicate that owns
 * it, and the verdict is handed here rather than re-derived.
 */
export function createTurnUploader({
  transport, agentId, root, logger = null, flushEvery = FLUSH_EVERY,
  answersExpected = true,
  maxOutcomesWhileUnknown = OUTCOME_MAX_KEPT_UNANSWERED,
  awaitAnnouncedVerdict = false,
}) {
  let since = 0;
  // Whether the startup verdict (`announce`) has been recorded. Until it has,
  // a flush does not re-ask: on a first start the agent row may not exist
  // yet (registration is still in flight), and the answer to "may I upload?"
  // would be "not registered" -- an ANSWERED no that turned
  // `reportOutcome` into a no-op for the life of the process. The startup
  // chain asks once the row exists. `registerTurnCapture` sets this; a
  // standalone uploader has no startup chain and re-asks from the first flush.
  let announced = !awaitAnnouncedVerdict;
  // Bumped by every change of the consent state, so a verdict read that was
  // overtaken while in flight -- a 403 arrived meanwhile -- is not applied
  // over the fresher answer (`setVerdict(v, {since})`).
  let epoch = 0;
  // A flush in flight, and the one rerun asked for meanwhile (`flush`).
  let inFlight = false;
  let rerunOptions = null;
  let rerun = null;
  let resolveRerun = null;
  let mayUpload = false;
  let refusal = null;
  // Whether the control plane SAID NO -- an answered verdict, or the intake's
  // 403 -- as opposed to not having answered yet. `mayUpload` is false in
  // both; an outcome reported while the answer is UNKNOWN is kept for the
  // flush that re-asks, and only an explicit no makes `reportOutcome` a
  // no-op. The Python SDK's `Attachment._consent_refused`.
  let consentRefused = false;
  // The control plane refused an outcome that names only an episode while
  // production capture is not enabled -- one that predates the episode join.
  // Said once; no more are sent on those terms by this process. The Python
  // SDK's `Attachment._episode_outcomes_refused`.
  let episodeOutcomesRefused = false;
  // The control plane will not take per-turn feedback from this process: it
  // has no such route (404, 405 -- what was waiting was dropped) or it
  // refused this key (403 -- what was waiting stays on disk). Said once;
  // after it `reportTurnFeedback` is a no-op.
  let turnFeedbackRefused = false;
  let mayCaptureModelContent = false;
  let modelContentReason = null;
  // The cause of the last whole-batch refusal said out loud, per kind of
  // report, so it is said once (`warnWholeBatchRefusal`).
  const batchRefusalSaid = new Map();

  const idsOf = (text) => new Set(
    text.split("\n").map((l) => l.trim()).filter(Boolean));

  function uploadedIds() {
    try {
      return idsOf(readFileSync(join(root, UPLOADED_INDEX), "utf8"));
    } catch {
      return new Set();
    }
  }

  /** `uploadedIds`, off the event loop, for the flush. */
  async function uploadedIdsAsync() {
    try {
      return idsOf(await readFile(join(root, UPLOADED_INDEX), "utf8"));
    } catch {
      return new Set();
    }
  }

  async function markUploaded(ids) {
    if (!ids.length) return;
    try {
      await mkdir(root, { recursive: true });
      const all = await uploadedIdsAsync();
      for (const id of ids) all.add(id);
      await replaceFileAsync(join(root, UPLOADED_INDEX), [...all].join("\n") + "\n");
    } catch {
      // A marker we could not write means the turn is retried next flush. The
      // intake dedupes on turn_id, so a resend is answered as a duplicate --
      // which is why failing to mark is safe and failing to SEND is the thing
      // this ordering protects.
    }
  }

  /**
   * Collect the turns worth sending right now, in the order they started.
   *
   * `quietBefore` is a cutoff applied ONLY to unanswered turns, against the
   * newest file written in the turn (`lastWrittenAt`): a turn written more
   * recently than that may still be accruing tool calls, and sending it now
   * would mark it uploaded before it finished being written. `null` means
   * send them regardless, which is what shutdown wants.
   *
   * OFF THE HOOK'S PATH. The first thing it does is yield, so the hook that
   * kicked the flush has returned before anything is listed; then ONE
   * listing (`scanTurns`, `fs.promises`) gives every turn's index at once,
   * and the turns are read a few at a time between yields.
   *
   * `{turns, skipped, failed}`: an unanswered turn held back is `skipped`, a
   * turn that cannot be rendered is `failed` (counted on every flush it
   * stays unreadable), as the Python SDK's flush counts them.
   */
  async function pending({ includeUnanswered, quietBefore = null }) {
    await yieldToLoop();
    const turns = await scanTurns(root);
    const index = turnIndices(turns);
    const already = await uploadedIdsAsync();
    const out = [];
    let read = 0;
    let skipped = 0;
    let failed = 0;
    for (const t of turns) {
      if (already.has(t.name)) continue;
      if (++read % 8 === 0) await yieldToLoop();
      let wire;
      try {
        wire = turnWire(t.path, {
          turnIndex: index.get(t.name) ?? 0,
          // Model content rides only while the control plane says it may.
          modelContentAgent: mayCaptureModelContent ? agentId : null,
        });
      } catch {
        // One unreadable turn costs that turn. A truncated trajectory is the
        // EXPECTED case here, not an exotic one.
        failed += 1;
        continue;
      }
      if (!wire) continue;
      if (wire.final_text === null) {
        if (!includeUnanswered
            || (quietBefore !== null && await lastWrittenAt(t.path) > quietBefore)) {
          skipped += 1;
          continue;
        }
      }
      out.push(wire);
    }
    return { turns: out, skipped, failed };
  }

  /**
   * Re-read the verdict. A READ, so it is safe to ask on the cadence; never
   * rejects; fails closed.
   *
   * THE PYTHON SDK'S `_recheck_capture`, rule for rule. An operator may grant
   * consent -- for turns, or for model content on an agent already uploading
   * turns -- long after this process started, and nothing else would tell it:
   * until this existed a Node install learned a grant only by restarting.
   * Both tiers follow any verdict the control plane actually GAVE, both ways:
   * an ANSWERED no goes through `refuseUpload`, the one place uploading is
   * turned off, so neither tier is still on when the flush that asked goes
   * on to upload. A read that answered nothing (a blip, `answered: false`)
   * changes nothing: it must never revoke what was granted.
   *
   * The answer lands at `takeAnsweredVerdict`, the seam the startup read
   * (`setVerdict`) lands at too.
   */
  async function recheck() {
    if (typeof transport?.captureCurrent !== "function") return;
    const asked = epoch;
    let v;
    try {
      v = captureVerdict(await transport.captureCurrent(agentId));
    } catch {
      return;
    }
    // Overtaken while in flight (a 403 meanwhile): the fresher answer stands.
    if (asked !== epoch || !v.answered) return;
    await takeAnsweredVerdict(v);
  }

  /**
   * THE ONE SEAM an ANSWERED verdict lands at, whichever read delivered it:
   * the startup read (`setVerdict`, from `announce`) or the re-read
   * (`recheck`). The Python SDK's `Attachment._take_capture_verdict`.
   *
   * A yes turns both tiers on as the verdict says. An answered no goes
   * through `refuseUpload` and, when the answer had been unknown until now,
   * deletes the outcomes that waited on it (`purgeUnansweredOutcomes`): an
   * answered no means nothing will ever send them, exactly as `reportOutcome`
   * keeps none after a no. That second step used to run on the re-read alone,
   * so a process that learned its no AT STARTUP never purged what an earlier
   * process had kept while the control plane was unreachable, and those
   * outcomes uploaded once consent was granted. Outcomes kept after THIS
   * process's intake 403 are not unknown ones (`consentRefused` is already
   * true) and stay.
   *
   * The state changes before the first await, so a caller that does not
   * await sees the verdict at once. Never rejects.
   */
  async function takeAnsweredVerdict(v) {
    if (!v.mayUpload) {
      const wasUnknown = !mayUpload && !consentRefused;
      refuseUpload(v.reason ?? null);
      if (wasUnknown) await purgeUnansweredOutcomes();
      return;
    }
    mayUpload = true;
    refusal = null;
    consentRefused = false;
    mayCaptureModelContent = v.mayCaptureModelContent === true;
    modelContentReason = mayCaptureModelContent ? null
      : (v.modelContentReason ?? null);
    epoch += 1;
  }

  /**
   * The control plane said NO: the intake's 403, or an answered verdict
   * (`takeAnsweredVerdict`). Stop sending, say why.
   *
   * THE PYTHON SDK'S `_refuse_upload`, and the one place `mayUpload` turns
   * false after it was true. A trace rides on a turn, so a refused turn
   * refuses its model content too: from here on no run records what its model
   * saw, until `recheck` reads a verdict that grants it again. Said when it
   * changes something -- uploading stops, or the no is new -- not on every
   * flush that re-reads the same no.
   */
  function refuseUpload(reason) {
    const wasUploading = mayUpload;
    const news = wasUploading || !consentRefused || refusal !== reason;
    mayUpload = false;
    refusal = reason;
    consentRefused = true;
    mayCaptureModelContent = false;
    modelContentReason = reason;
    epoch += 1;
    if (!news) return;
    logger?.warn?.(
      `[agent-flywheel] the control plane refused this agent's captured ` +
      `turns and ${wasUploading ? "uploading has stopped" : "nothing is uploaded"}: ` +
      `${reason} The turns stay on disk, and uploading resumes on its own if ` +
      `capture is enabled again.`);
  }

  /**
   * Delete the outcomes that waited on the consent answer, now that it is no.
   * An outcome naming only an episode never waited on it
   * (`namesOnlyAnEpisode`) and stays. Said once, with the count and the
   * control plane's sentence. Never rejects. The Python SDK's
   * `_purge_unanswered_outcomes`.
   */
  async function purgeUnansweredOutcomes() {
    let dropped = 0;
    for (const path of await queuedFilesAsync(OUTCOME_FILE_PREFIX)) {
      let wire = null;
      try { wire = JSON.parse(await readFile(path, "utf8")); } catch { /* deleted */ }
      if (wire !== null && typeof wire === "object" && !Array.isArray(wire)
          && namesOnlyAnEpisode(wire)) continue;
      try { await rm(path); dropped += 1; } catch { /* kept */ }
    }
    if (dropped) {
      logger?.warn?.(
        `[agent-flywheel] ${dropped} reported outcome(s) kept while the ` +
        `control plane had not answered were deleted: it answered that this ` +
        `agent may not upload production traffic (${refusal})`);
    }
  }

  /**
   * THE REVOCATION PATH for model content. The intake keeps the turn and
   * refuses its trace BY NAME (`MODEL_CONTENT_REFUSALS`) when an operator has
   * withdrawn model-content consent, or when the agent's turns are attributed
   * to no Product; left unread, every later turn would record the customer's
   * prompt and tool results and send them to be discarded.
   */
  function noteModelContentRefusal(reply) {
    const results = Array.isArray(reply?.turns) ? reply.turns : [];
    for (const result of results) {
      const trace = result?.genai_trace;
      if (trace && MODEL_CONTENT_REFUSALS.has(trace.error)) {
        mayCaptureModelContent = false;
        modelContentReason = typeof trace.detail === "string" && trace.detail.trim()
          ? trace.detail : MODEL_CONTENT_NOT_ENABLED;
        logger?.warn?.(
          `[agent-flywheel] the control plane refused this agent's model ` +
          `content, so it is no longer recorded or uploaded: ${modelContentReason}`);
        return;
      }
    }
  }

  /**
   * Queue one outcome for upload: how a turn, a conversation or an episode
   * actually turned out. THE PYTHON SDK'S `Attachment.report_outcome`, rule
   * for rule.
   *
   * Validated first, capture enabled or not (`InvalidOutcome`). Then A NO-OP
   * ONCE THE CONTROL PLANE HAS SAID production capture is not enabled for
   * this agent: an outcome is a fact about the end users' traffic, so it is
   * sent on exactly the terms a turn is, and nothing is kept locally for an
   * agent that may not send it. While the answer is still UNKNOWN (the
   * verdict read failed on a blip) the outcome is kept, and the flush kicked
   * here asks again; it is sent once the answer is yes. At most
   * `maxOutcomesWhileUnknown` are kept waiting -- while it is unknown, or
   * while it is yes and they cannot be delivered; past that the oldest are
   * dropped, with a warning naming which.
   *
   * EXCEPT AN OUTCOME THAT NAMES ONLY AN EPISODE (`namesOnlyAnEpisode`): it
   * carries nothing about the end users' traffic, so it is queued and sent
   * whether or not production capture is enabled -- until a control plane
   * that predates the episode join refuses one, which is said once.
   * Returns the outcome's id once queued, else `null`; the upload itself
   * happens off the caller's path (`flush`, kicked here and not awaited).
   */
  function reportOutcome(outcome, options = {}) {
    const wire = outcomeWire(outcome, options);
    if (!mayUpload) {
      if (namesOnlyAnEpisode(wire)) {
        // Not about end users' traffic: consent is not its question.
        if (episodeOutcomesRefused) return null;
      } else if (consentRefused) {
        return null;
      }
    }
    const path = outcomeFile(root, wire.outcome_id);
    try {
      mkdirSync(root, { recursive: true });
      replaceFile(path, sortedJson(wire));
    } catch {
      // Capture costs the observation, never the caller.
      return null;
    }
    // Bounded whether consent is unknown or granted: granted, the queue
    // still grows for as long as uploads fail. One naming only an episode is
    // not counted.
    if (!namesOnlyAnEpisode(wire)) capUnansweredOutcomes();
    flush({
      includeUnanswered: !answersExpected, settleMs: UNANSWERED_SETTLE_MS,
    }).catch(() => {});
    return wire.outcome_id;
  }

  /**
   * Queue one per-turn feedback report: what the user did with one turn of
   * an episode. THE PYTHON SDK'S `Attachment.report_turn_feedback`, rule for
   * rule. Validated first (`InvalidFeedback`). It needs no production-capture
   * consent -- it carries ids, one word and a time -- and is a no-op once the
   * control plane has refused feedback or shown it has no route for it.
   * Returns the feedback's id once
   * queued, else `null`; the upload happens off the caller's path.
   */
  function reportTurnFeedback(signal, options = {}) {
    let recorded = false;
    let wire;
    if (namesAProductionTurn(options)) {
      // A production turn's feedback is on its trace AND uploaded here, by
      // its turn_id: one id for both, minted once.
      const feedbackId = options.feedbackId ?? `f_${randomUUID().replaceAll("-", "")}`;
      recorded = reportTurnFeedbackOnItsSpan(signal, { ...options, feedbackId }) !== null;
      wire = feedbackWire(signal, { ...options, feedbackId });
    } else {
      wire = feedbackWire(signal, options);
    }
    const said = recorded ? wire.feedback_id : null;
    if (turnFeedbackRefused) return said;
    const path = feedbackFile(root, wire.feedback_id);
    try {
      mkdirSync(root, { recursive: true });
      replaceFile(path, sortedJson(wire));
    } catch {
      // Capture costs the observation, never the caller.
      return said;
    }
    flush({
      includeUnanswered: !answersExpected, settleMs: UNANSWERED_SETTLE_MS,
    }).catch(() => {});
    return wire.feedback_id;
  }

  /**
   * Upload the per-turn feedback waiting on disk. Called inside `flush`.
   * Never throws. THE PYTHON SDK'S `Attachment._flush_feedback`, rule for
   * rule.
   *
   * THE OUTCOMES' RULES, through the outcomes' own sender (`sendReports`):
   * an acknowledged batch is deleted, and a report the control plane refused
   * by name inside it is said by name and not sent again; a blip leaves what
   * is waiting for the next flush, bounded by the outcomes' week and count;
   * a 403 is its decision (a key without the scope, a key bound elsewhere),
   * so sending stops for this process and what is waiting stays on disk; a
   * 401 or 410 stops this flush and it stays; any other 4xx is about the
   * records, so the batch is split and only the report it refused is
   * dropped.
   *
   * ONE DIFFERENCE: AN ABSENT ROUTE (`routeAbsent`, 404 or 405) is a control
   * plane that predates per-turn feedback, and nothing will ever take what is
   * waiting. It is dropped, said once, and `reportTurnFeedback` is a no-op
   * for the rest of the process.
   *
   * Counts, only when feedback was waiting: `feedbackSent`, `feedbackFailed`
   * (still on disk), `feedbackDropped`.
   */
  async function flushFeedback() {
    const age = async (path) => {
      try { return (await stat(path)).mtimeMs; } catch { return 0; }
    };
    const files = (await Promise.all((await queuedFilesAsync(FEEDBACK_FILE_PREFIX))
      .map(async (path) => [await age(path), path])))
      .sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    const now = Date.now();
    const stale = files.filter(([at]) => now - at > OUTCOME_MAX_AGE_MS);
    const fresh = files.filter(([at]) => now - at <= OUTCOME_MAX_AGE_MS);
    const excess = Math.max(fresh.length - OUTCOME_MAX_KEPT_UNANSWERED, 0);
    let dropped = 0;
    for (const [, path] of [...stale, ...fresh.slice(0, excess)]) {
      try { await rm(path); dropped += 1; } catch { /* kept */ }
    }
    const waiting = [];
    for (const [, path] of fresh.slice(excess)) {
      try {
        waiting.push({ path, wire: turnFeedback(
          JSON.parse(await readFile(path, "utf8"))) });
      } catch {
        // Unreadable or not ours to send; one file costs that file.
      }
    }
    if (!waiting.length || turnFeedbackRefused) {
      return dropped ? { feedbackDropped: dropped } : {};
    }
    const result = await sendReports(waiting, FEEDBACK, {
      onRefusal: refuseTurnFeedback, onAbsent: turnFeedbackAbsent,
    });
    return {
      feedbackSent: result.sent, feedbackFailed: result.failed,
      feedbackDropped: dropped + result.dropped,
    };
  }

  /**
   * The control plane refused per-turn feedback (a 403: its decision about
   * this key). Said ONCE; what is waiting stays on disk for its week, and no
   * more is queued or sent by this process. The Python SDK's
   * `_refuse_turn_feedback`.
   */
  function refuseTurnFeedback(reason) {
    if (turnFeedbackRefused) return;
    turnFeedbackRefused = true;
    logger?.warn?.(
      `[agent-flywheel] the control plane refused per-turn feedback ` +
      `(${reason}). What is waiting stays on disk and no more is sent by ` +
      `this process.`);
  }

  /**
   * The control plane has no per-turn feedback route (404, 405): it predates
   * it. Said ONCE; the sender has dropped what was waiting, and no more is
   * queued or sent by this process. The Python SDK's `_turn_feedback_absent`.
   */
  function turnFeedbackAbsent(reason) {
    if (turnFeedbackRefused) return;
    turnFeedbackRefused = true;
    logger?.warn?.(
      `[agent-flywheel] the control plane did not take per-turn feedback ` +
      `(${reason}); it may predate it. What was waiting is dropped and no ` +
      `more is sent by this process.`);
  }

  /** The files with this prefix waiting in the capture root, in name order:
   *  regular files only (a dirent is never followed through a symlink). */
  const queued = (entries, prefix) => entries
    .filter((e) => e.isFile() && e.name.startsWith(prefix)
      && e.name.endsWith(OUTCOME_FILE_SUFFIX))
    .map((e) => e.name).sort().map((name) => join(root, name));

  function queuedFiles(prefix) {
    try {
      return queued(readdirSync(root, { withFileTypes: true }), prefix);
    } catch {
      return [];
    }
  }

  /** `queuedFiles`, off the event loop, for the flush. */
  async function queuedFilesAsync(prefix) {
    try {
      return queued(await readdir(root, { withFileTypes: true }), prefix);
    } catch {
      return [];
    }
  }

  /** The outcome files waiting in the capture root, in name order. */
  function outcomeFiles() {
    return queuedFiles(OUTCOME_FILE_PREFIX);
  }

  /**
   * The control plane refused outcomes that name only an episode, for want
   * of production capture: it predates the episode join (or has it switched
   * off). Said ONCE; they stay on disk, go with the rest if capture is
   * enabled, and no more are queued or sent on those terms by this process.
   * The Python SDK's `_refuse_episode_outcomes`.
   */
  function refuseEpisodeOutcomes(reason) {
    if (episodeOutcomesRefused) return;
    episodeOutcomesRefused = true;
    logger?.warn?.(
      `[agent-flywheel] the control plane did not take outcomes reported ` +
      `for an episode (${reason}); it may predate them. They stay on disk ` +
      `and no more are sent by this process unless production capture is ` +
      `enabled.`);
  }

  /**
   * Keep at most `maxOutcomesWhileUnknown` of the outcomes waiting -- on the
   * consent answer, or (granted) on a control plane that is not taking them:
   * the oldest (by when they were written, then by name) go, with a warning
   * naming that cause. An outcome that names only an
   * episode (`namesOnlyAnEpisode`) does not wait on consent, so it is neither
   * counted nor dropped here. The Python SDK's `_cap_unanswered_outcomes`.
   */
  function capUnansweredOutcomes() {
    const files = outcomeFiles();
    if (files.length <= maxOutcomesWhileUnknown) return;
    const waiting = [];
    for (const path of files) {
      let wire;
      try { wire = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
      const episodeOnly = wire !== null && typeof wire === "object"
        && !Array.isArray(wire) && namesOnlyAnEpisode(wire);
      if (!episodeOnly) waiting.push(path);
    }
    const excess = waiting.length - maxOutcomesWhileUnknown;
    if (excess <= 0) return;
    const age = (path) => {
      try { return statSync(path).mtimeMs; } catch { return 0; }
    };
    const oldest = waiting.map((path) => [age(path), path])
      .sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
      .slice(0, excess);
    let dropped = 0;
    for (const [, path] of oldest) {
      try { rmSync(path); dropped += 1; } catch { /* kept */ }
    }
    if (dropped) {
      logger?.warn?.(mayUpload
        ? `[agent-flywheel] ${dropped} reported outcome(s) were dropped, ` +
          `oldest first: they could not be delivered, and at most ` +
          `${maxOutcomesWhileUnknown} outcomes wait for the control plane.`
        : unansweredOutcomesDropped(dropped, maxOutcomesWhileUnknown));
    }
  }

  /**
   * Drop the outcomes undelivered for a week, out loud; the rest, in name
   * order. Runs on EVERY flush, whatever consent says: the bound used to live
   * inside the upload, which runs only once consent is yes, so an outcome
   * kept while the answer was unknown -- or after a refusal -- never expired.
   * The Python SDK's `_expire_outcomes`.
   */
  async function expireOutcomes() {
    const kept = [];
    let expired = 0;
    for (const path of await queuedFilesAsync(OUTCOME_FILE_PREFIX)) {
      try {
        if (Date.now() - (await stat(path)).mtimeMs > OUTCOME_MAX_AGE_MS) {
          await rm(path, { force: true });
          expired += 1;
          continue;
        }
      } catch {
        continue;
      }
      kept.push(path);
    }
    if (expired) {
      logger?.warn?.(
        `[agent-flywheel] ${expired} reported outcome(s) could not be ` +
        `delivered for a week and were dropped.`);
    }
    return kept;
  }

  /**
   * Upload the outcomes waiting on disk (`files`, already past
   * `expireOutcomes`). Called inside `flush`, after its consent gate -- or
   * with `episodesOnly`, which sends just the outcomes that name an episode
   * and nothing else (`namesOnlyAnEpisode`), the ones consent is not the
   * question for; a 403 then stops those alone (`refuseEpisodeOutcomes`). THE
   * PYTHON SDK'S `Attachment._flush_outcomes`, rule for rule; the rules are
   * `sendReports`'s.
   *
   * `outcomesSent` counts the outcomes the control plane recorded;
   * `outcomesFailed` each outcome still on disk once; `outcomesDropped` the
   * records the control plane refused.
   */
  async function flushOutcomes(files, { episodesOnly = false } = {}) {
    const waiting = [];
    for (const path of files) {
      try {
        const wire = productionOutcome(JSON.parse(await readFile(path, "utf8")));
        if (!episodesOnly || namesOnlyAnEpisode(wire)) waiting.push({ path, wire });
      } catch {
        // Unreadable or not ours to send; one file costs that file.
      }
    }
    if (!waiting.length) return {};
    const result = await sendReports(waiting, OUTCOMES, {
      onRefusal: episodesOnly ? refuseEpisodeOutcomes : refuseUpload,
    });
    return {
      outcomesSent: result.sent, outcomesFailed: result.failed,
      outcomesDropped: result.dropped,
    };
  }

  /**
   * Send the reports waiting on disk -- outcomes or per-turn feedback, `kind`
   * says which -- and return `{sent, failed, dropped}`: the ones the control
   * plane recorded, the ones still on disk for a later flush (each counted
   * once), the ones it refused. Never throws. THE PYTHON SDK'S
   * `Attachment._send_reports`, rule for rule.
   *
   * ONE SENDER FOR BOTH ROUTES. Feedback had its own, which read every final
   * 4xx as "the route is not there" and deleted the queue for it.
   *
   * ONE SENDER FOR ALL THREE: the captured turns go through it too (`TURNS`),
   * where "deleted" means marked uploaded (`forgetBatch`) and each
   * acknowledged reply is read (`onReply`).
   *
   * THE RULES: an acknowledged batch is deleted; a 403 is the control
   * plane's decision, so sending stops (`onRefusal` is told its words) and
   * the reports stay; a blip leaves the batch for the next flush, and for a
   * kind that says `stopOnBlip` (turns) stops the flush.
   *
   * A BATCH OF ONE refused for anything but its size is kept, as a refusal
   * of the batch: alone, the two cannot be told apart.
   *
   * A REPORT REFUSED BY NAME inside an acknowledged batch (`accepted: false`
   * -- a conflicting replay, an unknown episode) would be refused again: it
   * is not sent again, it counts as dropped and not as sent, and it is said
   * BY ITS ID with the control plane's own word (`refusedByName`). An outcome
   * recorded without its note is said the same way (`notesNotStored`).
   *
   * A 4xx ABOUT THE RECORDS IS FINAL FOR THEM (`outcomeBatchRefused`). A
   * refused batch is split in halves, and BOTH halves are tried before either
   * is split again: the good ones are sent, and each bad one, once it stands
   * alone, is dropped with a warning naming the control plane's own cause.
   *
   * Unless both halves are refused with the same status and the same words:
   * then the refusal was about THE BATCH, not a record in it -- a 422 from a
   * control plane on another contract minor, a proxy's 400 -- and splitting
   * further would drop every report at two requests each. Sending stops for
   * this flush, they stay on disk (the week's expiry still applies), and the
   * cause is said once. Never when the words NAME A RECORD
   * (`refusalMayBeOfTheBatch`): a 422's location is the index within the
   * half, so two bad records at one offset of each half say the same words,
   * and the split goes on to isolate them.
   *
   * Except a 413 (`outcomeRefusedForSize`): it is about the body's SIZE, so
   * both halves of a batch too large for a proxy answer it alike, and smaller
   * parts may still pass. The split goes on; a record that draws a 413
   * standing alone is too large on its own, and is dropped with a warning
   * naming the 413 and its size.
   *
   * Splitting is bounded per flush (`OUTCOME_SPLIT_MAX_REQUESTS`); what the
   * bound leaves stays for the next.
   *
   * A 4xx about the ROUTE or the KEY (`outcomeRouteRefused`: 401, 404, 405,
   * 410) is not the records' fault either: sending stops for this flush and
   * they stay, said out loud. Unless the caller passes `onAbsent` and the
   * route is ABSENT (`routeAbsent`): then everything waiting is dropped,
   * counted as dropped, and `onAbsent` is told the words.
   */
  async function sendReports(waiting, kind, {
    onRefusal, onAbsent = null, onReply = null, forgetBatch = null,
  }) {
    // Every GROUP still to send, in order: a batch on its own, or the two
    // halves of one refused batch, which are tried together. A refused half's
    // own halves go back to the front.
    const queue = [];
    for (let i = 0; i < waiting.length; i += kind.batchMax) {
      queue.push([waiting.slice(i, i + kind.batchMax)]);
    }
    const count = (group) => group.reduce((n, b) => n + b.length, 0);
    const left = () => queue.reduce((n, group) => n + count(group), 0);
    // What "done with these" means: a report's file is deleted; a turn is
    // marked uploaded (`forgetBatch`), since the turn itself is the
    // customer's capture and stays.
    const forget = forgetBatch ?? (async (batch) => {
      for (const { path } of batch) {
        try { await rm(path, { force: true }); } catch { /* resent; deduped */ }
      }
    });
    let sent = 0;
    let failed = 0;
    let absent = 0;
    let splitRequests = 0;
    const dropped = [];
    const byName = [];
    const noteless = [];
    flushing: while (queue.length) {
      const group = queue.shift();
      const halves = group.length === 2;
      if (halves && splitRequests + 2 > OUTCOME_SPLIT_MAX_REQUESTS) {
        failed += count(group) + left();
        queue.length = 0;
        logger?.warn?.(
          `[agent-flywheel] the control plane refused ${kind.many}, ` +
          `and finding which ones reached ${OUTCOME_SPLIT_MAX_REQUESTS} ` +
          `requests in this flush; the rest stay on disk for a later flush.`);
        break;
      }
      const refused = [];
      for (let index = 0; index < group.length; index += 1) {
        const batch = group[index];
        if (halves) splitRequests += 1;
        let reply;
        try {
          reply = await transport[kind.send](agentId, batch.map((o) => o.wire));
        } catch (err) {
          // Kept by a stop: this half, the half not tried yet, a half
          // already refused beside it, the queue.
          const beside = [
            ...group.slice(index + 1).flat(),
            ...refused.flatMap((r) => r.batch),
          ];
          const untried = beside.length;
          const consent = captureRefusal(err);
          if (consent !== null) {
            onRefusal(consent);
            failed += batch.length + untried + left();
            queue.length = 0;
            break flushing;
          }
          const status = err?.statusCode ?? null;
          if (onAbsent !== null && routeAbsent(status)) {
            const gone = [...batch, ...beside, ...queue.flat(2)];
            await forget(gone);
            absent += gone.length;
            queue.length = 0;
            onAbsent(String(err?.message ?? err));
            break flushing;
          }
          if (outcomeBatchRefused(status)) {
            refused.push({ batch, status, cause: String(err?.message ?? err) });
            continue;
          }
          if (outcomeRouteRefused(status)) {
            failed += batch.length + untried + left();
            queue.length = 0;
            // A 410 is a `LeaseLost`, whose words are the detail alone: the
            // status is named either way.
            let said = String(err?.message ?? err);
            if (!said.includes(`HTTP ${status}`)) said = `HTTP ${status}: ${said}`;
            logger?.warn?.(
              `[agent-flywheel] the control plane did not take ${kind.many} ` +
              `(${said}); they stay on disk and are sent again on a ` +
              `later flush.`);
            break flushing;
          }
          if (kind.stopOnBlip) {
            failed += batch.length + untried + left();
            queue.length = 0;
            logger?.warn?.(
              `[agent-flywheel] could not upload ${kind.many} ` +
              `(${err?.message ?? err}); they stay on disk and are sent ` +
              `again on a later flush.`);
            break flushing;
          }
          failed += batch.length;
          continue;
        }
        if (onReply) onReply(reply);
        await forget(batch);
        const named = refusedByName(reply, kind).slice(0, batch.length);
        byName.push(...named);
        noteless.push(...notesNotStored(reply, kind));
        sent += batch.length - named.length;
      }
      if (halves && refused.length === 2
          && refused[0].status === refused[1].status
          && refused[0].cause === refused[1].cause
          && refusalMayBeOfTheBatch(refused[0].status, refused[0].cause)) {
        failed += refused[0].batch.length + refused[1].batch.length + left();
        queue.length = 0;
        warnWholeBatchRefusal(kind, refused[0].cause);
        break;
      }
      // A BATCH OF ONE, refused not for its size, cannot tell a refusal of
      // the record from a refusal of the batch -- a control plane on another
      // contract minor refuses every batch alike, the last record of a flush
      // included. So it is KEPT, said once as such, and the batches after it
      // still go (the Python SDK's rule). Only a record isolated by the
      // split, whose other half was taken, is known to be refused for itself
      // -- or one whose refusal names it (`refusalMayBeOfTheBatch`).
      if (!halves && refused.length === 1 && refused[0].batch.length === 1
          && refusalMayBeOfTheBatch(refused[0].status, refused[0].cause)) {
        failed += 1;
        warnWholeBatchRefusal(kind, refused[0].cause, { alone: true });
        continue;
      }
      const split = [];
      for (const { batch, status, cause } of refused) {
        if (batch.length === 1) {
          await forget(batch);
          dropped.push(outcomeRefusedForSize(status)
            ? `${cause} (${kind.one} of ${outcomeWireBytes(batch[0].wire)} ` +
              `bytes, too large to send even alone)`
            : cause);
        } else {
          const half = Math.floor(batch.length / 2);
          split.push([batch.slice(0, half), batch.slice(half)]);
        }
      }
      queue.unshift(...split);
    }
    if (dropped.length) {
      logger?.warn?.(
        `[agent-flywheel] the control plane refused ${dropped.length} ` +
        `${kind.counted}, so they were dropped and the rest of their ` +
        `batch was sent: ${[...new Set(dropped)].sort().join("; ")}`);
    }
    if (byName.length) {
      logger?.warn?.(
        `[agent-flywheel] the control plane did not record ${byName.length} ` +
        `${kind.counted}; they will not be sent again: ${byName.join(", ")}`);
    }
    if (noteless.length) {
      logger?.warn?.(
        `[agent-flywheel] the control plane recorded ${noteless.length} ` +
        `${kind.counted} without the note: ${noteless.join(", ")}`);
    }
    return { sent, failed, dropped: dropped.length + byName.length + absent };
  }

  /**
   * Say ONCE per kind and cause that the control plane refuses whole batches:
   * it holds for every flush until one side is upgraded, and a warning per
   * flush would be a week of the same line. `alone`: the batch held one
   * record, so which of the two it refused is unknown. The Python SDK's
   * `_warn_whole_batch_refusal`, word for word.
   */
  function warnWholeBatchRefusal(kind, cause, { alone = false } = {}) {
    if (batchRefusalSaid.get(kind.many) === cause) return;
    batchRefusalSaid.set(kind.many, cause);
    if (alone) {
      logger?.warn?.(
        `[agent-flywheel] the control plane refused a batch of one of the ` +
        `${kind.many} (${cause}); with nothing beside it, a refusal of the ` +
        `record cannot be told from one of the batch, so it stays on disk ` +
        `and is sent again with the next.`);
      return;
    }
    // Turns are the customer's copy and never expire; the queued reports
    // do, after a week.
    const kept = kind === TURNS
      ? "they stay on disk and are sent again on a later flush"
      : "they stay on disk, are sent again on a later flush, and are " +
        "dropped only after a week undelivered";
    logger?.warn?.(
      `[agent-flywheel] the control plane refused whole batches of ` +
      `${kind.many} (${cause}), which is about the batch, not a record in it; ` +
      `${kept}.`);
  }

  /**
   * Everything a flush sends: the captured turns, then the reported outcomes.
   * ONE SEAM FOR BOTH, because the consent question is one question. The
   * counts are the turns'; `outcomesSent` and `outcomesFailed` are added only
   * when outcomes were waiting.
   *
   * EXCEPT WHAT IS NOT ABOUT END USERS' TRAFFIC, which consent is not the
   * question for: an outcome that names only an episode the platform ran,
   * and per-turn feedback (`flushFeedback`). Those go whenever there is a
   * control plane to send to.
   *
   * THE WEEK'S EXPIRY RUNS ON EVERY FLUSH, consent or not
   * (`expireOutcomes`): an outcome kept while the answer is unknown, or
   * after a refusal, is bounded like any other.
   */
  function flush(options = {}) {
    if (inFlight) {
      // ONE COALESCED RERUN after the pass in flight, never a dropped call:
      // what was written meanwhile -- a reported outcome, a turn, the
      // shutdown's last chance -- is sent by it. Every caller arriving
      // meanwhile shares it, with the widest of their options.
      rerunOptions = rerunOptions === null ? { ...options } : {
        includeUnanswered: Boolean(rerunOptions.includeUnanswered
          || options.includeUnanswered),
        settleMs: Math.min(rerunOptions.settleMs ?? 0, options.settleMs ?? 0),
      };
      rerun ??= new Promise((resolve) => { resolveRerun = resolve; });
      return rerun;
    }
    inFlight = true;
    return drive(options);
  }

  /** One pass, then the coalesced rerun if one was asked for meanwhile;
   *  `inFlight` stays held across the hand-over. */
  async function drive(options) {
    try {
      return await flushOnce(options);
    } finally {
      if (rerunOptions !== null) {
        const next = rerunOptions;
        const resolve = resolveRerun;
        rerunOptions = null;
        rerun = null;
        resolveRerun = null;
        drive(next).then(resolve, () => resolve({ sent: 0 }));
      } else {
        inFlight = false;
      }
    }
  }

  async function flushOnce(options) {
    const counts = await flushTurns(options);
    const waiting = await expireOutcomes();
    if (mayUpload && waiting.length) {
      Object.assign(counts, await flushOutcomes(waiting));
    } else if (waiting.length && !episodeOutcomesRefused) {
      Object.assign(
        counts, await flushOutcomes(waiting, { episodesOnly: true }));
    }
    Object.assign(counts, await flushFeedback());
    return counts;
  }

  /**
   * Send the turns. A control plane that cannot be reached must not break an
   * agent that is serving users, and the turns stay on disk for next time.
   * Caller (`flush`) holds `inFlight`.
   */
  async function flushTurns({ includeUnanswered = false, settleMs = 0 } = {}) {
    // Asked while either tier is still NO, and not at all once both are
    // yes: one read per flush, the Python SDK's cadence.
    if (announced && (!mayUpload || !mayCaptureModelContent)) await recheck();
    if (!mayUpload) return { sent: 0, notPermitted: true };
    const { turns, skipped, failed: unreadable } = await pending({
      includeUnanswered,
      quietBefore: settleMs > 0 ? Date.now() - settleMs : null,
    });
    // `skipped` and `failed` only when there are some; the unreadable ones
    // are counted even when nothing else was pending -- a flush where every
    // turn failed to render is not a flush with nothing to do.
    const held = (counts) => {
      if (skipped) counts.skipped = skipped;
      if (unreadable) counts.failed = (counts.failed ?? 0) + unreadable;
      return counts;
    };
    if (!turns.length) return held({ sent: 0 });
    // THE REPORTS' RULES (`sendReports`): a 403 stops sending, in the
    // intake's own words; a batch refused for a record is split until the
    // record stands alone and only it is dropped (marked sent, never resent);
    // a turn the intake did not record (`accepted: false`) is dropped by
    // name; a transport failure or 5xx stops the flush and every turn not
    // acknowledged stays on disk. It used to be one chunk at a time: one
    // oversized or invalid turn kept its whole chunk on disk on every flush,
    // and an outage was tried chunk after chunk.
    let refused = false;
    const result = await sendReports(turns.map((wire) => ({ wire })), TURNS, {
      onRefusal: (reason) => { refused = true; refuseUpload(reason); },
      onReply: noteModelContentRefusal,
      forgetBatch: (batch) => markUploaded(batch.map(({ wire }) => wire.turn_id)),
    });
    const counts = { sent: result.sent };
    if (result.failed) counts.failed = result.failed;
    // Refused standing alone, or by name: marked sent, never resent, never
    // deleted -- the turn directory is the customer's copy.
    if (result.dropped) counts.dropped = result.dropped;
    if (refused) counts.notPermitted = true;
    return held(counts);
  }

  return {
    get mayUpload() { return mayUpload; },
    /** The turn ids the control plane already holds. */
    uploadedIds,
    get refusal() { return refusal; },
    /** The second tier: may a turn also carry what its model calls saw? */
    get mayCaptureModelContent() { return mayCaptureModelContent; },
    get modelContentReason() { return modelContentReason; },
    /** Whether this host delivers `agent_end`, i.e. whether answers arrive. */
    get answersExpected() { return answersExpected; },
    /** How many times the consent state has changed: `setVerdict`'s `since`. */
    get verdictEpoch() { return epoch; },
    /**
     * Record the control plane's verdict. Until this runs, nothing uploads.
     * `since`, when given, is `verdictEpoch` as it was when the verdict was
     * ASKED: a verdict overtaken meanwhile (a 403 arrived) is not applied.
     *
     * An ANSWERED verdict lands at `takeAnsweredVerdict`, the seam the
     * re-read lands at, so an answered no at startup deletes the outcomes an
     * earlier process kept waiting on it. Returns that promise (it never
     * rejects); the consent state has changed by the time this returns.
     */
    setVerdict(v, { since = null } = {}) {
      announced = true;
      if (since !== null && since !== epoch) return Promise.resolve();
      // `captureVerdict`'s `answered: false` is no answer.
      if (v?.answered !== false) {
        return takeAnsweredVerdict({
          mayUpload: Boolean(v?.mayUpload),
          reason: v?.reason ?? null,
          mayCaptureModelContent: v?.mayCaptureModelContent === true,
          modelContentReason: v?.modelContentReason ?? v?.reason ?? null,
        });
      }
      epoch += 1;
      mayUpload = false;
      refusal = v?.reason ?? null;
      consentRefused = false;
      mayCaptureModelContent = false;
      modelContentReason = v?.modelContentReason ?? refusal;
      return Promise.resolve();
    },
    /**
     * One turn happened. Kicks a flush when the cadence is due.
     *
     * Called from the turn's OPENING, which is the ungated half -- the mirror
     * of Python's `turn()`, which increments `_turns_since_flush` there and
     * not in `record_answer`. Counting on the answer instead would put the
     * whole cadence behind a hook the host drops by default.
     *
     * Deliberately NOT awaited by its caller: the hook that calls this is on
     * the path of a turn the customer's user is waiting for, and an upload
     * must never be between them and their answer.
     */
    note() {
      since += 1;
      if (since < flushEvery) return null;
      since = 0;
      return flush({
        includeUnanswered: !answersExpected,
        settleMs: UNANSWERED_SETTLE_MS,
      }).catch(() => ({ sent: 0 }));
    },
    flush,
    reportOutcome,
    reportTurnFeedback,
  };
}

/**
 * How long `gateway_stop` waits for its last flush. The Python SDK's
 * `_CLOSE_FLUSH_GRACE_S`: a stop must not hang on an unresponsive control
 * plane, and a turn not sent now is still on disk for the next process.
 */
export const SHUTDOWN_FLUSH_GRACE_MS = 5_000;

export const MESSAGE_RECEIVED = "message_received";
export const AGENT_END = "agent_end";
export const GATEWAY_STOP = "gateway_stop";

/**
 * Subscribe production turn capture. Called only in production mode.
 *
 * Returns `{turns, uploader, root, transport, started, rulebook,
 * rulebookRefusal}`, or `null` when nothing was wired. `transport` is null
 * without an API key; `started` is the registration chain (registration, then
 * the verdict read), or null when there was nothing to register; `rulebook` is
 * the declaration of the configured `rules`, chained after `started` and null
 * whenever `started` is; `rulebookRefusal` says why those rules are not
 * registered -- at once when they could never be sent, otherwise once
 * `rulebook` settles.
 *
 * CAPTURE RUNS WITHOUT A KEY; only UPLOADING needs one. That is the ordinary
 * first install -- local recording, no account, no traffic -- which is why the
 * message hook is subscribed before any control-plane call is attempted.
 */
export function registerTurnCapture(api, {
  config, turns, pluginId, logger = null, env = process.env,
  makeTransport = defaultTransport, declaration = null,
  // WHO IS REGISTERING: the OpenClaw plugin unless the framework API
  // (flywheel.js) says otherwise. One value, from `register()`, shared with
  // the rollout lane's registration and the describer.
  hostIdentity = OPENCLAW_HOST,
}) {
  if (!turns || typeof api?.on !== "function") return null;
  // The store's own root: one answer to where this agent's turns are, the
  // one its hooks write to.
  const root = turns.root ?? captureRoot(env, config.agentId);
  if (!env.PERCEPTEYE_CAPTURE_DIR && root !== legacyCaptureRoot(env)
      && legacyTurnsRemain(env)) {
    logger?.info?.(
      `[${pluginId}] turns an earlier release captured are in ` +
      `${legacyCaptureRoot(env)}, unkeyed by agent; they are not uploaded, ` +
      `because they cannot be attributed to one agent. This agent's turns ` +
      `are now captured to ${root}.`);
  }

  // RETENTION, only when the operator asked for it: the Python SDK's
  // `attach(retention_turns=...)`. A value that is not a whole number of turns
  // is dropped and named, never thrown -- a throw here fails the plugin load.
  const { retentionTurns, refusal: retentionRefusal } =
    retentionTurnsFrom(config.retentionTurns);
  if (retentionRefusal) {
    logger?.warn?.(`[${pluginId}] ${retentionRefusal}; nothing is pruned.`);
  }
  let sincePrune = 0;

  // ASKED ONCE, HERE, and handed to everything that needs it. Whether this
  // host will deliver `agent_end` decides two things at once -- whether the
  // operator is told answers are missing, and whether the cadence may ever
  // send a turn that has none -- and those must not be able to disagree.
  const answersExpected = conversationAccessGranted(api, pluginId);

  let uploader = null;
  let transport = null;
  // The startup chain, EXPOSED rather than fire-and-forget. `policy.js` reads
  // the control plane too, and its read is sequenced behind this one for the
  // same reason `announce` is sequenced behind `enrol`: three calls racing at
  // plugin load is three chances to be rate-limited on a cold start, and the
  // policy answer is not needed until the first turn arrives.
  let started = null;
  // The operator's `rules`, declared once after `started` -- see below.
  let rulebook = null;
  // Why those rules are not registered; null when they were, or when none are
  // configured. NAMED for every way they can go unsent -- no key, a client
  // that would not build -- and otherwise settled by `rulebook`. The Python
  // SDK's `Attachment.rulebook_refusal`, which names the same paths.
  let rulebookRefusal = null;

  // THE TURN OPENS, and this is the UNGATED half -- the only hook of the three
  // the host is guaranteed to deliver. It carries the cadence for that reason:
  // `agent_end` used to, and `agent_end` is dropped for a non-bundled plugin
  // unless the operator opts in, so in the default install the counter never
  // advanced and a gateway that never stops uploaded nothing, ever. Python
  // counts in `turn()` for the same reason. Subscribed before any
  // control-plane call is attempted, because capture runs without a key.
  api.on(MESSAGE_RECEIVED, (event, ctx) => {
    try {
      turns.onMessageReceived(event, ctx ?? {});
    } catch { /* one lost observation, never a failed turn */ }
    // NOT AWAITED. This hook sits on the path of a turn whose user is waiting;
    // an upload must never be between them and their answer.
    uploader?.note();
    // Counted here, at the turn's opening, like the upload cadence and like
    // Python's `turn()`; run after this hook returns, for the same reason.
    if (retentionTurns !== null && ++sincePrune >= PRUNE_EVERY) {
      sincePrune = 0;
      setImmediate(() => prune({ keepLast: retentionTurns }));
    }
  });

  if (config.apiKey) {
    try {
      transport = makeTransport(config);
      uploader = createTurnUploader({
        transport, agentId: config.agentId, root, logger, answersExpected,
        // The startup chain reads the verdict once the agent is registered;
        // a flush before it must not ask first and read "not registered".
        awaitAnnouncedVerdict: true,
      });
      // Model content is RECORDED only while the control plane says it may be
      // uploaded -- asked of the uploader, which holds the one live verdict.
      turns.gateModelContent?.(() => uploader.mayCaptureModelContent);
    } catch (err) {
      // `new ControlPlaneClient` refuses a missing key or base URL by design.
      // A misconfigured control plane must not take local recording down with
      // it, and `register` must not throw -- the host treats that as a failed
      // plugin load.
      //
      // With no uploader nothing below registers, so the rules are never
      // sent either -- said here, with this cause, rather than left null. The
      // capture directory is named here too: the keyless line below, which
      // names it otherwise, would say "no API key" of an install that has one.
      rulebookRefusal = uploader ? null : rulesNeverSent(config.rules,
        `the control plane could not be set up for this install ` +
        `(${err?.message ?? err})`);
      logger?.warn?.(
        `[${pluginId}] captured turns will not be uploaded: ` +
        `${err?.message ?? err}. Local recording to ${root} is unaffected.` +
        (rulebookRefusal ? ` ${sentence(rulebookRefusal)}` : ""));
    }
  }

  // THE ANSWER, and the one part that needs the operator's opt-in. Subscribed
  // regardless: if the host drops it, `api.on` reports nothing either way, and
  // a turn without its answer is still stored and graded advisory.
  //
  // It does NOT drive the cadence. It cannot: it is the hook that may not
  // arrive. And it must not count a second time when it does, or a granted
  // install would flush at twice the rate this package documents and the
  // Python SDK uses.
  api.on(AGENT_END, (event, ctx) => {
    try {
      turns.onAgentEnd(event, ctx ?? {});
    } catch { /* one lost observation */ }
  });

  if (uploader) {
    api.on(GATEWAY_STOP, () => {
      // LAST CHANCE: nothing more is coming for anything after this, so every
      // unanswered turn goes regardless of how recently it was written.
      // RETURNED, so the host -- which awaits this hook -- waits for it, at
      // most SHUTDOWN_FLUSH_GRACE_MS: an unreachable control plane must not
      // keep a gateway from stopping, and what is not sent stays on disk.
      // A flush already in flight gets this one as its coalesced rerun.
      return Promise.race([
        uploader.flush({ includeUnanswered: true }).catch(() => ({ sent: 0 })),
        new Promise((resolve) => {
          setTimeout(() => resolve({ sent: 0, timedOut: true }),
                     SHUTDOWN_FLUSH_GRACE_MS).unref?.();
        }),
      ]);
    });
    // REGISTER, THEN ASK -- in that order, and the order is the point. The
    // verdict is computed FROM the agent row, so asking first, on a first
    // start, spends the read on a question whose only possible answer is "not
    // registered". Chained rather than run alongside for the same reason:
    // concurrent calls race, and half the starts would still get that answer.
    // Neither rejects, so a refused registration still reaches the read --
    // which matters, because an operator may have consented long ago and the
    // registration may be refused for something else entirely.
    //
    // NOT AWAITED: `register()` must return to the host synchronously, and a
    // control plane that is slow or down must not delay a plugin load.
    started = enrol({ transport, config, pluginId, logger, declaration, hostIdentity })
      .then(() => announce({ transport, uploader, config, pluginId, logger, env }));
    // THE RULES, after the verdict read and OFF the chain every other startup
    // read waits on. `registerServingPolicy` reads the approved prompt and
    // model behind `started`, and a rulebook route that is slow or down --
    // four attempts of up to 30s each -- must not keep this install serving
    // its own prompt meanwhile: the rules cost the rules and nothing else.
    // The Python SDK's `attach()` declares them last, after its policy read,
    // for the same reason. So this is the one startup call allowed to OVERLAP
    // another -- it runs alongside the serving-policy read, not ahead of it --
    // and what that costs is at most a retried 429 (the client honours
    // Retry-After), where sequencing it ahead cost the approved prompt and
    // model. After a registration, whatever its outcome: the rulebook belongs
    // to the Product that declares this agent, not to the agent row.
    // `declareRulebook` never rejects, so neither does this.
    rulebook = started
      .then(() => declareRulebook({
        transport, rules: config.rules, pluginId, logger,
      }))
      .then((refusal) => { rulebookRefusal = refusal; });
  } else if (!config.apiKey) {
    rulebookRefusal = rulesNeverSent(config.rules, "no API key is configured");
    logger?.info?.(
      `[${pluginId}] capturing production turns to ${root}. No API key is ` +
      `configured, so nothing is uploaded; to upload them, ${GET_A_KEY}.` +
      (rulebookRefusal ? ` ${sentence(rulebookRefusal)}` : ""));
  }

  if (!answersExpected) {
    logger?.info?.(
      `[${pluginId}] capturing production turns WITHOUT the agent's answers: ` +
      `'${AGENT_END}' is a conversation hook and this host drops it for ` +
      `non-bundled plugins unless you set ` +
      `plugins.entries.${pluginId}.hooks.allowConversationAccess=true. Turns ` +
      `are still recorded and uploaded with their tool calls -- the cadence ` +
      `sends them once they stop changing, since no answer is coming -- and ` +
      `the control plane stores them with an explicit 'no answer' reason, but ` +
      `nothing that needs a completion can use them.`);
  }

  /**
   * Delete captured turns, the Python SDK's `Attachment.prune`: `keepLast`
   * keeps the most recent N, `olderThanS` deletes older turns, and neither
   * deletes nothing. Returns how many were deleted; never throws.
   */
  function prune({ keepLast = null, olderThanS = null } = {}) {
    try {
      return pruneTurns({
        root, keepLast, olderThanS, logger,
        uploaded: uploader?.mayUpload ? uploader.uploadedIds() : null,
        active: turns.activeTurns?.() ?? null,
      });
    } catch {
      return 0;
    }
  }

  /**
   * Tell the control plane how a turn, a conversation or an episode turned
   * out: the Python SDK's `Attachment.report_outcome`. `outcome` is one of
   * `PRODUCTION_OUTCOMES`; `turnId` is the run id the turn was captured under,
   * `conversationId` its conversation, and `episodeId` the `rolloutId` the
   * platform handed the agent with an episode it ran -- give at least one. An
   * outcome that names only an episode joins that episode's reward evidence
   * as a weak reading and needs no production-capture consent. Optional
   * `value` (a number of your own), `note` (at most 1,000 characters, masked
   * by the control plane), `occurredAt` (a `Date` or RFC 3339 string; now when
   * omitted) and `outcomeId` (this report's idempotency key; minted when
   * omitted). Throws `InvalidOutcome` for what the wire cannot carry, whether
   * or not capture is on; otherwise returns the outcome's id once queued, or
   * `null` -- a no-op -- when this agent may not upload (no key, or the
   * control plane said production capture is not enabled). While that answer
   * is still unknown the outcome is kept and the upload asks again.
   */
  function reportOutcome(outcome, options = {}) {
    if (!uploader) {
      outcomeWire(outcome, options);
      return null;
    }
    return uploader.reportOutcome(outcome, options);
  }

  /**
   * Tell the control plane what the user did with one turn of an episode:
   * the Python SDK's `Attachment.report_turn_feedback`. `signal` is one of
   * `TURN_FEEDBACK_SIGNALS`; `episodeId` is the `rolloutId` the platform
   * handed the agent with the episode and `turnIndex` the zero-based position
   * of the turn in it. Optional `occurredAt` (a `Date` or RFC 3339 string;
   * now when omitted) and `feedbackId` (this report's idempotency key; minted
   * when omitted). A WEAK LABEL and not an outcome: it scores nothing and is
   * stored apart from reported outcomes. Throws `InvalidFeedback` for what
   * the wire cannot carry (the message names the allowed words); otherwise
   * returns the feedback's id once queued, or `null` -- a no-op -- with no
   * key, or once the control plane has refused this key feedback (a 403;
   * what is waiting stays on disk) or shown it has no route for it (a 404 or
   * 405; what was waiting is dropped) -- each said once. No answer of the control plane ever reaches
   * the caller. A PRODUCTION TURN is named by `turnId` instead, and its
   * feedback is an event on its trace (`reportTurnFeedbackOnItsSpan`).
   */
  function reportTurnFeedback(signal, options = {}) {
    if (namesAProductionTurn(options) && !uploader) {
      // No control plane to upload to: its trace alone carries it.
      return reportTurnFeedbackOnItsSpan(signal, options);
    }
    if (!uploader) {
      feedbackWire(signal, options);
      return null;
    }
    return uploader.reportTurnFeedback(signal, options);
  }

  // `transport` is handed out so the serving-policy read reuses THIS client
  // rather than constructing a second one against the same base URL and key.
  return {
    turns, uploader, root, transport, started, rulebook, prune, retentionTurns,
    reportOutcome, reportTurnFeedback,
    get rulebookRefusal() { return rulebookRefusal; },
  };
}

/** The real control-plane transport. Replaced in tests, never in production. */
function defaultTransport(config) {
  return new AttachTransport(
    new ControlPlaneClient(config.controlPlaneUrl, config.apiKey),
    { agentId: config.agentId },
  );
}

/**
 * Create this agent's row, so an operator has something to switch capture ON.
 *
 * THE OTHER HALF OF THE PERMISSION STORY, and it went missing. `POST /agents`
 * is the ONLY producer of a `FlywheelAgent` row anywhere in the control plane.
 * With no row the operator's consent control
 * (`POST /flywheel-agents/{agent_id}/production-capture`) answers 404, and the
 * verdict `announce()` reads below is permanently "this agent is not
 * registered, so no operator has been able to enable production capture for
 * it. Register it first." -- a remedy naming the exact call this package had
 * stopped making. Uploading was structurally unreachable for every install.
 *
 * Replacing the permission PROBE with `GET /agents/{id}/capture` was right,
 * and it stands: asking a permission question must not write. What went with
 * it by accident was the REGISTRATION -- two different jobs that happened to
 * share one route, and only one of them survived the split. This is the other
 * one, back as its own call, which is why `announce()` still performs no write.
 *
 * `discovered_agent` -- THREE ANSWERS, one per case, each the true one, asked
 * exactly as the Python SDK's `attach()` asks them:
 *
 *   OMITTED when the customer refused introspection (`introspect: false` or
 *   PERCEPTEYE_INTROSPECT=0). The control plane records that as `disabled`,
 *   which stops the stored description driving workflow generation -- the
 *   instruction the customer gave. Omitting it for anyone else would assert a
 *   decision nobody made, which is why this used to be the one state never
 *   sent: before the switch existed, nobody could have made it.
 *
 *   THE DECLARATION, when the operator gave one (`describe`, see
 *   declaration.js): their word about the agent, and the only description
 *   this process can honestly send. The control plane keeps a stored
 *   catalogue that a declaration without tools did not observe.
 *
 *   NULL otherwise: we looked, and we have no description. `describe.js`, the
 *   only observer, writes into PERCEPTEYE_TRAJECTORY_DIR, which production
 *   mode does not set, and `llm_input` first fires on the first model call,
 *   strictly after this -- waiting for it would put registration behind a
 *   CONVERSATION hook the host drops for a non-bundled plugin by default. A
 *   production null changes nothing the control plane holds, neither the
 *   stored description nor its state (a new agent is `not_described`), so a
 *   process re-registering on every restart cannot erase what a training run
 *   established.
 *
 * NOT THE OPERATOR'S `rules`. They are their own call on their own route,
 * declared by `registerTurnCapture` after the verdict read and off the chain
 * the other startup reads wait on -- so a rulebook route that is slow or down
 * cannot hold back the verdict or the approved serving policy.
 *
 * NEVER REJECTS, and never throws into its caller. A refused or unreachable
 * control plane must not cost the verdict read, local capture (which needs no
 * account at all), or the plugin load -- the host treats a throw from
 * `register()` as a failed plugin load. The Python SDK's `attach()` splits the
 * same two calls for the same reason: a registration intake dislikes must not
 * also cost that process its policy read.
 *
 * NOT EXPORTED, unlike `announce` beside it. Its tests drive it through
 * `registerTurnCapture`, which is the path a customer actually gets, and this
 * package has already paid for one exported control-plane call that nothing
 * called: `AttachTransport.register` itself, which is the defect above.
 */
function enrol({
  transport, config, pluginId, logger = null, declaration = null,
  hostIdentity = OPENCLAW_HOST,
}) {
  return Promise.resolve()
    .then(() => transport.register({
      agent_id: config.agentId,
      // The WIRE value, which is not this package's mode vocabulary. The
      // server accepts ("rollout", "production") only, so `config.mode` --
      // whose training spelling is "training" -- would 422. A literal is safe
      // because this function is reached from the production lane alone;
      // `index.js` never constructs turn capture in training mode.
      mode: "production",
      sdk: SDK_UA,
      contract_version: CONTRACT_VERSION,
      // TRUE, and getting it wrong costs a grade reason
      // (`flywheel_does_not_report_tool_outcomes`): `after_tool_call` is
      // subscribed unconditionally and every captured call goes up in the
      // turn's `tool_calls`.
      reports_tool_calls: true,
      // This runs INSIDE the customer's own OpenClaw process; nothing is
      // spawned. The same value Python's `attach()` sends, for the same
      // reason.
      isolation: "inprocess",
      // Production mode claims no rollouts, so this reports no capacity. One
      // is what `attach()` sends.
      concurrency: 1,
      input_shape: "text",
      entrypoint: hostIdentity.entrypoint,
      // See the docstring: omitted on a refusal, the declaration when there
      // is one, and otherwise null -- never invented. Last, where it always
      // was, so an undeclared registration is the same bytes as before. The
      // framework is the host's (`hostIdentity`): OpenClaw, or the one the
      // framework API names.
      ...(config.introspect === false ? {} : {
        discovered_agent: applyDeclaration(declaration, {
          reflected: null, agentName: config.agentId,
          framework: hostIdentity.framework,
        }) ?? null,
      }),
      // Where the agent's API spec is published, when `describe` says
      // (declaration.js): a reference beside the description, never the
      // document. Absent otherwise, so an undeclared registration is the
      // same bytes as before.
      ...declarationRegistrationFields(declaration),
    }))
    .then(() => true)
    .catch((err) => {
      logger?.info?.(
        `[${pluginId}] could not register '${config.agentId}' with the ` +
        `control plane (${err?.message ?? err}); turns are still captured ` +
        `locally. Until a registration lands, no operator can enable upload ` +
        `for this agent, because the control has no agent to act on.`);
      return false;
    });
}

/**
 * Ask the control plane whether this agent may upload, and say so once.
 *
 * A READ. The verdict carries BOTH halves -- the per-agent consent an operator
 * grants in Mission Control, and whether this key carries the `turn.report`
 * scope -- so a client never learns its permission BY uploading, i.e. by
 * sending the data whose permission is in question. Until it answers,
 * `uploader.mayUpload` is false and nothing leaves the machine.
 *
 * IT USED TO BE A REGISTRATION, and that was a workaround this route removed.
 * `POST /agents` is an upsert, and a registration omitting `discovered_agent`
 * is recorded as introspection `disabled` -- which stops that agent's
 * description driving workflow generation. So asking a permission question
 * changed an unrelated column.
 *
 * THE WORKAROUND IS GONE; THE REGISTRATION IS NOT. Nothing on this path
 * writes -- re-asking costs a read and nothing else, which is the whole point
 * of the route -- but the row the verdict is computed from still has to be
 * created by somebody, and `enrol()` above is now the one that does it. When
 * that was left out, this read answered "not registered" forever. What it
 * sends as `discovered_agent` -- null, a declaration, or nothing under the
 * customer's opt-out -- is no longer a workaround for a side effect: each is
 * the honest state, for the reasons `enrol()` gives.
 */
export function announce({ transport, uploader, config, pluginId, logger }) {
  // The consent state as it stood when this read was ASKED: an answer the
  // intake gave meanwhile (a 403) is fresher, and this one does not
  // overwrite it.
  const since = uploader.verdictEpoch ?? null;
  return Promise.resolve()
    .then(() => transport.captureCurrent(config.agentId))
    .then(async (response) => {
      const v = captureVerdict(response);
      await uploader.setVerdict(v, { since });
      logger?.info?.(v.mayUpload
        ? `[${pluginId}] production capture is ENABLED for '${config.agentId}'; ` +
          `turns upload every ${FLUSH_EVERY} turns and at shutdown.`
        : `[${pluginId}] capturing locally; turns will NOT be uploaded: ${v.reason}`);
      return v;
    })
    .catch((err) => {
      logger?.info?.(
        `[${pluginId}] could not read the production-capture verdict ` +
        `(${err?.message ?? err}); nothing is uploaded and turns stay on disk.`);
      const v = {
        mayUpload: false, reason: String(err?.message ?? err), answered: false,
      };
      // UNANSWERED, not no: the flushes may now ask again themselves.
      uploader.setVerdict?.(v, { since });
      return v;
    });
}

export { conversationAccessGranted, lastAssistantText };
