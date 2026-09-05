/**
 * Where this package's files live on the machine.
 *
 * WHAT USED TO BE HERE, and why it is gone. This module carried a
 * `SessionStore` -- per-session in-memory state plus a crash-safe on-disk
 * "spool" for a session-end report that the network might truncate. It was
 * complete and it was tested, and it had NO producer and NO consumer: nothing
 * in `src/` ever imported it, only its own test did. It was written for a
 * session-report design that production turn capture then superseded.
 *
 * `capture.js` needs none of it, and that is the point rather than an accident:
 * a captured turn's durable state IS its directory, written as the hooks fire.
 * There is no pending map to leak inside a long-lived gateway, nothing to
 * reconstruct after a restart, and no shutdown window in which a report exists
 * only in flight. The spool solved a problem that design does not have.
 *
 * So it was deleted rather than left in place with a comment. Dead code that
 * looks finished is worse than absent code: the next person wires it up.
 *
 * What remains is the two things that are actually used.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** The root for everything this package writes. */
export function percepteyeHome(env = process.env) {
  return env.PERCEPTEYE_HOME || join(homedir(), ".percepteye");
}

/**
 * A host-supplied identifier, made safe to use as ONE path segment.
 *
 * Allows no dots, deliberately: a name of `..` that survived a filter would
 * make `join(root, name)` the PARENT directory. `turns.js:safeTurnId` allows
 * dots -- so that a turn id like `run.1` survives intact -- and has to reject
 * all-dot names explicitly for exactly this reason.
 */
export function safeSegment(value) {
  const s = String(value ?? "");
  const cleaned = [...s].filter((c) => /[A-Za-z0-9_-]/.test(c)).join("");
  return cleaned.slice(0, 120) || "unknown";
}
