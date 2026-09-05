/**
 * THE OPT-IN LANE. Off unless asked for; degrades instead of failing.
 *
 * This lane starts turns through a host seam OpenClaw restricts for its own
 * scheduling API, so the two properties that make it defensible are the ones
 * asserted hardest here: an operator has to turn it on, and when the seam is
 * not there the plugin keeps working the ordinary way instead of dropping
 * rollouts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { register, PLUGIN_ID } from "../src/index.js";
import { createRolloutDriver } from "../src/rollout.js";
import {
  JOB_PREFIX, createUnattendedRunner, cronTurnStarter, sessionKeyFor,
} from "../src/unattended.js";
import { readFileSync } from "node:fs";

import { resolveConfig } from "../src/config.js";

const trainingApi = () => {
  const hooks = [];
  return {
    hooks,
    id: PLUGIN_ID, on: (n) => hooks.push(n), logger: { info() {}, warn() {} },
    config: { plugins: { entries: {
      [PLUGIN_ID]: { hooks: { allowConversationAccess: true } } } } },
    session: { workflow: { enqueueNextTurnInjection: async () => ({ enqueued: true }) } },
  };
};
const TRAINING_ENV = { PERCEPTEYE_AGENT_MODE: "training", PERCEPTEYE_API_KEY: "k" };

describe("the mode is the only switch", () => {
  it("training mode subscribes the gateway hooks; nothing else is needed", () => {
    const api = trainingApi();
    register(api, {}, TRAINING_ENV);
    for (const h of ["gateway_start", "gateway_stop"]) {
      assert.ok(api.hooks.includes(h), `${h} must be subscribed`);
    }
    // AND the delivery lane stays: starting turns ADDS to it, so a host with
    // no cron seam still claims and delivers rather than losing rollouts.
    assert.ok(api.hooks.includes("session_start"));
  });

  it("NEVER starts turns in production mode", () => {
    // Structural, not conditional: the rollout driver is not constructed in
    // production, so this module is never reached. This is the one combination
    // that would be indefensible -- a plugin starting its own turns inside a
    // process serving real users.
    const api = trainingApi();
    // No key: production capture would otherwise subscribe `gateway_stop` for
    // its shutdown flush, which is a capture concern and not a rollout one.
    register(api, {}, { PERCEPTEYE_AGENT_MODE: "production" });
    for (const h of ["gateway_start", "gateway_stop", "session_start"]) {
      assert.ok(!api.hooks.includes(h), `production mode subscribed '${h}'`);
    }
  });

  it("carries no second switch for the same question", () => {
    // `PERCEPTEYE_AGENT_MODE` answers "does this install drive?". A second
    // flag would be a second answer to it, and the state it could name --
    // claim rollouts but wait for a human to start each turn -- has no
    // customer behind it.
    const schema = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ).configSchema;
    assert.ok(!("unattended" in schema.properties),
      "a per-feature rollout switch is back; the mode already answers this");
    assert.equal(resolveConfig({}, {}).unattended, undefined);
  });
});

describe("starting a turn through cron", () => {
  it("builds the same job shape the host's own wrapper builds", async () => {
    const added = [];
    const start = cronTurnStarter(() => ({ add: async (j) => { added.push(j); } }));
    const r = await start({ sessionKey: "s", message: "do it", rolloutId: "r1" });
    assert.equal(r.started, true);
    const job = added[0];
    assert.equal(job.payload.kind, "agentTurn");
    assert.equal(job.payload.message, "do it");
    assert.equal(job.sessionTarget, "session:s");
    assert.equal(job.deleteAfterRun, true);
    assert.equal(job.declarationKey, `${JOB_PREFIX}r1`);
    // NOT "announce": training output must not surface in a human's chat.
    assert.equal(job.delivery.mode, "none");
  });

  it("runs in a dedicated session, never a person's", () => {
    assert.equal(sessionKeyFor("r1"), "percepteye-rollout-r1");
  });

  it("reports DEGRADED when the cron seam is not there", async () => {
    // The seam this lane uses can be closed in a host patch release. That must
    // read as "fall back", not as an error.
    const start = cronTurnStarter(() => undefined);
    const r = await start({ sessionKey: "s", message: "m", rolloutId: "r1" });
    assert.equal(r.started, false);
    assert.equal(r.degraded, true);
  });

  it("does NOT call a refusal a degradation", async () => {
    // Cron answered and said no. Quietly dropping to the other lane here would
    // hide a real error.
    const start = cronTurnStarter(() => ({
      add: async () => { throw new Error("bad schedule"); } }));
    const r = await start({ sessionKey: "s", message: "m", rolloutId: "r1" });
    assert.equal(r.started, false);
    assert.equal(r.degraded, false);
    assert.match(r.reason, /bad schedule/);
  });
});

function harness({ started = true, degraded = false, rollouts } = {}) {
  const calls = { claim: 0, report: [], abandon: [], turns: [] };
  const transport = {
    claim: async () => {
      calls.claim += 1;
      return { rollouts: rollouts ?? [{ rolloutId: "r1", turnInput: "t", leaseToken: "lt" }] };
    },
    report: async (r, o) => { calls.report.push([r, o]); },
    abandon: async (r, o) => { calls.abandon.push([r, o]); },
  };
  const driver = createRolloutDriver({
    transport, enqueue: async () => ({ enqueued: true }),
  });
  const runner = createUnattendedRunner({
    transport, driver,
    startTurn: async (t) => {
      calls.turns.push(t);
      return { started, degraded, reason: started ? null : "no cron" };
    },
  });
  return { calls, driver, runner };
}

describe("the unattended loop", () => {
  it("claims a rollout and starts a turn for it", async () => {
    const h = harness();
    await h.runner.tick();
    assert.equal(h.calls.claim, 1);
    assert.equal(h.calls.turns.length, 1);
    assert.equal(h.calls.turns[0].sessionKey, "percepteye-rollout-r1");
    assert.match(h.calls.turns[0].message, /t/);
  });

  it("tracks the rollout so agent_end can report it", async () => {
    const h = harness();
    await h.runner.tick();
    await h.driver.onAgentEnd(
      { success: true, messages: [{ role: "assistant", content: "done" }] },
      { sessionKey: "percepteye-rollout-r1" },
    );
    assert.equal(h.calls.report.length, 1);
    assert.equal(h.calls.report[0][1].finalText, "done");
  });

  it("runs ONE rollout at a time", async () => {
    const h = harness();
    await h.runner.tick();
    await h.runner.tick();
    assert.equal(h.calls.claim, 1, "must not claim while one is still running");
  });

  it("claims again once the previous one has been reported", async () => {
    const h = harness();
    await h.runner.tick();
    await h.driver.onAgentEnd(
      { success: true, messages: [{ role: "assistant", content: "done" }] },
      { sessionKey: "percepteye-rollout-r1" });
    await h.runner.tick();
    assert.equal(h.calls.claim, 2);
  });

  it("GIVES THE ROLLOUT BACK when the turn cannot be started", async () => {
    // Otherwise the lease is held until it lapses and the queue looks busy.
    const h = harness({ started: false, degraded: true });
    await h.runner.tick();
    assert.equal(h.calls.abandon.length, 1);
    assert.equal(h.calls.abandon[0][1].reason, "entrypoint_error");
    assert.equal(h.calls.report.length, 0);
    assert.equal(h.driver.inFlight.size, 0, "a given-back rollout must not stay tracked");
  });

  it("claims nothing when there is no work", async () => {
    const h = harness({ rollouts: [] });
    await h.runner.tick();
    assert.equal(h.calls.turns.length, 0);
    assert.equal(h.calls.abandon.length, 0);
  });

  it("survives a control plane that is down", async () => {
    const h = harness();
    const runner = createUnattendedRunner({
      transport: { ...h.driver, claim: async () => { throw new Error("down"); } },
      driver: h.driver, startTurn: async () => ({ started: true }),
    });
    await assert.doesNotReject(async () => { await runner.tick(); });
  });

  it("stop() is safe before start() and idempotent", () => {
    const h = harness();
    assert.doesNotThrow(() => { h.runner.stop(); h.runner.stop(); });
  });
});
