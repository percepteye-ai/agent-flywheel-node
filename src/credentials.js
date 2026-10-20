/**
 * The keys `npx @percepteye/agent-flywheel login` stores, and the one rule
 * that picks a stored key.
 *
 * A `pefw_` key is bound to one agent on one control plane, so it is stored
 * per (control-plane URL, agent id) in `$PERCEPTEYE_HOME/credentials.json`
 * (`~/.percepteye/credentials.json` when PERCEPTEYE_HOME is unset), a file only
 * its owner can read (0600) and that is replaced, never edited in place. The
 * Python SDK reads and writes the same file in the same format
 * (`agent_flywheel/credentials.py`), so a key stored by either is found by
 * both; `test/credentials.test.js` holds this module to the Python one over a
 * shared table.
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
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync,
  unlinkSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { percepteyeHome } from "./session.js";

export const CREDENTIALS_FILENAME = "credentials.json";
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
  const entries = Array.isArray(doc.credentials) ? doc.credentials : [];
  return entries.filter((e) => e !== null && typeof e === "object" && !Array.isArray(e));
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

/** Has this entry's `expires_at` passed? A missing or unreadable one has not. */
export function expired(cred, now = Date.now()) {
  if (!cred.expires_at) return false;
  const at = Date.parse(cred.expires_at);
  return Number.isFinite(at) && at <= now;
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

function write(path, entries) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
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

/**
 * Store `cred`, replacing any key stored for the same agent and control
 * plane. Returns the file written. Atomic: a 0600 file beside the old one,
 * flushed, renamed over it.
 */
export function saveStored(cred, env = process.env) {
  const path = credentialsPath(env);
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
}

/**
 * Forget the key stored for this agent on this control plane; true if one
 * was. Local only: the key stays valid until it is revoked in Mission
 * Control (Settings).
 */
export function removeStored(controlPlaneUrl, agentId, env = process.env) {
  const path = credentialsPath(env);
  const existing = readEntries(path);
  const kept = existing.filter((e) => {
    const c = entry(e);
    return !(c && matches(c, controlPlaneUrl, agentId));
  });
  if (kept.length === existing.length) return false;
  write(path, kept);
  return true;
}

/** The command that gets this agent a key, as a sentence fragment. */
export function loginHint(agentId) {
  const target = agentId ? ` --agent-id ${agentId}` : "";
  return `run \`npx @percepteye/agent-flywheel login${target}\` to create one`;
}
