/**
 * A home of its own for every test, and a guard that fails a test file which
 * reaches the default one.
 *
 * WHY. With no PERCEPTEYE_HOME, `percepteyeHome()` (src/session.js) is
 * `~/.percepteye` -- the developer's REAL home, where a real install holds its
 * undelivered rollout results. `node --test` runs the test files at once, in
 * separate processes, so two files that each built a rollout driver without a
 * home spooled rollout "r1" into the same `~/.percepteye/outbox/agent`, and
 * one file's `claim()` drained the other's half-written r1.json: an unreadable
 * record, moved aside, one extra warning, and a test that asserted one warning
 * failed in a sweep and passed on every rerun. The same drain would deliver a
 * developer's genuinely held result to a test's fake transport and delete it.
 *
 * SO EVERY TEST FILE IMPORTS THIS MODULE FIRST -- `import "./support/home.js";`
 * -- and `home-isolation.test.js` fails a file that does not. Importing it:
 *
 *  - removes PERCEPTEYE_HOME and PERCEPTEYE_CAPTURE_DIR from `process.env`.
 *    A developer who exports either one names their REAL install's files, and
 *    a test that omitted `env` would read them without ever reaching the
 *    fallback below -- unguarded. With both gone, every such test reaches it;
 *  - points `os.homedir()` at a per-process temporary directory, so nothing a
 *    test does can reach the real `~/.percepteye`, guarded or not; and
 *  - records every call, and fails the file (a root `after` hook) with the
 *    stack of the first one. `homedir()` is called by exactly one line of
 *    `src/`, the PERCEPTEYE_HOME fallback, so a call IS a test that reached
 *    the default home. Recording rather than throwing is deliberate:
 *    `register` builds the rollout driver, which resolves the outbox, inside
 *    a try that logs and carries on, so a throw there would be swallowed and
 *    the test would pass on a plugin with no rollout lane.
 *
 * A test that builds a driver, registers the plugin, or otherwise reaches a
 * path under the home passes `env: testEnv()` (or `testEnv({...})` merged with
 * its own variables), or an explicit `outbox`.
 *
 * NOR DOES A TEST REACH THE NETWORK. A test that registers the plugin without
 * a control-plane URL dials the default, the PRODUCTION control plane: five
 * files did -- `POST /agents` with a fake key among it -- and on a CI runner
 * whose route there was slow, the outstanding request kept a test process
 * alive past its 30 s file timeout with every one of its tests passed. So
 * importing this module also replaces `fetch` with one that refuses any host
 * but loopback at once, the way an unreachable network refuses it (a
 * `TypeError("fetch failed")`). A test's fake control plane listens on
 * loopback and is unaffected; a test that installs its own `fetch` stub
 * replaces this one for as long as it holds it.
 */
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { after } from "node:test";

/** A fresh, empty directory to use as one test's PERCEPTEYE_HOME. */
export function testHome() {
  return mkdtempSync(join(os.tmpdir(), "percepteye-test-home-"));
}

/** An environment whose PERCEPTEYE_HOME is a fresh directory of its own. */
export function testEnv(extra = {}) {
  return { PERCEPTEYE_HOME: testHome(), ...extra };
}

delete process.env.PERCEPTEYE_HOME;
delete process.env.PERCEPTEYE_CAPTURE_DIR;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const realFetch = globalThis.fetch;
/** Whether `input` (a URL, string or Request) names a loopback host. */
export function isLoopback(input) {
  try {
    return LOOPBACK.has(new URL(input instanceof Request ? input.url : String(input)).hostname);
  } catch {
    return false;
  }
}
globalThis.fetch = function offlineFetch(input, init) {
  if (isLoopback(input)) return realFetch(input, init);
  return Promise.reject(new TypeError("fetch failed", {
    cause: new Error(`tests do not reach the network: ${String(input?.url ?? input)}`),
  }));
};

const reached = [];
let allowed = 0;
let fallback = null;

os.homedir = () => {
  if (allowed === 0) reached.push(new Error("os.homedir() was called").stack);
  fallback ??= mkdtempSync(join(os.tmpdir(), "percepteye-guard-homedir-"));
  return fallback;
};
// `src/session.js` imports `homedir` by name; this re-points that binding.
syncBuiltinESMExports();

/**
 * Run `fn` without recording: for the one test whose subject IS the fallback
 * (`percepteyeHome({})`). It still resolves to the per-process directory.
 */
export function allowDefaultHome(fn) {
  allowed += 1;
  try {
    return fn();
  } finally {
    allowed -= 1;
  }
}

after(() => {
  if (reached.length === 0) return;
  throw new Error(
    `${reached.length} call(s) reached the default PERCEPTEYE_HOME ` +
    "(~/.percepteye, the developer's real home). Pass `env: testEnv()` " +
    "from test/support/home.js, or an explicit `outbox`. First call:\n" +
    reached[0],
  );
});
