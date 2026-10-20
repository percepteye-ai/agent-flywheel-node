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
import { randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { GET_A_KEY } from "./config.js";
import { applyDeclaration } from "./declaration.js";
import { FRAMEWORK } from "./describe.js";
import { nowUnixNano } from "./genai-otlp.js";
import {
  conversationAccessGranted, conversationIdOf, lastAssistantText, taskIdOf,
} from "./host.js";
import { ControlPlaneClient, SDK_UA } from "./http.js";
import { inputFromLlmInput, operationsFromRun } from "./model-boundary.js";
import { percepteyeHome } from "./session.js";
import {
  AttachTransport, declareRulebook, rulesNeverSent, sentence,
} from "./transport.js";
import { CONTRACT_VERSION } from "./wire.js";
import {
  listTurnDirs, readConversationId, readModelBoundary, readTaskId,
  recordConversationId,
  recordModelBoundary, recordTaskId, recordTurnText,
  recordExecutionFingerprint, recordExecutionFingerprintConflict, safeTurnId,
  turnDir, turnIndexOf, turnWire,
} from "./turns.js";

/** Turns between automatic upload attempts. The Python SDK's `_FLUSH_EVERY`. */
export const FLUSH_EVERY = 32;

/** Turns per request. The intake's `TURN_BATCH_MAX`. */
export const BATCH_SIZE = 64;

/**
 * Turns between automatic prunes when `retentionTurns` is set. The Python
 * SDK's `_PRUNE_EVERY`: one directory scan over many turns, so the ceiling is
 * `retentionTurns + PRUNE_EVERY`, not `retentionTurns` exactly.
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
      `not ${JSON.stringify(value) ?? String(value)}`,
  };
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
  now = Date.now(),
} = {}) {
  if (keepLast === null && olderThanS === null) return 0;
  // Newest first, so "keepLast" is a slice. With uploading on, the ones not
  // yet uploaded sort ahead of the ones that were, newest first within each.
  const pendingFirst = (e) => (uploaded && !uploaded.has(e.name) ? 1 : 0);
  const entries = listTurnDirs(root)
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
        const here = new Set(entries.map((e) => e.name).filter((n) => !gone.has(n)));
        const kept = readFileSync(index, "utf8").split("\n")
          .map((l) => l.trim()).filter((id) => id && here.has(id)).sort();
        writeFileSync(index, kept.map((id) => `${id}\n`).join(""), "utf8");
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
 * turn's own directory bumps that directory's MTIME -- and mtime is the
 * ordering key for `turn_index`. Uploading would have silently reordered every
 * conversation it touched. The Python SDK carries the same file for the same
 * reason; this is not a coincidence to be tidied away.
 */
export const UPLOADED_INDEX = ".uploaded";

/** Where captured production turns live when nothing else says. */
export function captureRoot(env = process.env) {
  return env.PERCEPTEYE_CAPTURE_DIR || join(percepteyeHome(env), "captured");
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
 */
export function createTurnCapture({ root, logger = null }) {
  let warned = false;
  // THE SECOND CONSENT TIER, asked at the moment of recording. Until the
  // uploader is wired (`gateModelContent`), and whenever the control plane
  // has not said `model_content: true`, nothing a model call saw is written.
  let mayRecordModelContent = () => false;
  // The run's first model input, from `llm_input`, held until its
  // `agent_end`. Keyed by turn id; bounded like `generatedTurnIds`, so a run
  // whose `agent_end` never arrives is forgotten rather than held forever.
  const pendingInputs = new Map();
  // Invalid host ids are never cleaned into a different caller id. They get a
  // fresh safe id, retained only long enough to keep this run's hooks joined.
  const generatedTurnIds = new Map();
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
    const runId = event?.runId ?? ctx?.runId;
    const text = event?.content;
    const turnId = turnIdFor(runId);
    if (turnId === null) return false;
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
    if (!mayRecordModelContent()) return false;
    const turnId = turnIdFor(event?.runId ?? ctx?.runId);
    if (turnId === null) return false;
    try {
      const prior = pendingInputs.get(turnId);
      // A SECOND llm_input in one run means the model saw a second prefix
      // (a retry, a re-assembly after compaction). Which one each answer
      // followed is not observable, so the run records no model boundary.
      pendingInputs.set(turnId, prior
        ? { refused: "the run assembled more than one model input" }
        : inputFromLlmInput(event, nowUnixNano())
          ?? { refused: "the model input cannot be rendered faithfully" });
      while (pendingInputs.size > 4096) {
        pendingInputs.delete(pendingInputs.keys().next().value);
      }
      return true;
    } catch {
      return false;
    }
  }

  /** The run's model calls, from its first input and its final transcript. */
  function recordRunBoundary(turnId, dir, messages) {
    const first = pendingInputs.get(turnId);
    pendingInputs.delete(turnId);
    if (!first || first.refused || !mayRecordModelContent()) return false;
    try {
      return recordModelBoundary(dir, operationsFromRun(first, messages, nowUnixNano()));
    } catch {
      return false;
    }
  }

  /** The agent's answer. */
  function onAgentEnd(event, ctx = {}) {
    const runId = event?.runId ?? ctx?.runId;
    const turnId = turnIdFor(runId);
    if (turnId === null) return false;
    const dir = turnDir(root, turnId);
    const conversationId = conversationIdOf(event, ctx);
    const taskId = taskIdOf(event, ctx);
    const wroteConversation = conversationId
      ? recordConversationId(dir, conversationId) : false;
    const wroteTaskId = taskId ? recordTaskId(dir, taskId) : false;
    const wroteBoundary = recordRunBoundary(turnId, dir, event?.messages);
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
    const runId = callCtx?.runId;
    const turnId = turnIdFor(runId);
    if (turnId === null) return null;
    const dir = turnDir(root, turnId);
    const taskId = taskIdOf(null, callCtx);
    if (taskId) recordTaskId(dir, taskId);
    const conversationId = conversationIdOf(null, callCtx);
    if (conversationId) recordConversationId(dir, conversationId);
    return dir;
  }

  /** Bind a reconciled identity to this exact host-declared turn. */
  function onExecutionIdentity(event, ctx = {}, observation) {
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

  return {
    onMessageReceived, onAgentEnd, onExecutionIdentity, onLlmInput,
    gateModelContent, resolveToolDir,
  };
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
}) {
  let since = 0;
  let inFlight = false;
  let mayUpload = false;
  let refusal = null;
  let mayCaptureModelContent = false;
  let modelContentReason = null;

  function uploadedIds() {
    try {
      return new Set(
        readFileSync(join(root, UPLOADED_INDEX), "utf8")
          .split("\n").map((l) => l.trim()).filter(Boolean),
      );
    } catch {
      return new Set();
    }
  }

  function markUploaded(ids) {
    if (!ids.length) return;
    try {
      mkdirSync(root, { recursive: true });
      const all = uploadedIds();
      for (const id of ids) all.add(id);
      writeFileSync(join(root, UPLOADED_INDEX),
                    [...all].join("\n") + "\n", "utf8");
    } catch {
      // A marker we could not write means the turn is retried next flush. The
      // intake dedupes on turn_id, so a resend is answered as a duplicate --
      // which is why failing to mark is safe and failing to SEND is the thing
      // this ordering protects.
    }
  }

  /**
   * Collect the turns worth sending right now.
   *
   * `quietBefore` is an mtime cutoff applied ONLY to unanswered turns: a turn
   * touched more recently than that may still be accruing tool calls, and
   * sending it now would mark it uploaded before it finished being written.
   * `null` means send them regardless, which is what shutdown wants.
   */
  function pending({ includeUnanswered, quietBefore = null }) {
    const already = uploadedIds();
    const out = [];
    for (const d of listTurnDirs(root)) {
      if (already.has(d.name)) continue;
      let wire;
      try {
        const cid = readConversationId(d.path);
        wire = turnWire(d.path, {
          turnIndex: cid ? turnIndexOf(root, d.name, cid) : 0,
          // Model content rides only while the control plane says it may.
          modelContentAgent: mayCaptureModelContent ? agentId : null,
        });
      } catch {
        // One unreadable turn costs that turn. A truncated trajectory is the
        // EXPECTED case here, not an exotic one.
        continue;
      }
      if (!wire) continue;
      if (wire.final_text === null) {
        if (!includeUnanswered) continue;
        if (quietBefore !== null && d.mtime > quietBefore) continue;
      }
      out.push(wire);
    }
    return out;
  }

  /**
   * Re-read the verdict. A READ, so it is safe to ask on the cadence; never
   * rejects; fails closed.
   *
   * THE PYTHON SDK'S `_recheck_capture`, rule for rule. An operator may grant
   * consent -- for turns, or for model content on an agent already uploading
   * turns -- long after this process started, and nothing else would tell it:
   * until this existed a Node install learned a grant only by restarting.
   * Turn upload is only ever turned ON here (a blip that answers nothing must
   * not revoke it; the intake's 403 does that, in `refuseUpload`); model
   * content follows any verdict the control plane actually GAVE, both ways.
   */
  async function recheck() {
    if (typeof transport?.captureCurrent !== "function") return;
    let v;
    try {
      v = captureVerdict(await transport.captureCurrent(agentId));
    } catch {
      return;
    }
    if (v.mayUpload) {
      mayUpload = true;
      refusal = null;
    } else if (v.answered) {
      refusal = v.reason;
    }
    if (v.answered) {
      mayCaptureModelContent = v.mayCaptureModelContent && mayUpload;
      modelContentReason = mayCaptureModelContent ? null : v.modelContentReason;
    }
  }

  /**
   * The intake terminally refused these turns. Stop sending, say why.
   *
   * THE PYTHON SDK'S `_refuse_upload`, and the one place `mayUpload` turns
   * false after it was true. A trace rides on a turn, so a refused turn
   * refuses its model content too: from here on no run records what its model
   * saw, until `recheck` reads a verdict that grants it again.
   */
  function refuseUpload(reason) {
    mayUpload = false;
    refusal = reason;
    mayCaptureModelContent = false;
    modelContentReason = reason;
    logger?.warn?.(
      `[agent-flywheel] the control plane refused this agent's captured ` +
      `turns and uploading has stopped: ${reason} The turns stay on disk, ` +
      `and uploading resumes on its own if capture is enabled again.`);
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
   * Send. Never rejects: a control plane that cannot be reached must not break
   * an agent that is serving users, and the turns stay on disk for next time.
   */
  async function flush({ includeUnanswered = false, settleMs = 0 } = {}) {
    if (inFlight) return { sent: 0, skipped: true };
    inFlight = true;
    try {
      // Asked while either tier is still NO, and not at all once both are
      // yes: one read per flush, the Python SDK's cadence.
      if (!mayUpload || !mayCaptureModelContent) await recheck();
      if (!mayUpload) return { sent: 0, notPermitted: true };
      const turns = pending({
        includeUnanswered,
        quietBefore: settleMs > 0 ? Date.now() - settleMs : null,
      });
      if (!turns.length) return { sent: 0 };
      let sent = 0;
      for (let i = 0; i < turns.length; i += BATCH_SIZE) {
        const chunk = turns.slice(i, i + BATCH_SIZE);
        let reply;
        try {
          reply = await transport.reportTurns(agentId, chunk);
        } catch (err) {
          const refused = captureRefusal(err);
          if (refused !== null) {
            // NOT A TRANSPORT FAILURE. Stop, in the intake's own words, and
            // leave the turns on disk; `recheck` picks consent back up.
            refuseUpload(refused);
            return { sent, notPermitted: true };
          }
          // Whole chunk unacknowledged: leave every marker unwritten so the
          // next flush retries it.
          logger?.warn?.(
            `[agent-flywheel] could not upload ${chunk.length} captured turn(s); ` +
            `they stay on disk and are retried: ${err?.message ?? err}`);
          continue;
        }
        markUploaded(chunk.map((t) => t.turn_id));
        sent += chunk.length;
        noteModelContentRefusal(reply);
      }
      return { sent };
    } finally {
      inFlight = false;
    }
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
    /** Record the control plane's verdict. Until this runs, nothing uploads. */
    setVerdict(v) {
      mayUpload = Boolean(v?.mayUpload);
      refusal = v?.reason ?? null;
      mayCaptureModelContent = mayUpload && v?.mayCaptureModelContent === true;
      modelContentReason = mayCaptureModelContent ? null
        : (v?.modelContentReason ?? refusal);
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
  };
}

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
}) {
  if (!turns || typeof api?.on !== "function") return null;
  const root = captureRoot(env);

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
      uploader.flush({ includeUnanswered: true }).catch(() => {});
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
    started = enrol({ transport, config, pluginId, logger, declaration })
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
      });
    } catch {
      return 0;
    }
  }

  // `transport` is handed out so the serving-policy read reuses THIS client
  // rather than constructing a second one against the same base URL and key.
  return {
    turns, uploader, root, transport, started, rulebook, prune, retentionTurns,
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
function enrol({ transport, config, pluginId, logger = null, declaration = null }) {
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
      entrypoint: "openclaw-plugin",
      // See the docstring: omitted on a refusal, the declaration when there
      // is one, and otherwise null -- never invented. Last, where it always
      // was, so an undeclared registration is the same bytes as before. The
      // framework is the host's: this plugin knows it runs in OpenClaw.
      ...(config.introspect === false ? {} : {
        discovered_agent: applyDeclaration(declaration, {
          reflected: null, agentName: config.agentId, framework: FRAMEWORK,
        }) ?? null,
      }),
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
  return Promise.resolve()
    .then(() => transport.captureCurrent(config.agentId))
    .then((response) => {
      const v = captureVerdict(response);
      uploader.setVerdict(v);
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
      return { mayUpload: false, reason: String(err?.message ?? err) };
    });
}

export { conversationAccessGranted, lastAssistantText };
