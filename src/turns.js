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
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { readTrajectory, TOOL_CALLS_FILENAME } from "./trajectory.js";
import { isLowerSha256 } from "./execution-identity.js";
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
 *
 * NO LENGTH CAP, as in Python. A turn cut at a fixed length is a different
 * turn from the one the agent served, and a conversation is rebuilt from
 * exactly this text. (The cap that stood here also had to count code points
 * by hand, because a UTF-16 slice could split a surrogate pair.)
 */
export function recordTurnText(dir, kind, text, ids = {}) {
  if (!TURN_KINDS.includes(kind)) {
    throw new Error(`turn kind must be one of ${TURN_KINDS}, got ${kind}`);
  }
  if (typeof text !== "string" || !text.trim()) return false;
  const record = { kind, text: text.trim() };
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

  // NO SPAN FROM HERE. A span per half-turn described neither half: the
  // turn's `invoke_agent` span is emitted once, when the turn is whole, by
  // the capture lane that knows when that is (`capture.js`).
  return true;
}

/** Record which conversation this turn belongs to. Idempotent, never throws. */
export function recordConversationId(dir, conversationId) {
  const exact = productionIdentifier(conversationId);
  if (exact === null) return false;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, CONVERSATION_ID_FILENAME),
                  exact, "utf8");
    return true;
  } catch {
    return false;
  }
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
    try {
      writeFileSync(sidecar, exact, { encoding: "utf8", flag: "wx" });
      return true;
    } catch (err) {
      if (err?.code !== "EEXIST") return false;
    }
    let current = null;
    try {
      current = readFileSync(sidecar, "utf8");
    } catch {
      current = null;
    }
    if (current === exact) return true;
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
    try {
      writeFileSync(sidecar, JSON.stringify(expected), { encoding: "utf8", flag: "wx" });
      return true;
    } catch (err) {
      if (err?.code !== "EEXIST") return false;
    }
    let current = null;
    try {
      current = JSON.parse(readFileSync(sidecar, "utf8"));
    } catch {
      current = null;
    }
    if (
      current && typeof current === "object" && !Array.isArray(current)
      && Object.keys(current).length === 1
      && current.execution_sha256 === digest
    ) return true;
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
 *   file absent             -> null  (nothing was recorded for it)
 */
export function turnWire(dir, { turnIndex = 0 } = {}) {
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

  let toolCalls;
  if (calls && calls.length) toolCalls = calls;
  else if (existsSync(join(dir, TOOL_CALLS_FILENAME))) toolCalls = [];
  else toolCalls = null;

  if (!task && !answer && !(toolCalls && toolCalls.length) && !taskId) return null;

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
  const cid = readConversationId(dir);
  if (cid) {
    wire.conversation_id = cid;
    wire.turn_index = turnIndex;
  }
  if (taskId) wire.task_id = taskId;
  const fingerprint = readExecutionFingerprint(dir);
  if (fingerprint !== null) wire.agent_fingerprint = fingerprint;
  return wire;
}

/**
 * Every turn directory under `root`, oldest first.
 *
 * ORDERED BY MTIME, which is the ordering Python derives `turn_index` from.
 * Both ends must agree, because the control plane indexes on
 * `(org, agent, conversation_id, turn_index)` and a conversation whose turns
 * all claim index 0 cannot be ordered at all.
 */
export function listTurnDirs(root) {
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const dirs = [];
  for (const name of names) {
    const path = join(root, name);
    try {
      const st = statSync(path);
      if (st.isDirectory()) dirs.push({ path, name, mtime: st.mtimeMs });
    } catch {
      // Vanished between listing and stat: a concurrent prune. Not an error.
    }
  }
  dirs.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
  return dirs;
}

/**
 * This turn's position within its conversation.
 *
 * Computed over every turn of that conversation ON DISK, not just the ones
 * being uploaded now, so a turn sent in a later batch keeps the position it
 * actually had. A counter held in memory would restart at zero on every
 * process restart -- and every turn landing at index 0 is precisely what the
 * control plane's index exists to prevent.
 */
export function turnIndexOf(root, dirName, conversationId) {
  if (!conversationId) return 0;
  const siblings = listTurnDirs(root)
    .filter((d) => readConversationId(d.path) === conversationId);
  const i = siblings.findIndex((d) => d.name === dirName);
  return i < 0 ? 0 : i;
}
