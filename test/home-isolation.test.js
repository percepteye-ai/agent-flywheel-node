/**
 * NO TEST REACHES THE DEVELOPER'S HOME, and the guard that says so works.
 *
 * Two tests that each built a rollout driver with no home both spooled rollout
 * "r1" into the developer's real `~/.percepteye/outbox/agent`, and under
 * `node --test`'s concurrent files one drained the other's half-written
 * r1.json: an extra warning, a test red in a sweep and green on every rerun.
 * `support/home.js` is the guard; see it for the mechanism.
 *
 * A guard is only as good as two things this file checks: that every test
 * file loads it, and that it actually goes red. The second runs a fixture in a
 * child `node --test` -- the guard fails a FILE, so only a run of one can show
 * it -- with a positive control, so the red is the reach and not a fixture
 * that broke.
 */
import "./support/home.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE = join(TEST_DIR, "fixtures", "home-guard.fixture.js");

/** The text of a module's first `import` statement, up to its semicolon. */
function firstImport(source) {
  const start = source.search(/^import\b/m);
  return start < 0 ? null : source.slice(start, source.indexOf(";", start) + 1);
}

/**
 * The fixture in a child run whose environment EXPORTS a home -- as a
 * developer's shell might, naming their real install -- holding one spooled
 * result a drain would deliver or move aside.
 */
function runFixture(mode) {
  const exported = mkdtempSync(join(tmpdir(), "percepteye-exported-home-"));
  const held = join(exported, "outbox", "agent");
  mkdirSync(held, { recursive: true });
  writeFileSync(join(held, "r1.json"), "{");
  const env = {
    ...process.env, PERCEPTEYE_HOME: exported, HOME_GUARD_FIXTURE: mode,
  };
  // This process is itself a `node --test` child; a run nested under that
  // marker reports to this one's parent instead of to us.
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["--test", FIXTURE], {
    env, encoding: "utf8", timeout: 20_000,
  });
  return {
    status: run.status,
    output: `${run.stdout}${run.stderr}`,
    held: readdirSync(held),
    record: readFileSync(join(held, "r1.json"), "utf8"),
  };
}

describe("no test reaches the developer's home", () => {
  it("every test file loads the guard as its first import", () => {
    const files = readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.js"));
    assert.ok(files.length > 1, "found no test files; this check would pass vacuously");
    const missing = files.filter((f) => !/["']\.\/support\/home\.js["'];$/.test(
      firstImport(readFileSync(join(TEST_DIR, f), "utf8")) ?? "",
    ));
    assert.deepEqual(missing, [],
      "these test files do not import ./support/home.js first, so nothing " +
      "stops them reaching the developer's real PERCEPTEYE_HOME");
  });

  it("a file whose driver has a home of its own passes", () => {
    const run = runFixture("own");
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(run.held, ["r1.json"]);
  });

  it("a file whose driver reaches the default home fails, and touches nothing", () => {
    const run = runFixture("default");
    assert.notEqual(run.status, 0, `the guard let it pass:\n${run.output}`);
    assert.match(run.output, /reached the default PERCEPTEYE_HOME/);
    assert.match(run.output, /home-guard\.fixture\.js/,
      "the failure does not point at the test that reached the home");
    // The exported home was never drained: its held result is where it was,
    // as it was, rather than delivered or moved aside.
    assert.deepEqual(run.held, ["r1.json"]);
    assert.equal(run.record, "{");
  });
});
