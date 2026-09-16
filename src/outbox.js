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
  chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { LeaseLost } from "./errors.js";
import { percepteyeHome } from "./session.js";
import { quoteIdentifier } from "./transport.js";
import { ContractError, rolloutOutputToWire } from "./wire.js";

/**
 * Version tag on a spooled outcome. A file written by a future SDK with a
 * different shape is left alone rather than half-read.
 */
export const OUTBOX_SCHEMA = "percepteye.outbox/v1";

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
 * ONE RULE FOR BOTH THINGS THAT BECOME PATHS -- the agent, which names the
 * directory, and the rollout, which names the file. `safeSegment` was the
 * obvious reach for the agent half and is the wrong predicate for it: it
 * strips rather than encodes, so two agents sharing one PERCEPTEYE_HOME and
 * differing only by a dot would share one outbox and replay each other's
 * results, which is the thing keying by agent is for.
 */
export function pathSegment(value) {
  const raw = String(value ?? "");
  const quoted = quoteIdentifier(raw);
  return quoted.length > 120 || quoted.length === 0 || /^\.+$/.test(quoted)
    ? createHash("sha256").update(raw, "utf8").digest("hex")
    : quoted;
}

/** Where this agent's undelivered results wait. Keyed by AGENT, because two
 * installs sharing one home would otherwise replay each other's results. */
export function outboxDir(agentId, env = process.env) {
  return join(percepteyeHome(env), "outbox", pathSegment(agentId ?? "agent"));
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

  /** Rollout ids this process is delivering right now, so a concurrent drain
   * does not send the same result a second time underneath its owner. */
  const busy = new Set();

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
    const tmp = `${path}.tmp`;
    // Write-then-rename: a half-written result is worse than none, because it
    // reads as a poisoned file and retires work that was actually fine.
    writeFileSync(tmp, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  }

  /** Read one spooled outcome, or `null` if it is not one we can send. */
  function readRecord(path) {
    let record;
    try {
      record = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    if (record.schema !== OUTBOX_SCHEMA) return null;
    if (typeof record.rollout_id !== "string" || !record.rollout_id) return null;
    if (!record.output || typeof record.output !== "object") return null;
    // A record written before the token came off disk still holds one. Dropped
    // on the way in, so it never re-enters memory and the next write-back of
    // this record leaves the credential nowhere.
    delete record.lease_token;
    return record;
  }

  /**
   * Stop retrying a file without deleting the work it holds.
   *
   * The name is RESERVED BEFORE THE RENAME. `renameSync` onto a bare
   * `<id>.json.<why>` silently replaces it, so a rollout refused a second time
   * -- a retried task, or a restart that re-spools the same id -- would
   * destroy the first retired record. Uniquified instead: `.refused-410`, then
   * `.refused-410.1`, and no copy is ever lost to a later one.
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
      return output;
    } catch (err) {
      const dropped = ["toolCalls", "llmCallCount", "reward", "success",
        "agentFingerprint", "artifacts", "events", "timing"]
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
      return {
        finalText: typeof output?.finalText === "string" ? output.finalText : "",
        exclusion: { reason: "flywheel_crash", detail: detail.slice(0, 4000) },
      };
    }
  }

  /** Send ONE record. The single place a report failure is read. */
  async function sendRecord(path, record) {
    const rolloutId = record.rollout_id;
    busy.add(rolloutId);
    try {
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
        warn(
          retire
            ? `[agent-flywheel] the control plane refused rollout ${rolloutId}'s ` +
              `result: ${err?.message ?? err}. Resending the same result cannot ` +
              `change that, so it will not be retried. The result is kept at ${kept}.`
            : `[agent-flywheel] rollout ${rolloutId}'s result could not be ` +
              `delivered (${err?.message ?? err}); it is held at ${kept} and will ` +
              `be resent before the next claim.`,
        );
        return false;
      }
      settle(path, record, { delivered: true, retire: null });
      return true;
    } finally {
      busy.delete(rolloutId);
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
      if (rollout.leaseToken) tokens.set(rolloutId, rollout.leaseToken);
      let record;
      let path;
      try {
        // BUILDING the record is inside the guard, not only writing it.
        // `sendable` normalises an output this SDK does not control and
        // `pathFor` derives a filename from the id; either can throw. Left
        // outside a guard they break the "NEVER THROWS" contract above -- and
        // `onAgentEnd`'s own catch was removed when delivery moved here, so
        // the exception would escape through the host hook. That is exactly
        // how an outcome got lost before this outbox existed.
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
      try {
        writeRecord(path, record);
      } catch (err) {
        // No durable copy. Said BEFORE the network is tried, because if the
        // send also fails this outcome is genuinely gone.
        warn(
          `[agent-flywheel] could not spool rollout ${rolloutId}'s result to ` +
          `${path}: ${err?.message ?? err}. If delivery now fails the result ` +
          `is lost.`,
        );
      }
      return sendRecord(path, record);
    },

    /**
     * Deliver everything still held. Returns how many landed.
     *
     * NO SINGLE FILE MAY STOP THE DRAIN, and that is a mechanism rather than
     * an argument: whatever one unexpected file does, the results behind it in
     * this directory still get their turn and the claim this runs in front of
     * still happens.
     */
    async drain() {
      let names;
      try {
        names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
      } catch {
        return 0;               // no outbox yet is the ordinary first run
      }
      let delivered = 0;
      for (const name of names) {
        const path = join(dir, name);
        try {
          const record = readRecord(path);
          if (record === null) {
            const kept = moveAside(path, "unreadable");
            warn(
              `[agent-flywheel] a spooled result at ${path} could not be read ` +
              `and will not be retried. It is kept at ${kept}.`,
            );
            continue;
          }
          if (busy.has(record.rollout_id)) continue;
          const age = now() - Number(record.first_seen_ts ?? 0);
          if (age > MAX_AGE_MS) {
            const kept = moveAside(path, "stale");
            warn(
              `[agent-flywheel] rollout ${record.rollout_id}'s result has been ` +
              `undeliverable for ${(age / 86_400_000).toFixed(1)} days and is no ` +
              `longer being retried. It is kept at ${kept}.`,
            );
            continue;
          }
          if (await sendRecord(path, record)) delivered += 1;
        } catch (err) {
          const kept = moveAside(path, "unreadable");
          warn(
            `[agent-flywheel] a spooled result at ${path} could not be ` +
            `processed (${err?.name ?? "Error"}: ${err?.message ?? err}) and ` +
            `will not be retried. It is kept at ${kept}.`,
          );
        }
      }
      return delivered;
    },
  };
}
