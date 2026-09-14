/**
 * The mode vocabulary, and the two gates it is not.
 *
 * These assert PARITY WITH THE PYTHON SDK's `_MODE_ALIASES`, not merely that
 * this package's own resolver is self-consistent. A customer deploys one
 * package or the other -- never both -- and flips the same
 * `PERCEPTEYE_AGENT_MODE` either way. If `prod` means production in Python and
 * nothing in Node, the switch silently stops working on the harness they
 * happened to choose.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ENV_MODE, MODE_ALIASES, PRODUCTION, TRAINING,
  resolveMode, resolveModeSource,
} from "../src/mode.js";
import { ConfigurationError } from "../src/errors.js";

describe("resolveMode", () => {
  it("defaults to training when nothing says otherwise", () => {
    assert.equal(resolveMode(null, {}), TRAINING);
    assert.equal(resolveModeSource(null, {}).source, "default");
  });

  it("reads the environment", () => {
    assert.equal(resolveMode(null, { [ENV_MODE]: "production" }), PRODUCTION);
    assert.equal(
      resolveModeSource(null, { [ENV_MODE]: "production" }).source, "environment");
  });

  it("lets plugin config win over the environment", () => {
    assert.equal(resolveMode("production", { [ENV_MODE]: "training" }), PRODUCTION);
    assert.equal(resolveModeSource("production", {}).source, "config");
  });

  it("treats an EMPTY explicit value as 'not set', not as a value", () => {
    // `{mode: cfg.mode ?? ""}` is how a config layer says "unset". Honouring
    // it as a value pins the process to `training` without ever reading the
    // environment -- so an operator who flipped the switch to STOP
    // contributing keeps contributing, silently, on their own credentials.
    for (const empty of ["", "   ", null, undefined]) {
      assert.equal(
        resolveMode(empty, { [ENV_MODE]: "production" }), PRODUCTION,
        `explicit ${JSON.stringify(empty)} must fall through to the environment`,
      );
    }
  });

  it("is case- and whitespace-insensitive", () => {
    assert.equal(resolveMode("  PRODUCTION  ", {}), PRODUCTION);
    assert.equal(resolveMode(null, { [ENV_MODE]: "Prod" }), PRODUCTION);
  });

  it("REFUSES an unrecognised mode instead of guessing", () => {
    assert.throws(() => resolveMode("prodction", {}), ConfigurationError);
    assert.throws(() => resolveMode(null, { [ENV_MODE]: "off" }), ConfigurationError);
  });

  it("names where the bad value came from", () => {
    // One wrong cause for every input is how an operator edits the wrong file.
    assert.throws(
      () => resolveMode(null, { [ENV_MODE]: "nope" }),
      (e) => e.message.includes(ENV_MODE),
    );
    assert.throws(() => resolveMode("nope", {}), (e) => e.message.includes("mode="));
  });

  it("speaks the Python SDK's alias vocabulary exactly", () => {
    // Kept in step with `agent_flywheel/__init__.py:_MODE_ALIASES`.
    assert.deepEqual(MODE_ALIASES, {
      training: "training",
      train: "training",
      rollout: "training",
      rollouts: "training",
      "fine-tuning": "training",
      finetuning: "training",
      improving: "training",
      production: "production",
      prod: "production",
      serving: "production",
    });
  });

  it("keeps 'rollout' meaning training, because it is the legacy value", () => {
    assert.equal(resolveMode("rollout", {}), TRAINING);
  });
});
