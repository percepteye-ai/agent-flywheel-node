/**
 * The consent boundary, and the reader's two load-bearing distinctions.
 */
import "./support/home.js";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveConfig } from "../src/config.js";
import { readTrajectory, TOOL_CALLS_FILENAME } from "../src/trajectory.js";

const dirWith = (lines) => {
  const d = mkdtempSync(join(tmpdir(), "pe-read-"));
  writeFileSync(join(d, TOOL_CALLS_FILENAME), lines.join("\n"));
  return d;
};
const ok = (name) => JSON.stringify({ name, outcome: "ok" });

describe("no key means nothing leaves the machine", () => {
  it("is not contributing without a key", () => {
    // The ordinary first install. Local capture still runs; the network does
    // not. A customer with no key is not misconfigured.
    assert.equal(resolveConfig({}, {}).contributing, false);
  });

  it("contributes once a key resolves, from config OR env", () => {
    assert.equal(resolveConfig({ apiKey: "pefw_a" }, {}).contributing, true);
    assert.equal(resolveConfig({}, { PERCEPTEYE_API_KEY: "pefw_b" }).contributing, true);
  });

  it("prefers config over env, because config is hot-reloaded", () => {
    const c = resolveConfig({ apiKey: "from-config" }, { PERCEPTEYE_API_KEY: "from-env" });
    assert.equal(c.apiKey, "from-config");
  });

  it("treats a blank key as no key", () => {
    assert.equal(resolveConfig({ apiKey: "   " }, {}).contributing, false);
  });

  it("resolves the control plane from OUR name only", () => {
    // This also read an unprefixed `CONTROL_PLANE_ENV_URL`, at the lowest
    // precedence, while the Python SDK's harness recorder read the same
    // variable at the HIGHEST -- so two components of one product, in one
    // process, could report to two different control planes with nothing
    // logged. Nothing in the platform sets it, no README named it and it is
    // not in CONFIG_SCHEMA, so a customer could not discover it existed; what
    // it COULD do is collide with an unrelated variable of that generic name.
    const env = {
      CONTROL_PLANE_ENV_URL: "https://somebody-elses-control-plane.example/v1",
    };
    assert.equal(resolveConfig({}, env).controlPlaneUrl,
      resolveConfig({}, {}).controlPlaneUrl,
      "an unprefixed variable must not redirect this agent's telemetry");
    assert.equal(
      resolveConfig({}, { ...env, PERCEPTEYE_CONTROL_PLANE_URL: "https://ours.example/v1" })
        .controlPlaneUrl,
      "https://ours.example/v1");
    assert.equal(
      resolveConfig({ controlPlaneUrl: "https://cfg.example/v1" },
        { PERCEPTEYE_CONTROL_PLANE_URL: "https://env.example/v1" }).controlPlaneUrl,
      "https://cfg.example/v1", "config wins over the environment");
  });

  it("documents the control plane it actually dials, and only that one", () => {
    // ONE ANSWER, NOT TWO. A default the README names and the code does not
    // dial is the defect the sibling Python package shipped: three places told
    // a customer to use a hostname that has no DNS record, and nothing
    // compared the prose with the constant. Whatever this package falls back
    // to is what its README must print.
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const named = [...new Set(readme.match(/https:\/\/[a-z0-9.-]+\/api\/flywheel\/v1/g) ?? [])];
    assert.deepEqual(named, [resolveConfig({}, {}).controlPlaneUrl],
      "the README must name the control-plane default, and no other host");
  });

  it("capture is ON unless deliberately disabled", () => {
    // A typo must not silently switch capture off and leave the operator
    // believing it is on.
    assert.equal(resolveConfig({}, {}).captureEnabled, true);
    assert.equal(resolveConfig({}, { PERCEPTEYE_CAPTURE: "typo" }).captureEnabled, true);
    assert.equal(resolveConfig({}, { PERCEPTEYE_CAPTURE: "0" }).captureEnabled, false);
    assert.equal(resolveConfig({ capture: "off" }, {}).captureEnabled, false);
  });
});

describe("absent is not empty", () => {
  it("a missing trajectory reads as null, not []", () => {
    // null means "there was no trajectory"; [] means "I read one and it
    // recorded zero calls". Reporting [] for a missing file would assert the
    // agent made no tool calls when in fact nothing was observed.
    assert.deepEqual(readTrajectory("/nonexistent/dir"), { calls: null, malformed: 0 });
    assert.deepEqual(readTrajectory(null), { calls: null, malformed: 0 });
  });

  it("an empty trajectory file reads as [], a positive assertion", () => {
    assert.deepEqual(readTrajectory(dirWith([])), { calls: [], malformed: 0 });
  });

  it("reads well-formed rows", () => {
    const r = readTrajectory(dirWith([ok("shell"), ok("edit")]));
    assert.equal(r.calls.length, 2);
    assert.equal(r.malformed, 0);
  });
});

describe("corruption is counted, never dropped", () => {
  it("counts unparseable lines instead of throwing", () => {
    const r = readTrajectory(dirWith([ok("a"), "{not json", ok("b")]));
    assert.equal(r.calls.length, 2);
    assert.equal(r.malformed, 1);
  });

  it("counts a row missing the required fields as malformed", () => {
    // The Python reader builds each row with REQUIRED subscripts and counts
    // anything else as malformed; that tally forbids the training grade, so
    // silently skipping such a row would let a partly-unreadable trajectory be
    // graded as a complete one.
    const r = readTrajectory(dirWith([ok("a"), JSON.stringify({ note: "hi" })]));
    assert.equal(r.calls.length, 1);
    assert.equal(r.malformed, 1);
  });

  it("ignores blank lines without counting them as corruption", () => {
    const r = readTrajectory(dirWith([ok("a"), "", "  ", ok("b")]));
    assert.equal(r.calls.length, 2);
    assert.equal(r.malformed, 0);
  });
});
