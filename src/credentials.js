/**
 * The keys `npx @percepteye/agent-flywheel login` stores, and the one rule
 * that picks a stored key.
 *
 * A `pefw_` key is bound to one agent on one control plane, so it is stored
 * per (control-plane URL, agent id) in `$PERCEPTEYE_HOME/credentials.json`
 * (`~/.percepteye/credentials.json` when PERCEPTEYE_HOME is unset), a file only
 * its owner can read (0600), in a directory only its owner can enter (0700),
 * and that is replaced, never edited in place. Every read-modify-write holds
 * a lock file beside it (`LOCK_FILENAME`), so two logins at once cannot lose
 * one another's key. The Python SDK reads and writes the same file in the
 * same format (`agent_flywheel/credentials.py`), so a key stored by either is
 * found by both; that package's `tests/test_credentials_parity.py` drives
 * this module and compares.
 *
 * WHICH KEY (`resolveConfig`, which asks `storedKeyFor` below): the plugin
 * config's `apiKey`, then PERCEPTEYE_API_KEY, then the key stored for THIS
 * agent on THIS control plane. The file is consulted only when neither of the
 * first two is set, so nothing about an existing install changes.
 *
 * A STORED KEY IS CONSENT, like the variable (owner ruling 2026-10-20, R2):
 * it exists only because someone ran `login` and clicked Approve for that
 * named agent. It is never silent -- `register` says once that it is using
 * one, naming the file and how to stop -- it applies to its own agent id and
 * no other, and uploading production turns still needs the per-agent consent
 * the control plane holds.
 *
 * No request body this package sends carries a Flywheel key
 * (`http.js:redactKeys`), so a key some tool output read from this file is
 * never reported back in it (R2b).
 */
import {
  chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync, unlinkSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { percepteyeHome } from "./session.js";

export const CREDENTIALS_FILENAME = "credentials.json";
/**
 * The lock every read-modify-write of the file holds: created exclusively
 * (O_EXCL), removed when the write is done, and taken over once it is older
 * than `LOCK_STALE_MS` -- a process killed mid-write leaves one behind.
 *
 * NOT the Python SDK's `credentials.json.lock`: that one is an flock()ed file
 * that stays on disk, so an exclusive create of the same name would wait on it
 * forever. The two SDKs' locks are separate files; each serialises its own
 * logins, and the write stays atomic either way.
 */
export const LOCK_FILENAME = `${CREDENTIALS_FILENAME}.node-lock`;
/** A lock older than this was left by a process that died holding it. */
export const LOCK_STALE_MS = 30_000;
/** How long a writer waits for another one before saying so. */
export const LOCK_WAIT_MS = 10_000;
/**
 * The file's own format version. A reader refuses a version it does not
 * know rather than guess, and a writer refuses to replace one: a newer SDK's
 * file is never rewritten by an older one into a shape that loses entries.
 */
export const FORMAT_VERSION = 1;

/** The fields every entry carries, in the order both SDKs write them. */
export const FIELDS = Object.freeze([
  "control_plane_url", "agent_id", "api_key", "org_id", "org_name",
  "key_id", "created_at", "expires_at", "client",
]);

export class CredentialsError extends Error {
  constructor(message) {
    super(message);
    this.name = "CredentialsError";
  }
}

/** `$PERCEPTEYE_HOME/credentials.json`: the home everything here writes. */
export function credentialsPath(env = process.env) {
  return join(percepteyeHome(env), CREDENTIALS_FILENAME);
}

const normaliseUrl = (url) => String(url).trim().replace(/\/+$/, "");

function readEntries(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw new CredentialsError(`cannot read ${path}: ${err?.message ?? err}`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new CredentialsError(
      `${path} is not valid JSON (${err.message}); move it aside and run ` +
      "`npx @percepteye/agent-flywheel login` again",
    );
  }
  if (doc === null || typeof doc !== "object" || doc.version !== FORMAT_VERSION) {
    const version = doc !== null && typeof doc === "object" ? doc.version : undefined;
    throw new CredentialsError(
      `${path} is credentials format version ${JSON.stringify(version ?? null)}; ` +
      `this SDK reads version ${FORMAT_VERSION}. Upgrade @percepteye/agent-flywheel.`,
    );
  }
  if (!("credentials" in doc)) return [];
  if (!Array.isArray(doc.credentials)) {
    // Never read as "no keys": the next save would write an empty list over
    // whatever this is. The Python SDK refuses it the same way.
    throw new CredentialsError(
      `${path} has a "credentials" that is not a list; move it aside and run ` +
      "`npx @percepteye/agent-flywheel login` again",
    );
  }
  return doc.credentials.filter((e) => e !== null && typeof e === "object" && !Array.isArray(e));
}

/** One well-formed entry, or null. */
function entry(raw) {
  const { control_plane_url: url, agent_id: agent, api_key: key } = raw;
  if (![url, agent, key].every((v) => typeof v === "string" && v)) return null;
  const out = {};
  for (const f of FIELDS) out[f] = typeof raw[f] === "string" ? raw[f] : null;
  return out;
}

/** Every well-formed stored entry. Throws `CredentialsError` on an unusable file. */
export function loadStored(env = process.env) {
  return readEntries(credentialsPath(env)).map(entry).filter((e) => e !== null);
}

const matches = (cred, url, agentId) =>
  normaliseUrl(cred.control_plane_url) === normaliseUrl(url) &&
  cred.agent_id === agentId;

const ISO_TIME = new RegExp(
  "^(\\d{4})-(\\d{2})-(\\d{2})"
  + "(?:[Tt ](\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d+))?)?)?"
  + "(?:([Zz])|([+-])(\\d{2}):?(\\d{2}))?$",
);

/**
 * An ISO 8601 / RFC 3339 time as epoch milliseconds, or `null` when it cannot
 * be read. ONE WITH NO OFFSET IS UTC, as the Python SDK's `_parse_time` reads
 * it: `Date.parse` read it as LOCAL time, so the same file expired a key
 * hours apart in the two SDKs, depending on the machine's zone.
 */
export function parseTime(value) {
  const m = typeof value === "string" ? ISO_TIME.exec(value.trim()) : null;
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", sec = "0", frac = "", , sign, oh, om] = m;
  const ms = Number((frac + "000").slice(0, 3));
  const at = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec), ms);
  const check = new Date(at);
  if (check.getUTCMonth() !== Number(mo) - 1 || check.getUTCDate() !== Number(d)
      || Number(h) > 23 || Number(mi) > 59 || Number(sec) > 59) return null;
  const offset = sign ? (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om)) : 0;
  return at - offset * 60_000;
}

/**
 * Has this entry's `expires_at` passed? A key with none never expires. One
 * that cannot be read is treated as PASSED, as the Python SDK treats it: a
 * corrupted or foreign timestamp fails closed rather than lending the key out
 * forever.
 */
export function expired(cred, now = Date.now()) {
  if (!cred.expires_at) return false;
  const at = parseTime(cred.expires_at);
  return at === null || at <= now;
}

/**
 * The stored entry for this agent on this control plane, from `stored` (what
 * `loadStored` read): `{ cred, refusal }`. `cred` is null when none is usable,
 * and `refusal` then names why when one EXISTS and is refused (it expired).
 *
 * PURE -- it reads no file -- so `resolveConfig` can ask it without doing IO.
 */
export function storedKeyFor(stored, controlPlaneUrl, agentId, now = Date.now()) {
  const found = (stored ?? []).find((c) => matches(c, controlPlaneUrl, agentId));
  if (!found) return { cred: null, refusal: null };
  if (expired(found, now)) {
    return {
      cred: null,
      refusal: `the key stored for agent ${JSON.stringify(agentId)} expired on ${found.expires_at}`,
    };
  }
  return { cred: found, refusal: null };
}

/**
 * `dir`, existing and 0700: it holds keys. One made here is created so; one
 * that already exists (an older SDK's, the goose recorder's) is tightened.
 * Best effort on a directory this user cannot chmod, and not on Windows,
 * where the mode bits mean nothing -- the file inside is 0600 regardless.
 */
function privateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  try {
    if (statSync(dir).mode & 0o077) chmodSync(dir, 0o700);
  } catch { /* best effort */ }
}

function write(path, entries) {
  privateDir(dirname(path));
  const body = JSON.stringify({ version: FORMAT_VERSION, credentials: entries }, null, 2) + "\n";
  const tmp = join(dirname(path), `.credentials.${randomBytes(6).toString("hex")}.tmp`);
  // Created 0600 and exclusive, so the key is never readable by anyone else,
  // not even for the moment before the rename.
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Run `fn` holding the credentials lock; every filesystem failure on the way,
 * the write's own included, is a `CredentialsError` naming the file, never a
 * stack trace out of the CLI.
 */
function locked(path, fn, { now = Date.now } = {}) {
  const lock = join(dirname(path), LOCK_FILENAME);
  try {
    privateDir(dirname(path));
  } catch (err) {
    throw new CredentialsError(`cannot create ${dirname(path)}: ${err?.message ?? err}`);
  }
  const giveUp = now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try { writeSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") {
        throw new CredentialsError(`cannot lock ${path} (${lock}): ${err?.message ?? err}`);
      }
    }
    let age = 0;
    try { age = now() - statSync(lock).mtimeMs; } catch { continue; /* just released */ }
    if (age > LOCK_STALE_MS) {
      // Left by a process that died mid-write. Moved aside rather than
      // unlinked, so two writers taking it over at once cannot both win: only
      // one rename of the same name succeeds.
      try { renameSync(lock, `${lock}.stale-${randomBytes(4).toString("hex")}`); } catch { /* lost the race */ }
      continue;
    }
    if (now() >= giveUp) {
      throw new CredentialsError(
        `another process has been writing ${path} for over ` +
        `${LOCK_WAIT_MS / 1000} s; try again, or remove ${lock} if nothing is`,
      );
    }
    pause(25);
  }
  try {
    return fn();
  } catch (err) {
    if (err instanceof CredentialsError) throw err;
    throw new CredentialsError(`cannot write ${path}: ${err?.message ?? err}`);
  } finally {
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}

/**
 * Store `cred`, replacing any key stored for the same agent and control
 * plane. Returns the file written. Atomic: a 0600 file beside the old one,
 * flushed, renamed over it, in a 0700 directory. LOCKED: the read, the change
 * and the write hold `LOCK_FILENAME`, so a concurrent login's key is never
 * lost. Any filesystem failure is a `CredentialsError`.
 */
export function saveStored(cred, env = process.env) {
  const path = credentialsPath(env);
  return locked(path, () => {
    const existing = readEntries(path); // throws rather than lose entries it cannot read
    const kept = existing.filter((e) => {
      const c = entry(e);
      return !(c && matches(c, cred.control_plane_url, cred.agent_id));
    });
    const row = {};
    for (const f of FIELDS) row[f] = cred[f] ?? null;
    kept.push(row);
    write(path, kept);
    return path;
  });
}

/**
 * Forget the key stored for this agent on this control plane; true if one
 * was. Local only: the key stays valid until it is revoked in Mission
 * Control (Settings).
 */
export function removeStored(controlPlaneUrl, agentId, env = process.env) {
  const path = credentialsPath(env);
  if (readEntries(path).length === 0) return false; // nothing to lock for
  return locked(path, () => {
    const existing = readEntries(path);
    const kept = existing.filter((e) => {
      const c = entry(e);
      return !(c && matches(c, controlPlaneUrl, agentId));
    });
    if (kept.length === existing.length) return false;
    write(path, kept);
    return true;
  });
}

/**
 * `value` as ONE POSIX shell word, for a command this package tells a person
 * to paste: an agent id is free text, and an unquoted one could split, glob
 * or run as code. Python's `shlex.quote`, character for character.
 */
export function shellQuote(value) {
  const s = String(value);
  if (s === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\"'\"'")}'`;
}

/** The command that gets this agent a key, as a sentence fragment. */
export function loginHint(agentId) {
  const target = agentId ? ` --agent-id ${shellQuote(agentId)}` : "";
  return `run \`npx @percepteye/agent-flywheel login${target}\` to create one`;
}
