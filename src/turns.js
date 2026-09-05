/**
 * A captured production turn, on disk, in the format the Python SDK already
 * writes and reads.
 *
 * ONE FORMAT, TWO IMPLEMENTATIONS. A customer deploys this package or the
 * Python one, never both -- so the two must agree, and the thing that makes
 * them agree cannot be a comment saying so. It is this: a turn is a DIRECTORY
 * named for the turn id, holding at most three files, and both packages write
 * and read exactly these:
 *
 *   tool_calls.jsonl   one JSON object per executed tool call  (already ours:
 *                      `trajectory.js` has written it since day one, and it is
 *                      why nothing here reimplements it)
 *   turns.jsonl        {kind:"task"|"answer", text, turn_id, conversation_id}
 *   conversation_id    the conversation this turn belongs to, as bare text
 *
 * The Python end is `percepteye_agent_flywheel.outcomes` (`record_turn_text`,
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
import { join } from "node:path";

import { readTrajectory } from "./trajectory.js";

export const TURNS_FILENAME = "turns.jsonl";
export const CONVERSATION_ID_FILENAME = "conversation_id";

/** The two halves of a turn. Anything else is a programming error. */
export const TURN_KINDS = ["task", "answer"];

/**
 * Matches Python's `record_turn_text(max_chars=20_000)`.
 *
 * A cap rather than the whole message, because this is a customer's end user's
 * text and a runaway paste should not put a megabyte per turn on their disk.
 * The same number on both sides, so a turn captured by either package
 * truncates at the same point and the two corpora are comparable.
 */
export const MAX_TEXT_CHARS = 20_000;

/** One turn's directory. The directory name IS the turn id. */
export function turnDir(root, turnId) {
  return join(root, safeTurnId(turnId));
}

/**
 * A turn id is host-supplied, and it becomes a path segment.
 *
 * Mirrors `session.js:safeSegment` in intent -- a `runId` that contained a
 * separator would write outside the root. Kept as its own function because
 * this one must never change shape: the segment IS the turn id on the wire,
 * so a rename here silently re-identifies turns.
 */
export function safeTurnId(value) {
  const cleaned = [...String(value ?? "")]
    .filter((c) => /[A-Za-z0-9_.-]/.test(c)).join("").slice(0, 200);
  // A NAME OF ONLY DOTS IS NOT A NAME. `.` is in the allowed set so an id like
  // `run.1` survives intact -- and that is exactly what let `..` through the
  // filter unchanged, making `join(root, "..")` the PARENT of the capture
  // root. `session.js:safeSegment` never had this hole because it does not
  // allow dots at all; adding them here re-opened it, and a test asserting the
  // property rather than probing the filesystem is what caught it.
  if (/^\.*$/.test(cleaned)) return "unknown";
  return cleaned || "unknown";
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
  if (typeof text !== "string" || !text.trim()) return false;
  const record = { kind, text: text.trim().slice(0, MAX_TEXT_CHARS) };
  for (const [k, v] of Object.entries(ids)) {
    if (typeof v === "string" && v) record[k] = v;
  }
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, TURNS_FILENAME),
                   JSON.stringify(record) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Record which conversation this turn belongs to. Idempotent, never throws. */
export function recordConversationId(dir, conversationId) {
  if (!conversationId) return false;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, CONVERSATION_ID_FILENAME),
                  String(conversationId), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** The conversation this turn declared, or `null`. */
export function readConversationId(dir) {
  try {
    return readFileSync(join(dir, CONVERSATION_ID_FILENAME), "utf8").trim() || null;
  } catch {
    return null;
  }
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
  const text = readTurnText(dir) || {};
  const { calls, malformed } = readTrajectory(dir);
  const answer = text.answer ?? null;
  const task = text.task ?? null;

  let toolCalls;
  if (calls && calls.length) toolCalls = calls;
  else if (existsSync(join(dir, "tool_calls.jsonl"))) toolCalls = [];
  else toolCalls = null;

  if (!task && !answer && !(toolCalls && toolCalls.length)) return null;

  const wire = {
    turn_id: dir.split("/").pop(),
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
