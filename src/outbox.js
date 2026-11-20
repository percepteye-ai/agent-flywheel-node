/**
 * THE OUTBOX: a rollout's outcome is written down BEFORE it is sent.
 *
 * ── THE INCIDENT THIS EXISTS FOR ──────────────────────────────────────────
 *
 * Every rollout on one OPSD queue came back `status=abandoned` /
 * `exclusion_reason=deadline_exceeded` with zero inference calls. Only the
 * control plane's reaper writes `abandoned`; its result route sets `reported`
 * unconditionally for an ordinary rollout. So the SDK's report never landed --
 * and nothing anywhere said so. The Python SDK's runner had several terminal
 * paths that returned WITHOUT reporting, each emitting an event into a hook
 * production had never wired, after which a cleanup deleted the trajectory.
 * Nothing on the row, nothing on disk, nothing in the log. WHICH path fired
 * was never determined, and the fix deliberately does not depend on knowing:
 * the IDENTICAL SILENCE was the defect.
 *
 * This lane had the same hole, reached a different way. `onAgentEnd` awaited
 * `transport.report` inside a `try`, and its `catch` logged one warning and
 * returned null. A control plane that was briefly down, a key missing the
 * `rollout.report` scope, a process killed mid-POST, a payload the wire could
 * not carry -- every one of those ended with the agent's entire work product
 * held in a local variable that then went out of scope.
 *
 * ── WHAT THIS MODULE GUARANTEES ───────────────────────────────────────────
 *
 *   SPOOL BEFORE SEND     the outcome is on disk before the first network
 *                         call, so a process killed mid-POST still delivers.
 *   DRAIN BEFORE CLAIM    held results go out before more work is claimed
 *                         (`rollout.js:claim`, the one claim seam).
 *   RESTART RECOVERY      a result the producing process could not deliver is
 *                         delivered by the next process over the same
 *                         directory.
 *   RETIRED, NEVER DESTROYED  a refusal redelivery can never fix writes the
 *                         reason into the record, renames it OUT of the retry
 *                         set under a named suffix, and NEVER unlinks it.
 *   NO BEARER CREDENTIAL ON DISK  the lease token lives only in this process's
 *                         memory. See `tokens` below.
 *   ONE BAD FILE IS NOT AN OUTAGE  a poisoned or unreadable spool file is
 *                         quarantined and named; the drain carries on and the
 *                         claim behind it still happens.
 *   RETIRED NAMES ARE UNIQUE  a second retirement of the same rollout id gets
 *                         its own file. A plain rename would clobber the
 *                         first -- the same silent loss, one layer down.
 *   ONE SENDER PER FILE   in this process (`busy`: a delivery of an id waits
 *                         for the one already sending it, and a drain skips
 *                         it) and across processes sharing the directory (a
 *                         `<file>.claim` created O_EXCL before a file is read
 *                         or sent, removed after; one older than
 *                         `CLAIM_STALE_MS` was left by a process that died
 *                         and is taken over -- that claim only, never a
 *                         fresh one made meanwhile). Without it two workers sent one
 *                         result twice, and one of them wrote back a record
 *                         the other had already delivered and deleted.
 *   WRITTEN WHOLE         a record goes to a temp file named by pid and nonce,
 *                         is fsynced, and is renamed into place, so no two
 *                         writers share a temp file and a crash leaves either
 *                         the old record or the new one.
 *   AN OUTAGE STOPS THE PASS  the first held result the control plane could
 *                         not take for a transport failure, 429 or 5xx ends
 *                         the drain: the rest would fail the same way, each
 *                         after the client's own retries, in front of a claim.
 *
 * ── WHAT IS SPOOLED ───────────────────────────────────────────────────────
 *
 * The SDK's own report object (`{finalText, success, llmCallCount,
 * agentFingerprint}`), not the flywheel/1 wire payload. That is deliberate:
 * redelivery then calls `transport.report` exactly as the first attempt did,
 * so there is no second encoder to keep in step with the first. What the
 * record adds around it is an envelope whose key names match the Python SDK's
 * outbox (`schema`, `rollout_id`, `first_seen_ts`, `attempts`, `last_error`),
 * so an operator debugging one SDK can read the other's file.
 *
 * NOT part of the execution descriptor, and it must never become part of it:
 * `execution-identity.js` and its Python twin hash the SAME descriptor under
 * the same domain separators, and a digest that moved on one side only would
 * be worse than the defect this closes.
 */
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync,
  readFileSync, renameSync, statSync, unlinkSync, writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

import { lockId, takeOverStale } from "./credentials.js";
import { LeaseLost } from "./errors.js";
import { percepteyeHome } from "./session.js";
import { quoteIdentifier } from "./transport.js";
import {
  ContractError, MAX_REPORTED_CHECKS, checksNotCarried, checksOverLimit,
  checksToWire, rolloutOutputToWire, seedsToWire, terminationToWire,
} from "./wire.js";

const EVIDENCE_PARTS = [
  ["checks", checksToWire],
  ["termination", terminationToWire],
  ["seeds", seedsToWire],
];

/**
 * Version tag on a spooled outcome. A file written by a future SDK with a
 * different shape (`percepteye.outbox/<anything else>`) is left alone where it
 * is -- not sent, not moved, not rewritten -- rather than half-read, so the SDK
 * that wrote it still finds it.
 */
export const OUTBOX_SCHEMA = "percepteye.outbox/v1";
const SCHEMA_FAMILY = "percepteye.outbox/";

/**
 * A claim older than this was left by a process that died holding it, and is
 * taken over. Longer than any one send can take (the client's retries,
 * `http.js`, end well inside it), so a live sender's claim is never taken.
 */
export const CLAIM_STALE_MS = 15 * 60 * 1000;

/**
 * Held results older than this stop being retried and are moved aside, named.
 *
 * Long, because what is being protected is a rollout's entire work product and
 * the usual cause of a week-long refusal is a credential someone has to
 * reissue by hand. Bounded at all, because a retry set that only ever grows is
 * the delivery mechanism turning into the outage: every claim would drag a
 * longer drain behind it.
 */
export const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/**
 * Refusals that redelivering the SAME BYTES cannot change.
 *
 * 404 (no such rollout), 409 (a different result already landed), 410 (the
 * lease/identity fence), 400 and 422 (the payload itself). Everything else --
 * 401 and 403 above all -- stays IN the retry set, because a reissued key
 * delivers it.
 *
 * This decides which SET THE FILE IS IN and nothing else. The work always
 * survives: "cannot be delivered" is a reason to stop trying, not a licence to
 * destroy the only copy of what a customer's agent actually did.
 */
export const REDELIVERY_CANNOT_FIX = new Set([400, 404, 409, 410, 422]);

/** The digest a segment falls back to, as lowercase hex. A string that is not
 * well-formed UTF-16 (a lone surrogate) is hashed as its UTF-16 code units:
 * as UTF-8 every lone surrogate became U+FFFD, so two different ids hashed
 * alike. */
function digest(raw) {
  const bytes = raw.isWellFormed() ? Buffer.from(raw, "utf8") : Buffer.from(raw, "utf16le");
  return createHash("sha256").update(bytes).digest("hex");
}

/** The segment this SDK used before 0.5.0, to find an outbox it left. */
function legacySegment(raw) {
  if (!raw.isWellFormed()) return null;
  const quoted = quoteIdentifier(raw);
  return quoted.length > 120 || quoted.length === 0 || /^\.+$/.test(quoted)
    ? digest(raw)
    : quoted;
}

/**
 * An opaque identifier, as ONE path segment.
 *
 * INJECTIVE, which a "clean it up" filter is not: two ids that differed only
 * in stripped characters would land on one path, and the second result would
 * silently overwrite the first -- exactly the loss this module exists to end.
 * So the id is percent-encoded with the SAME rule that already turns it into a
 * URL segment, rather than filtered. A dot segment (`.`, `..`) is a directory
 * rather than a name, and an id too long to be a filename would be truncated
 * by the filesystem into a collision; both fall back to the digest, which is
 * injective for anything that will ever be seen here.
 *
 * INJECTIVE ON A CASE-INSENSITIVE FILESYSTEM TOO (APFS, NTFS by default). `R-1`
 * and `r-1` encode to two names that are ONE file there. An id with an ASCII
 * capital therefore carries its digest, lowercase, after a `+` -- a character
 * the encoding never produces -- and an id without one cannot fold onto any
 * other: its letters are lowercase and its escapes' hex uppercase, both fixed.
 *
 * NEVER THROWS. An id that is not well-formed Unicode (a lone surrogate) has
 * no percent-encoding, and `encodeURIComponent` threw on it; it is named by
 * its digest after a `+`, which no other branch's name starts with.
 *
 * ONE RULE FOR BOTH THINGS THAT BECOME PATHS -- the agent, which names the
 * directory, and the rollout, which names the file. `safeSegment` was the
 * obvious reach for the agent half and is the wrong predicate for it: it
 * strips rather than encodes, so two agents sharing one PERCEPTEYE_HOME and
 * differing only by a dot would share one outbox and replay each other's
 * results, which is the thing keying by agent is for.
 */
export function pathSegment(value) {
  const raw = String(value ?? "");
  if (!raw.isWellFormed()) return `+${digest(raw)}`;
  const quoted = quoteIdentifier(raw);
  if (quoted.length > 120 || quoted.length === 0 || /^\.+$/.test(quoted)) {
    return digest(raw);
  }
  return /[A-Z]/.test(raw) ? `${quoted}+${digest(raw)}` : quoted;
}

/** Where this agent's undelivered results wait. Keyed by AGENT, because two
 * installs sharing one home would otherwise replay each other's results.
 *
 * An outbox an older SDK left under the agent's previous segment (only an id
 * with a capital letter is named differently now) is moved to the new name
 * the first time it is asked for, so the results it holds are not orphaned. */
export function outboxDir(agentId, env = process.env) {
  const raw = String(agentId ?? "agent");
  const root = join(percepteyeHome(env), "outbox");
  const dir = join(root, pathSegment(raw));
  const old = legacySegment(raw);
  if (old !== null && join(root, old) !== dir) {
    try {
      if (existsSync(join(root, old)) && !existsSync(dir)) renameSync(join(root, old), dir);
    } catch { /* the old outbox stays where it is, still named */ }
  }
  return dir;
}

/** One opaque rollout id, as one filename. */
export function spoolName(rolloutId) {
  return `${pathSegment(rolloutId)}.json`;
}

/**
 * A durable outbox bound to one directory.
 *
 * `send` is the ONE way out -- `(rollout, output) => Promise` -- so the first
 * attempt and every redelivery take the identical route. It is handed a
 * rebuilt `{rolloutId, leaseToken}` on BOTH, because that is all
 * `AttachTransport.report` reads and because a first attempt with more fields
 * than a redelivery is two code paths wearing one name.
 */
export function createOutbox({
  dir, send, logger = null, now = () => Date.now(),
}) {
  if (!dir) throw new Error("an outbox directory is required");
  if (typeof send !== "function") throw new Error("an outbox send is required");

  /**
   * rolloutId -> lease token. IN MEMORY, NEVER ON DISK.
   *
   * The token is a bearer credential: it authorises reporting and abandoning
   * this rollout. The spool sits under the same home the customer's own agent
   * can read -- it runs as this uid, so no file mode fences it out -- and any
   * sweep of that tree into a bundle would have carried the credential with
   * it.
   *
   * Nothing real is lost by keeping it here. Redelivery inside THIS process
   * still has the token, and that is the only redelivery that could ever have
   * used one: a token spooled to outlive its process is a lease the control
   * plane's reaper has already cleared, so the report goes without it and the
   * refusal is recorded honestly.
   */
  const tokens = new Map();

  /**
   * rolloutId -> the promise of the send this process is making for it right
   * now. A drain skips the id; a `deliver` of the same id WAITS for it, so the
   * two never write one file at once and the second never finds its record
   * deleted under it by the first one's success.
   */
  const busy = new Map();

  /** Future-schema files already named once, so a drain does not warn on
   * every pass about a file it is deliberately leaving alone. */
  const named = new Set();

  const warn = (message) => {
    // A logger is the host's, and a host that throws from one must not be able
    // to stop a result being delivered.
    try { logger?.warn?.(message); } catch { /* telemetry, not the outcome */ }
  };

  const pathFor = (rolloutId) => join(dir, spoolName(rolloutId));

  function writeRecord(path, record) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode applies only when it CREATES the directory, and an outbox
    // from an earlier run is already there.
    try { chmodSync(dir, 0o700); } catch { /* best effort, never the answer */ }
    // Write-then-rename: a half-written result is worse than none, because it
    // reads as a poisoned file and retires work that was actually fine. The
    // temp name is this writer's own (pid and nonce), so two writers never
    // share one, and the bytes are on disk before the rename publishes them.
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify(record));
      fsyncSync(fd);
      closeSync(fd);
      renameSync(tmp, path);
    } catch (err) {
      try { closeSync(fd); } catch { /* already closed */ }
      try { unlinkSync(tmp); } catch { /* never created, or renamed */ }
      throw err;
    }
  }

  /**
   * Claim `path` for this process: the name of the claim, or `null` when a
   * live claim is held elsewhere. `""` when no claim CAN be made (the
   * directory is not there because the spool write failed): there is then no
   * file for anyone else to send either.
   */
  function acquire(path) {
    const claim = `${path}.claim`;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      return "";
    }
    for (let tries = 0; tries < 2; tries += 1) {
      try {
        const fd = openSync(claim, "wx", 0o600);
        const nonce = `${process.pid}.${randomBytes(6).toString("hex")}`;
        try { writeSync(fd, nonce); } finally { closeSync(fd); }
        return `${claim}\n${nonce}`;
      } catch (err) {
        if (err?.code !== "EEXIST") return "";
      }
      // Held. Taken over only when it is stale, and only the claim judged
      // stale (`takeOverStale`, the credentials lock's rule): two processes
      // cannot both take one claim over, and a fresh claim another process
      // made meanwhile is put back rather than removed.
      const judged = lockId(claim);
      let age;
      try { age = now() - statSync(claim).mtimeMs; } catch { continue; }
      if (judged === null || !(age > CLAIM_STALE_MS)) return null;
      takeOverStale(claim, judged);
    }
    return null;
  }

  /** Release a claim `acquire` made, if it is still ours. */
  function release(held) {
    if (!held) return;
    const [claim, nonce] = held.split("\n");
    try {
      if (readFileSync(claim, "utf8") === nonce) unlinkSync(claim);
    } catch { /* already gone */ }
  }

  /**
   * Read one spooled outcome: `{record}`, `{future: true}` for a file a newer
   * SDK wrote (left alone), or `null` if it is not one anybody can send.
   */
  function readRecord(path) {
    let record;
    try {
      record = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    if (record.schema !== OUTBOX_SCHEMA) {
      return typeof record.schema === "string" && record.schema.startsWith(SCHEMA_FAMILY)
        ? { future: true }
        : null;
    }
    if (typeof record.rollout_id !== "string" || !record.rollout_id) return null;
    if (!record.output || typeof record.output !== "object") return null;
    // A record written before the token came off disk still holds one. Dropped
    // on the way in, so it never re-enters memory and the next write-back of
    // this record leaves the credential nowhere.
    delete record.lease_token;
    return { record };
  }

  /**
   * Stop retrying a file without deleting the work it holds.
   *
   * The name is RESERVED BEFORE THE RENAME. `renameSync` onto a bare
   * `<id>.json.<why>` silently replaces it, so a rollout refused a second time
   * -- a retried task, or a restart that re-spools the same id -- would
   * destroy the first retired record. Uniquified instead: `.refused-410`, then
   * `.refused-410.1`, and no copy is ever lost to a later one. A reservation
   * the rename could not fill is removed, so a failed move never leaves an
   * empty file behind.
   */
  function moveAside(path, why) {
    const base = `${path}.${why}`;
    let target = base;
    for (let ordinal = 1; ; ordinal += 1) {
      try {
        // "wx" is O_CREAT|O_EXCL: it fails rather than truncating, so two
        // retirements can never collapse onto one file.
        closeSync(openSync(target, "wx", 0o600));
        break;
      } catch (err) {
        if (err?.code !== "EEXIST") return path;
        target = `${base}.${ordinal}`;
      }
    }
    try {
      renameSync(path, target);
    } catch {
      try { unlinkSync(target); } catch { /* nothing to leave behind */ }
      return path;
    }
    return target;
  }

  /**
   * What becomes of one spooled outcome's FILE. Three fates and no fourth.
   *
   *   DELIVERED  the control plane has it, so the copy goes.
   *   RETIRED    this SDK will not send it again. The record is written back
   *              FIRST, so the file an operator opens says what refused it,
   *              and is then renamed out of the `*.json` retry set.
   *   neither    still in the retry set, with what we now know about it.
   *
   * Returns where the record lives now, so a warning quoting it points at
   * something real even when the rename could not happen.
   */
  function settle(path, record, { delivered, retire }) {
    if (delivered) {
      tokens.delete(record.rollout_id);
      try { unlinkSync(path); } catch { /* already gone is the same outcome */ }
      return path;
    }
    try { writeRecord(path, record); } catch { /* the send verdict still stands */ }
    if (!retire) return path;
    // The rollout is over for this SDK either way, and holding its capability
    // past that is exactly the exposure `tokens` avoids.
    tokens.delete(record.rollout_id);
    return moveAside(path, retire);
  }

  /**
   * Which refusals are final, and under what name the file is kept.
   *
   * `null` means KEEP RETRYING. A status this SDK does not recognise is
   * transient by default: guessing that an unrecognised failure is permanent
   * would stop delivering work on the strength of not understanding the error.
   */
  function retirementFor(err) {
    if (err instanceof LeaseLost || err?.name === "LeaseLost") {
      return "refused-lease-lost";
    }
    if (err instanceof ContractError || err?.name === "ContractError") {
      // This SDK's own refusal, and resending the same bytes cannot change it.
      return "refused-contract";
    }
    const status = err?.statusCode;
    return Number.isInteger(status) && REDELIVERY_CANNOT_FIX.has(status)
      ? `refused-${status}`
      : null;
  }

  /**
   * An outcome that CAN be carried, always.
   *
   * `rolloutOutputToWire` refuses a payload the contract cannot carry and
   * `JSON.stringify` refuses one the spool cannot hold, and neither refusal is
   * a reason to lose the rollout. One unrepresentable field would otherwise
   * take every other field down silently -- a grader reading the row would see
   * an empty rollout and no reason. So an outcome that cannot be sent is
   * replaced by one that can and that SAYS WHAT WENT WITH IT.
   */
  function sendable(rolloutId, output) {
    try {
      JSON.stringify(rolloutOutputToWire(output));
      const over = checksOverLimit(output.checks);
      if (over) {
        warn(
          `[agent-flywheel] rollout ${rolloutId} states ` +
          `${output.checks.length} checks and a report carries at most ` +
          `${MAX_REPORTED_CHECKS}; the first ${MAX_REPORTED_CHECKS} were ` +
          `sent and the report says ${over} were not.`,
        );
      }
      return output;
    } catch (err) {
      // The evidence parts are statements ABOUT the outcome, not the outcome.
      // One malformed check row must not cost the episode its reward, tool
      // calls and artifacts: drop the part that cannot be carried, say so,
      // and send the rest whole. Mirrors `runner.py _wire_payload`.
      const unsendable = EVIDENCE_PARTS
        .filter(([name, toWire]) => {
          if (output?.[name] === undefined || output?.[name] === null) return false;
          try { JSON.stringify(toWire(output[name])); return false; } catch { return true; }
        })
        .map(([name]) => name);
      if (unsendable.length) {
        const kept = { ...output };
        for (const name of unsendable) delete kept[name];
        // Checks removed here are counted, so the stored episode says its
        // checks are missing and not that it ran none.
        const missing = unsendable.includes("checks") ? checksNotCarried(output) : 0;
        if (missing) kept.checksDropped = missing;
        try {
          JSON.stringify(rolloutOutputToWire(kept));
          warn(
            `[agent-flywheel] rollout ${rolloutId}'s ${unsendable.join(", ")} ` +
            `could not be represented (${err?.message ?? err}) and was not ` +
            `sent; the rest of the result was` +
            (missing ? `, and it says ${missing} checks are missing.` : "."),
          );
          return kept;
        } catch { /* something else is wrong too: the full salvage below */ }
      }
      const dropped = ["toolCalls", "llmCallCount", "reward", "success",
        "agentFingerprint", "artifacts", "events", "timing",
        "checks", "termination", "seeds"]
        .filter((name) => output?.[name] !== undefined && output?.[name] !== null);
      const detail = [
        `the SDK could not represent this rollout's result on the ` +
        `${OUTBOX_SCHEMA} outbox: ${err?.name ?? "Error"}: ${err?.message ?? err}`,
        dropped.length ? `dropped by the salvage: ${dropped.join(", ")}` : null,
      ].filter(Boolean).join("; ");
      warn(
        `[agent-flywheel] rollout ${rolloutId}'s result could not be carried ` +
        `whole (${err?.message ?? err}); reporting what can be carried and ` +
        `naming the rest.`,
      );
      const missing = checksNotCarried(output);
      return {
        finalText: typeof output?.finalText === "string" ? output.finalText : "",
        exclusion: { reason: "flywheel_crash", detail: detail.slice(0, 4000) },
        ...(missing ? { checksDropped: missing } : {}),
      };
    }
  }

  /**
   * Did this failure say the control plane cannot take results right now --
   * no connection, a 429, a 5xx -- rather than refuse this one? Then every
   * other held result would fail the same way.
   */
  function outage(err) {
    const status = err?.statusCode;
    return status === null || status === undefined || status === 429 || status >= 500;
  }

  /**
   * Send ONE record. The single place a report failure is read. Resolves to
   * `{delivered, outage}`. The caller holds the record's claim and `busy`.
   */
  async function sendRecord(path, record, { durable = true } = {}) {
    const rolloutId = record.rollout_id;
    record.attempts = Number(record.attempts ?? 0) + 1;
    try {
      await send(
        { rolloutId, leaseToken: tokens.get(rolloutId) ?? null },
        record.output,
      );
    } catch (err) {
      record.last_error = `${err?.name ?? "Error"}: ${err?.message ?? err}`;
      const retire = retirementFor(err);
      const kept = settle(path, record, { delivered: false, retire });
      // Nothing durable holds it, so nothing will redeliver it: the token
      // would only outlive its use.
      if (!durable && !retire) tokens.delete(rolloutId);
      warn(
        retire
          ? `[agent-flywheel] the control plane refused rollout ${rolloutId}'s ` +
            `result: ${err?.message ?? err}. Resending the same result cannot ` +
            `change that, so it will not be retried. The result is kept at ${kept}.`
          : `[agent-flywheel] rollout ${rolloutId}'s result could not be ` +
            `delivered (${err?.message ?? err}); it is held at ${kept} and will ` +
            `be resent before the next claim.`,
      );
      return { delivered: false, outage: !retire && outage(err) };
    }
    settle(path, record, { delivered: true, retire: null });
    return { delivered: true, outage: false };
  }

  /** Run `fn` as this process's one sender of `rolloutId`. */
  async function exclusively(rolloutId, fn) {
    // Wait out a send of the same id already in flight here. A loop, because
    // another waiter may take the id first.
    while (busy.has(rolloutId)) {
      try { await busy.get(rolloutId); } catch { /* its outcome is its own */ }
    }
    const running = fn();
    busy.set(rolloutId, running);
    try {
      return await running;
    } finally {
      if (busy.get(rolloutId) === running) busy.delete(rolloutId);
    }
  }

  return {
    /** Exposed for diagnostics and for the tests that pin this lane. */
    dir,
    get holding() { return busy.size; },

    /**
     * Deliver this outcome, or record it durably and say so OUT LOUD.
     *
     * THE ONLY WAY A RESULT LEAVES THIS SDK. Returns whether the control plane
     * acknowledged it; `false` means the outcome is on disk, named in a
     * warning, and will be retried before the next claim.
     *
     * NEVER THROWS, and its caller depends on that: `onAgentEnd` runs inside a
     * host hook, and an exception escaping the delivery path is how the
     * outcome got lost in the first place.
     */
    async deliver(rollout, output) {
      const rolloutId = rollout?.rolloutId;
      if (typeof rolloutId !== "string" || !rolloutId) {
        // Not spoolable, because there is no id to name the file by -- and not
        // redeliverable either, because `report` addresses a rollout by that
        // same id. One attempt, and the real error is reported as itself.
        try {
          await send(rollout, output);
          return true;
        } catch (err) {
          warn(
            `[agent-flywheel] a rollout with no id could not be reported ` +
            `(${err?.message ?? err}) and cannot be held for retry, because the ` +
            `outbox and the result route both address a rollout by its id.`,
          );
          return false;
        }
      }
      return exclusively(rolloutId, async () => {
        if (rollout.leaseToken) tokens.set(rolloutId, rollout.leaseToken);
        let record;
        let path;
        try {
          // BUILDING the record is inside the guard, not only writing it.
          // `sendable` normalises an output this SDK does not control and
          // `pathFor` derives a filename from the id; either can throw. Left
          // outside a guard they break the "NEVER THROWS" contract above --
          // and `onAgentEnd`'s own catch was removed when delivery moved
          // here, so the exception would escape through the host hook. That
          // is exactly how an outcome got lost before this outbox existed.
          record = {
            schema: OUTBOX_SCHEMA,
            rollout_id: rolloutId,
            first_seen_ts: now(),
            attempts: 0,
            last_error: null,
            output: sendable(rolloutId, output),
          };
          path = pathFor(rolloutId);
        } catch (err) {
          tokens.delete(rolloutId);
          // Nothing durable can be written and nothing can be sent, but the
          // caller is told which rollout and why, instead of the outcome
          // vanishing into a stack trace nobody catches.
          warn(
            `[agent-flywheel] rollout ${rolloutId}'s result could not be ` +
            `prepared for delivery (${err?.message ?? err}), so it can be ` +
            `neither spooled nor reported.`,
          );
          return false;
        }
        // Claimed BEFORE it is written, so no other process's drain can read
        // and send it underneath this one. A live claim elsewhere means
        // another process is sending an earlier result for this same id from
        // this file: this one is spooled beside it instead, under a name of
        // its own, rather than over the file that process will settle.
        let held = acquire(path);
        if (held === null) {
          path = join(dir, `${pathSegment(rolloutId)}.${process.pid}-` +
            `${randomBytes(6).toString("hex")}.json`);
          held = acquire(path);
        }
        let durable = true;
        try {
          writeRecord(path, record);
        } catch (err) {
          durable = false;
          // No durable copy. Said BEFORE the network is tried, because if the
          // send also fails this outcome is genuinely gone.
          warn(
            `[agent-flywheel] could not spool rollout ${rolloutId}'s result to ` +
            `${path}: ${err?.message ?? err}. If delivery now fails the result ` +
            `is lost.`,
          );
        }
        try {
          return (await sendRecord(path, record, { durable })).delivered;
        } finally {
          release(held);
        }
      });
    },

    /**
     * Deliver everything still held. Returns how many landed.
     *
     * NO SINGLE FILE MAY STOP THE DRAIN, and that is a mechanism rather than
     * an argument: whatever one unexpected file does, the results behind it in
     * this directory still get their turn and the claim this runs in front of
     * still happens. What DOES stop a pass is an outage -- the control plane
     * not taking results at all (no connection, 429, 5xx) -- because then
     * every file behind it would fail the same way; they wait for the next
     * claim. A file another process has claimed is skipped, and a future
     * SDK's file is left where it is.
     */
    async drain() {
      let names;
      try {
        // Regular files only: a DIRECTORY named `*.json` cannot be read, and
        // quarantining it failed to rename onto the empty name reserved for
        // it -- one more empty `.unreadable` file on every pass, forever.
        names = readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isFile() && e.name.endsWith(".json"))
          .map((e) => e.name)
          .sort();
      } catch {
        return 0;               // no outbox yet is the ordinary first run
      }
      let delivered = 0;
      for (const name of names) {
        const path = join(dir, name);
        const held = acquire(path);
        if (!held) continue;    // another process is sending it right now
        let stop = false;
        try {
          if (!existsSync(path)) continue;  // delivered while we listed
          const read = readRecord(path);
          if (read === null) {
            const kept = moveAside(path, "unreadable");
            warn(
              `[agent-flywheel] a spooled result at ${path} could not be read ` +
              `and will not be retried. It is kept at ${kept}.`,
            );
            continue;
          }
          if (read.future) {
            if (!named.has(path)) {
              named.add(path);
              warn(
                `[agent-flywheel] ${path} was spooled by a newer SDK in a format ` +
                "this one does not read; it is left where it is for that SDK.",
              );
            }
            continue;
          }
          const { record } = read;
          if (busy.has(record.rollout_id)) continue;
          const seen = Number(record.first_seen_ts);
          const age = now() - seen;
          // A first_seen_ts that is no number was never written by this SDK;
          // NaN compared false against the limit, so it was retried forever.
          if (!Number.isFinite(seen) || age > MAX_AGE_MS) {
            tokens.delete(record.rollout_id);
            const kept = moveAside(path, "stale");
            warn(
              Number.isFinite(seen)
                ? `[agent-flywheel] rollout ${record.rollout_id}'s result has been ` +
                  `undeliverable for ${(age / 86_400_000).toFixed(1)} days and is no ` +
                  `longer being retried. It is kept at ${kept}.`
                : `[agent-flywheel] rollout ${record.rollout_id}'s result has no ` +
                  `readable first_seen_ts, so its age is unknown; it is no longer ` +
                  `being retried. It is kept at ${kept}.`,
            );
            continue;
          }
          const result = await exclusively(record.rollout_id, () => sendRecord(path, record));
          if (result.delivered) delivered += 1;
          stop = result.outage;
        } catch (err) {
          const kept = moveAside(path, "unreadable");
          warn(
            `[agent-flywheel] a spooled result at ${path} could not be ` +
            `processed (${err?.name ?? "Error"}: ${err?.message ?? err}) and ` +
            `will not be retried. It is kept at ${kept}.`,
          );
        } finally {
          release(held);
        }
        if (stop) {
          // The circuit breaker: the control plane is not taking results, so
          // the rest of this pass would only fail the same way, each after the
          // client's own retries, in front of the claim this runs before.
          warn(
            "[agent-flywheel] the control plane is not taking results right " +
            "now; the rest of the held results wait for the next claim.",
          );
          break;
        }
      }
      return delivered;
    },
  };
}
