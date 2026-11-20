/**
 * A captured production turn, on disk, in the format the Python SDK already
 * writes and reads.
 *
 * ONE FORMAT, TWO IMPLEMENTATIONS. A customer deploys this package or the
 * Python one, never both -- so the two must agree, and the thing that makes
 * them agree cannot be a comment saying so. It is this: a turn is a DIRECTORY
 * named for the turn id, with the shared core files below and two optional
 * execution-identity files whose names and shapes also match Python:
 *
 *   tool_calls.jsonl   one JSON object per executed tool call  (already ours:
 *                      `trajectory.js` has written it since day one, and it is
 *                      why nothing here reimplements it)
 *   turns.jsonl        {kind:"task"|"answer", text, turn_id,
 *                       conversation_id, task_id}
 *   conversation_id    the conversation this turn belongs to, as bare text
 *   task_id            caller-authored case/work-item correlation, as text
 *   task_id.conflict   monotonic abstention when two task bindings disagree
 *   agent_fingerprint.json  an exact, SDK-reconciled execution fingerprint
 *   agent_fingerprint.conflict  permanent abstention if writers disagree
 *   genai_observation.jsonl  the turn's MODEL BOUNDARY -- what its model calls
 *                      saw and said -- written only under the control plane's
 *                      model-content consent (`genai-otlp.js`, whose reader is
 *                      the Python SDK's `observation_from_lines` rule for rule)
 *
 * The Python end is `agent_flywheel.outcomes` (`record_turn_text`,
 * `read_turn_text`, `read_conversation_id`) and `production.Attachment._turn_wire`.
 * The rules below are not restatements of that code; they are the same rules,
 * and where one is subtle the reason is given so the two do not drift apart by
 * someone "simplifying" one side.
 *
 * WHAT MAKES A TURN HERE. OpenClaw gives every agent run a `runId`, and it is
 * on all three hooks this lane uses -- `message_received` (the end user's
 * message), `after_tool_call` (event AND context), and `agent_end` (the
 * answer). So the turn boundary is DECLARED by the host rather than inferred
 * by us, which is the same standard the Python side holds: guessing where one
 * turn ends and the next begins is how one user's tool calls end up in
 * another's record.
 */
import { randomBytes } from "node:crypto";
import {
  appendFileSync, closeSync, existsSync, linkSync, mkdirSync,
  openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync,
  writeSync,
} from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { readTrajectory } from "./trajectory.js";
import { recordTurnSpan } from "./tracing.js";
import {
  OBSERVATION_FILENAME, endRecord, newSpanId, newTraceId, observationFromLines,
  operationRecord, renderTurnTrace, traceRecord,
} from "./genai-otlp.js";
import { compareStrings, isLowerSha256 } from "./execution-identity.js";
import {
  ContractError, productionIdentifier, productionTurnIdentifier,
} from "./wire.js";

export const TURNS_FILENAME = "turns.jsonl";
export const CONVERSATION_ID_FILENAME = "conversation_id";
export const TASK_ID_FILENAME = "task_id";
export const TASK_ID_CONFLICT_FILENAME = "task_id.conflict";
export const AGENT_FINGERPRINT_FILENAME = "agent_fingerprint.json";
export const AGENT_FINGERPRINT_CONFLICT_FILENAME = "agent_fingerprint.conflict";

/** The two halves of a turn. Anything else is a programming error. */
export const TURN_KINDS = ["task", "answer"];

/**
 * Matches Python's `record_turn_text(max_chars=20_000)`.
 *
 * A cap rather than the whole message, because this is a customer's end user's
 * text and a runaway paste should not put a megabyte per turn on their disk.
 * The same number on both sides, so a turn captured by either package
 * truncates at the same point and the two corpora are comparable.
 *
 * CHARS MEANS CODE POINTS, which is what `truncateChars` below exists to make
 * true -- see it for why `slice` was not that.
 */
export const MAX_TEXT_CHARS = 20_000;

/**
 * `text[:MAX_TEXT_CHARS]` as PYTHON means it: code POINTS, not UTF-16 units --
 * of text the intake can store.
 *
 * `String.prototype.slice` counts UTF-16 code units, so it truncated a
 * mostly-emoji message at HALF the documented point -- the two corpora were
 * not comparable, which is the one thing the shared constant is for. Worse, a
 * cut landing between the halves of a surrogate pair leaves a LONE SURROGATE,
 * which `JSON.stringify` writes into `turns.jsonl` and onto the wire; the
 * intake cannot encode it to UTF-8, the chunk is never acknowledged, and
 * the poisoned turn is re-sent on every flush forever. So the text is SCRUBBED
 * first, whether or not it is cut: a lone surrogate the host already handed
 * over becomes U+FFFD (`toWellFormed`), and NUL -- which the intake's text
 * columns cannot hold -- is removed. Then the walk stops at the cap: it never
 * spreads a long paste into an array of every one of its characters.
 *
 * The length guard IS the common case: code units are never fewer than code
 * points, so text under the cap in units is under it in points.
 */
export function truncateChars(text) {
  const clean = text.toWellFormed().replaceAll("\u0000", "");
  if (clean.length <= MAX_TEXT_CHARS) return clean;
  let end = 0;
  let points = 0;
  for (const ch of clean) {
    if (points === MAX_TEXT_CHARS) break;
    end += ch.length;
    points += 1;
  }
  return clean.slice(0, end);
}

/**
 * Publish a write-once sidecar at `target`: `"published"` when this call
 * wrote it, `"same"` when it already held what `same` accepts, `"different"`
 * when it holds anything else, `"failed"` when neither could be told.
 *
 * NEVER OBSERVABLE HALF-WRITTEN. `wx` creates the file EMPTY and fills it
 * after: a second writer arriving between the two read "" and recorded a
 * permanent false `.conflict` (the Python SDK measured 55% of 8 concurrent
 * writers). So the bytes go to a unique temp file (pid + random) and the temp
 * is HARD-LINKED into place -- `link` fails with EEXIST rather than
 * replacing, and the target appears with its whole content or not at all.
 * The temp is always removed. A filesystem without hard links falls back to
 * `wx`, the old behaviour, rather than recording nothing.
 *
 * NOT FSYNCED, for the reason the trajectory writer is not (the Python SDK's
 * `outcomes.py` states it): this runs inside the hook of a turn a user is
 * waiting on, an fsync costs ~30ms there (measured on APFS) against well
 * under 1ms for the whole publish, and the failure capture has to survive is
 * the process dying, which the page cache already does. Atomicity is the
 * link's, not the fsync's.
 */
export function publishSidecar(target, data, same = (current) => current === data) {
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let written = false;
  try {
    const fd = openSync(tmp, "wx");
    written = true;
    try {
      writeSync(fd, data);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, target);
      return "published";
    } catch (err) {
      if (err?.code === "EEXIST") {
        // Someone published first; compare below.
      } else if (["EPERM", "ENOTSUP", "ENOSYS", "EXDEV"].includes(err?.code)) {
        try {
          writeFileSync(target, data, { encoding: "utf8", flag: "wx" });
          return "published";
        } catch (inner) {
          if (inner?.code !== "EEXIST") return "failed";
        }
      } else {
        return "failed";
      }
    }
    let current;
    try {
      current = readFileSync(target, "utf8");
    } catch {
      return "failed";
    }
    return same(current) ? "same" : "different";
  } catch {
    return "failed";
  } finally {
    if (written) {
      try { unlinkSync(tmp); } catch { /* already gone */ }
    }
  }
}

/** One turn's directory. The directory name IS the turn id. */
export function turnDir(root, turnId) {
  const exact = safeTurnId(turnId);
  if (exact === null) {
    throw new ContractError("turn id does not match the production identifier grammar");
  }
  return join(root, exact);
}

/**
 * A turn id is host-supplied, and it becomes a path segment.
 *
 * Valid opaque ids are preserved byte-for-byte. Invalid values return null;
 * the host adapter can then mint a fresh id for that run rather than silently
 * cleaning two different caller ids into the same directory name.
 */
export function safeTurnId(value) {
  return productionTurnIdentifier(value);
}

/**
 * Append one half of a turn. Returns whether anything was written.
 *
 * NEVER THROWS. This runs inside a customer's production request, and the
 * standing rule is that a capture bug costs the observation and never the
 * turn.
 *
 * EMPTY TEXT WRITES NOTHING, rather than writing an empty record: "the agent
 * answered with silence" and "we were not given the answer" are different
 * claims, and only the second is true when there is no text. Collapsing them
 * would put an empty `final_text` on the wire, which the intake would accept
 * as a real -- and terrible -- answer.
 */
export function recordTurnText(dir, kind, text, ids = {}) {
  if (!TURN_KINDS.includes(kind)) {
    throw new Error(`turn kind must be one of ${TURN_KINDS}, got ${kind}`);
  }
  if (typeof text !== "string") return false;
  const kept = truncateChars(text.trim()).trim();
  if (!kept) return false;
  const record = { kind, text: kept };
  for (const [k, v] of Object.entries(ids)) {
    if (typeof v === "string" && v) record[k] = v;
  }
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, TURNS_FILENAME),
                   JSON.stringify(record) + "\n", "utf8");
  } catch {
    return false;
  }

  // THE OTel PROJECTION RIDES THE SAME CALL THAT WRITES THE FILE, for the
  // reason the Python SDK states at its own call site: two call sites for one
  // fact drift, and a turn that reached the trajectory but not the customer's
  // traces is the drift nobody notices until they are comparing the two.
  //
  // THIS IS WHAT MAKES A NEXT-STATE SIGNAL POSSIBLE from a customer's own
  // export. A chat span carrying the turn content is what the trace ingest
  // reads into an ordered conversation; the turn AFTER each answer is the
  // observed consequence the per-step reward model votes on. Without it an
  // export is HTTP server spans only, which record what a caller asked a
  // service to do and never what came back into the agent's context.
  //
  // It is a projection, so it happens AFTER the write and cannot cost it:
  // the file is already on disk by the time we get here.
  try {
    recordTurnSpan({
      // "task" is what the agent was ASKED, "answer" is what it ANSWERED.
      ...(kind === "task"
        ? { inputText: record.text }
        : { outputText: record.text }),
      turnId: record.turn_id,
      conversationId: record.conversation_id,
      taskId: record.task_id,
      rolloutId: record.rollout_id,
      executionSha256: record.execution_sha256,
    });
  } catch {
    // A capture bug costs the observation and never the turn -- and the file
    // is already written, so this cannot cost that either.
  }
  return true;
}

/**
 * Record which conversation this turn belongs to. Never throws; true when the
 * turn is (now or already) bound to this conversation.
 *
 * WRITTEN ONCE, published whole (`publishSidecar`). It used to be rewritten
 * by every hook of the turn, truncating it first: a reader in between saw an
 * empty file (no conversation, index 0), and the file's mtime -- the turn's
 * START, which orders its conversation (`listTurnDirs`) -- moved with every
 * tool call. The first binding stands; a different id later is refused.
 */
export function recordConversationId(dir, conversationId) {
  const exact = productionIdentifier(conversationId);
  if (exact === null) return false;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return false;
  }
  const result = publishSidecar(join(dir, CONVERSATION_ID_FILENAME), exact);
  return result === "published" || result === "same";
}

/**
 * Persist one caller-authored task/case correlation without relabelling a
 * mixed turn. This is neutral evidence only; it grants no training meaning.
 */
export function recordTaskId(dir, taskId) {
  const exact = productionIdentifier(taskId);
  if (exact === null) return false;
  const sidecar = join(dir, TASK_ID_FILENAME);
  const conflict = join(dir, TASK_ID_CONFLICT_FILENAME);
  try {
    mkdirSync(dir, { recursive: true });
    if (existsSync(conflict)) return false;
    const result = publishSidecar(sidecar, exact);
    if (result === "published" || result === "same") return true;
    if (result === "failed") return false;
    try {
      writeFileSync(conflict, "", { encoding: "utf8", flag: "wx" });
    } catch (err) {
      if (err?.code !== "EEXIST") return false;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Persist an SDK-reconciled identity without letting a second writer relabel
 * a mixed turn. A conflict marker is monotonic and makes every reader abstain.
 */
export function recordExecutionFingerprint(dir, fingerprint) {
  const digest = fingerprint?.execution_sha256;
  if (!isLowerSha256(digest)) return false;
  const expected = { execution_sha256: digest };
  const sidecar = join(dir, AGENT_FINGERPRINT_FILENAME);
  const conflict = join(dir, AGENT_FINGERPRINT_CONFLICT_FILENAME);
  try {
    mkdirSync(dir, { recursive: true });
    if (existsSync(conflict)) return false;
    const result = publishSidecar(sidecar, JSON.stringify(expected), (raw) => {
      let current = null;
      try { current = JSON.parse(raw); } catch { current = null; }
      return Boolean(current) && typeof current === "object"
        && !Array.isArray(current) && Object.keys(current).length === 1
        && current.execution_sha256 === digest;
    });
    if (result === "published" || result === "same") return true;
    if (result === "failed") return false;
    try {
      writeFileSync(conflict, "", { encoding: "utf8", flag: "wx" });
    } catch (err) {
      if (err?.code !== "EEXIST") return false;
    }
  } catch {
    return false;
  }
  return false;
}

/** Permanently invalidate a turn whose observations disagree. */
export function recordExecutionFingerprintConflict(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, AGENT_FINGERPRINT_CONFLICT_FILENAME), "", {
        encoding: "utf8", flag: "wx",
      });
    } catch (err) {
      if (err?.code !== "EEXIST") return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Read only the exact sidecar shape this SDK authors. */
export function readExecutionFingerprint(dir) {
  const conflict = join(dir, AGENT_FINGERPRINT_CONFLICT_FILENAME);
  if (existsSync(conflict)) return null;
  let value;
  try {
    value = JSON.parse(readFileSync(join(dir, AGENT_FINGERPRINT_FILENAME), "utf8"));
  } catch {
    return null;
  }
  if (
    !value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 1
    || !isLowerSha256(value.execution_sha256)
    || existsSync(conflict)
  ) return null;
  return { execution_sha256: value.execution_sha256 };
}

/**
 * Record one run's model boundary beside its turn. Never throws; returns
 * whether anything was written.
 *
 * `boundary` is `{start, end, operations}` (see `model-boundary.js`). The
 * turn's trace id and root span id are minted ONCE, with the file: a second
 * run recorded into the same turn appends to that trace rather than naming a
 * second one, because the upload carries exactly one trace per turn.
 */
export function recordModelBoundary(dir, boundary) {
  if (!boundary || !Array.isArray(boundary.operations)
      || !boundary.operations.length) {
    return false;
  }
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, OBSERVATION_FILENAME);
    const lines = [];
    // A file with no bytes yet holds no header either (a write cut off
    // before its first line): it gets one, or its trace is never readable.
    let size = 0;
    try { size = statSync(path).size; } catch { size = 0; }
    if (size === 0) {
      lines.push(traceRecord({
        traceId: newTraceId(), spanId: newSpanId(), start: boundary.start,
      }));
    }
    for (const op of boundary.operations) lines.push(operationRecord(op));
    lines.push(endRecord(boundary.end));
    appendFileSync(path, lines.join("\n") + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/** The turn's recorded model boundary, or `null` when none was recorded. */
export function readModelBoundary(dir) {
  let raw;
  try {
    raw = readFileSync(join(dir, OBSERVATION_FILENAME), "utf8");
  } catch {
    return null;
  }
  return observationFromLines(raw.split("\n"));
}

/** The conversation this turn declared, or `null`. */
export function readConversationId(dir) {
  try {
    const raw = readFileSync(join(dir, CONVERSATION_ID_FILENAME), "utf8");
    return productionIdentifier(raw) === raw ? raw : null;
  } catch {
    return null;
  }
}

/** Read an exact, non-conflicting task binding, or null. */
export function readTaskId(dir) {
  const conflict = join(dir, TASK_ID_CONFLICT_FILENAME);
  if (existsSync(conflict)) return null;
  let raw;
  try {
    raw = readFileSync(join(dir, TASK_ID_FILENAME), "utf8");
  } catch {
    return null;
  }
  return productionIdentifier(raw) === raw && !existsSync(conflict) ? raw : null;
}

/**
 * The turn's task and answer, or `null` when nothing was recorded.
 *
 * THE LAST RECORD OF EACH KIND WINS, matching Python. A turn that was answered
 * twice -- a retry, a correction -- ends with the answer that was actually
 * returned, not the one that was superseded.
 *
 * `null` (no file) is not the same as `{}` (a file recording neither half),
 * and neither is collapsed, for the same reason the tool-call tri-state is
 * not.
 */
export function readTurnText(dir) {
  let raw;
  try {
    raw = readFileSync(join(dir, TURNS_FILENAME), "utf8");
  } catch {
    return null;
  }
  const out = {};
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (TURN_KINDS.includes(rec?.kind) && typeof rec.text === "string") {
        out[rec.kind] = rec.text;
      }
    } catch {
      // A truncated final write costs that record and nothing else -- the same
      // per-line recovery the tool-call reader does.
    }
  }
  return out;
}

/**
 * One captured turn in the intake's wire shape, or `null` if it is empty.
 *
 * TURN-NATIVE, NOT CORPUS-SHAPED. What crosses the boundary is what the agent
 * observed -- the user's message, the answer, the calls. Projecting into a
 * training-row format happens on the control plane's side, where it can change
 * without a customer redeploying.
 *
 * THE TOOL-CALL TRI-STATE is asked of the FILE, not of whether this plugin
 * happens to be recording. Python had a bug here worth not repeating: it
 * answered `[] if adapters_bound else None`, which reports on whether capture
 * was configured at attach time and says nothing about whether THIS turn
 * recorded anything -- so a turn whose trajectory was never written went up as
 * a positive assertion that the agent made zero calls. An observation nobody
 * made.
 *
 *   rows present            -> the calls
 *   file present, no rows   -> []    (it ran and called nothing)
 *   file absent/unreadable  -> null  (nothing was recorded for it)
 */
export function turnWire(dir, { turnIndex = 0, modelContentAgent = null } = {}) {
  const turnId = productionTurnIdentifier(basename(dir));
  if (turnId === null) {
    throw new ContractError(
      "captured turn id is not representable on the flywheel/1 wire",
    );
  }
  const text = readTurnText(dir) || {};
  const { calls, malformed } = readTrajectory(dir);
  const answer = text.answer ?? null;
  const task = text.task ?? null;
  const taskId = readTaskId(dir);
  const cid = readConversationId(dir);

  // `readTrajectory`'s own tri-state: `null` when there is no file OR it
  // could not be read -- the Python SDK's `Trajectory.read` reads an
  // unreadable file as no observation, and `[]` would assert one: "it ran
  // and called nothing".
  const toolCalls = calls;

  // WHAT THE MODEL SAW AND SAID, when this turn recorded it -- and only when
  // the caller says model content may be uploaded now, by naming the agent it
  // is uploaded for (`modelContentAgent`). Rendered from the turn's own record
  // every time, so a retried upload carries the same trace; its conversation
  // id is the wire's, from the same file, because the intake refuses a trace
  // that names any other.
  const genaiTrace = modelContentAgent
    ? renderTurnTrace(readModelBoundary(dir), {
      agentName: modelContentAgent, conversationId: cid,
    })
    : null;

  if (!task && !answer && !(toolCalls && toolCalls.length) && !taskId
      && genaiTrace === null) return null;

  const wire = {
    // `basename`, not `split("/")`. The turn id is the DIRECTORY NAME, and on
    // win32 `join` builds paths with `\`, so splitting on a hardcoded "/"
    // returned the whole absolute path: an operator's home directory went onto
    // the wire as the turn id, and it could never match the bare `d.name` that
    // `createTurnUploader` writes into `.uploaded` -- so no turn was ever
    // considered uploaded and every flush re-sent the entire capture root.
    turn_id: turnId,
    input_text: task,
    final_text: answer,
    tool_calls: toolCalls,
    tool_calls_omitted_count: malformed,
  };
  if (cid) {
    wire.conversation_id = cid;
    wire.turn_index = turnIndex;
  }
  if (taskId) wire.task_id = taskId;
  const fingerprint = readExecutionFingerprint(dir);
  if (fingerprint !== null) wire.agent_fingerprint = fingerprint;
  // OMITTED, never null, when there is none: a turn that recorded no model
  // boundary keeps exactly the bytes it always had.
  if (genaiTrace !== null) wire.genai_trace = genaiTrace;
  return wire;
}

/**
 * Every turn directory under `root`, least recently written first: `mtime`
 * is the DIRECTORY's, which says when a file was last created in it --
 * retention's "most recently written". Not the order of a conversation: that
 * is when each turn STARTED (`turnStartedAt`).
 *
 * Directories only, never through a symlink: a link in the capture root is
 * not a turn this package wrote, and following it read -- and uploaded, and
 * pruned -- whatever it pointed at. Ties broken by code point
 * (`compareStrings`), Python's order, never by locale.
 */
export function listTurnDirs(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    try {
      dirs.push({ path, name: entry.name, mtime: statSync(path).mtimeMs });
    } catch {
      // Vanished between listing and stat: a concurrent prune. Not an error.
    }
  }
  dirs.sort((a, b) => a.mtime - b.mtime || compareStrings(a.name, b.name));
  return dirs;
}

/**
 * When this turn STARTED, for ordering its conversation: the Python SDK's
 * `_started_at`, rule for rule. THE `conversation_id` FILE'S mtime, written
 * once when the turn is first bound (`recordConversationId`), NOT the
 * directory's -- a directory's mtime moves whenever a file is created in it,
 * and a turn creates files long after it began (its answer, its first tool
 * call), so ordering by it put a turn answered late AFTER the turn that
 * followed it. Falls back to the directory's mtime, then 0.
 */
export function turnStartedAt(path) {
  try {
    return statSync(join(path, CONVERSATION_ID_FILENAME)).mtimeMs;
  } catch { /* none */ }
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** `turnStartedAt`, asynchronously, for the flush path. */
async function turnStartedAtAsync(path) {
  try {
    return (await stat(join(path, CONVERSATION_ID_FILENAME))).mtimeMs;
  } catch { /* none */ }
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

/** The conversation order: start, then turn id by code point. */
const byStart = (a, b) => a.startedAt - b.startedAt || compareStrings(a.name, b.name);

/**
 * Every turn under `root` as `{name, path, conversationId, startedAt}`, in
 * the order they started -- ONE LISTING, read with `fs.promises` a bounded
 * number at a time, for the flush. It used to be a synchronous listing PER
 * TURN (`turnIndexOf` inside the pending loop), O(turns x turns) blocking
 * syscalls on the event loop the customer's agent is serving from: 15.6 s at
 * 5,000 turns. Directories only, never through a symlink.
 */
export async function scanTurns(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries.filter((e) => e.isDirectory());
  const out = [];
  for (let i = 0; i < dirs.length; i += 64) {
    out.push(...await Promise.all(dirs.slice(i, i + 64).map(async (e) => {
      const path = join(root, e.name);
      let conversationId = null;
      try {
        const raw = await readFile(join(path, CONVERSATION_ID_FILENAME), "utf8");
        conversationId = productionIdentifier(raw) === raw ? raw : null;
      } catch { /* none */ }
      return {
        name: e.name, path, conversationId,
        startedAt: await turnStartedAtAsync(path),
      };
    })));
  }
  return out.sort(byStart);
}

/**
 * Each turn's position within its conversation, from one `scanTurns`
 * listing: a Map of turn name to index. A turn with no conversation is not
 * in it (its index is 0 and is not sent).
 */
export function turnIndices(turns) {
  const next = new Map();
  const index = new Map();
  for (const t of [...turns].sort(byStart)) {
    if (!t.conversationId) continue;
    const i = next.get(t.conversationId) ?? 0;
    index.set(t.name, i);
    next.set(t.conversationId, i + 1);
  }
  return index;
}

/**
 * When anything in this turn was last WRITTEN: the newest mtime of the files
 * in its directory, or of the directory itself. Appending to a file -- every
 * tool call after the first -- moves that file's mtime and NOT the
 * directory's, so the directory alone said a turn still being worked was
 * quiet. Asynchronous: it is asked on the flush path. 0 when unreadable.
 */
export async function lastWrittenAt(path) {
  let newest = 0;
  try {
    newest = (await stat(path)).mtimeMs;
    for (const name of await readdir(path)) {
      try {
        const m = (await stat(join(path, name))).mtimeMs;
        if (m > newest) newest = m;
      } catch { /* vanished */ }
    }
  } catch { /* unreadable */ }
  return newest;
}

/**
 * This turn's position within its conversation.
 *
 * Computed over every turn of that conversation ON DISK, not just the ones
 * being uploaded now, so a turn sent in a later batch keeps the position it
 * actually had. A counter held in memory would restart at zero on every
 * process restart -- and every turn landing at index 0 is precisely what the
 * control plane's index exists to prevent. Ordered by when each turn STARTED
 * (`turnStartedAt`), the Python SDK's `_turn_index`. Synchronous, for one
 * turn; the flush computes every turn's at once (`scanTurns`, `turnIndices`).
 */
export function turnIndexOf(root, dirName, conversationId) {
  if (!conversationId) return 0;
  const siblings = listTurnDirs(root)
    .filter((d) => readConversationId(d.path) === conversationId)
    .map((d) => ({ ...d, startedAt: turnStartedAt(d.path) }))
    .sort(byStart);
  const i = siblings.findIndex((d) => d.name === dirName);
  return i < 0 ? 0 : i;
}
