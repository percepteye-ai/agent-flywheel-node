/**
 * THE SEAMS, NOT THE STORE.
 *
 * `outbox.test.js` pins what a durable outbox does. This file pins that the
 * rollout lane is actually WIRED to one at both ends -- a producer that writes
 * every outcome before sending it, and a consumer that drains before every
 * claim -- because a store with only one end is the defect this package keeps
 * finding, not the fix for it.
 *
 * Plus the other half of "the delivery mechanism cannot become the outage":
 * the heartbeat. One unexpected exception in that loop reproduces the original
 * incident exactly -- the lease stops being renewed, the reaper writes
 * `abandoned` over a rollout that is still running, and no report is ever
 * accepted.
 */
import { testHome } from "./support/home.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { LeaseLost, TransportError } from "../src/errors.js";
import { outboxDir, spoolName } from "../src/outbox.js";
import { createRolloutDriver, registerRolloutDriver } from "../src/rollout.js";
import { createUnattendedRunner } from "../src/unattended.js";

const listing = (dir) => { try { return readdirSync(dir).sort(); } catch { return []; } };

const ANSWERED = {
  success: true, messages: [{ role: "assistant", content: "the answer" }],
};

/**
 * A driver whose outbox is a temp directory of this test's own.
 *
 * `env` rather than a hand-built outbox, because that is the production path:
 * `index.js` hands `registerRolloutDriver` an `env` and the directory is
 * derived from it. A fixture that injected a store directly would prove the
 * store works and say nothing about whether the driver reaches one.
 */
function driverOn(dir, { claim, report, heartbeat } = {}) {
  const calls = { claim: 0, sent: [] };
  const transport = {
    agentId: "a1",
    claim: claim ?? (async () => {
      calls.claim += 1;
      return { rollouts: [{
        rolloutId: `r${calls.claim}`, turnInput: "work", leaseToken: "lease",
      }] };
    }),
    report: report ?? (async (r, o) => { calls.sent.push([r.rolloutId, o]); }),
    abandon: async () => {},
    heartbeat: heartbeat ?? (async () => {}),
  };
  const driver = createRolloutDriver({
    transport,
    enqueue: async () => ({ enqueued: true }),
    env: { PERCEPTEYE_HOME: dir },
  });
  return { driver, transport, calls, dir: outboxDir("a1", { PERCEPTEYE_HOME: dir }) };
}

describe("the producer: every outcome is written down before it is sent", () => {
  it("keeps the agent's answer when the report is refused", async () => {
    const home = testHome();
    const h = driverOn(home, {
      report: async () => { throw new TransportError("upstream is down"); },
    });
    await h.driver.onSessionStart({ sessionKey: "s1" });
    const reported = await h.driver.onAgentEnd(ANSWERED, { sessionKey: "s1" });

    assert.equal(reported, null, "a held result is not a delivered one");
    const path = join(h.dir, spoolName("r1"));
    const record = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(record.output.finalText, "the answer",
      "the agent's entire work product was lost with the failed POST");
  });

  it("holds an outcome even when the process never gets to send it", async () => {
    const home = testHome();
    let onDisk = null;
    const h = driverOn(home, {
      report: async () => {
        onDisk = listing(outboxDir("a1", { PERCEPTEYE_HOME: home }));
        throw new Error("killed mid-POST");
      },
    });
    await h.driver.onSessionStart({ sessionKey: "s1" });
    await h.driver.onAgentEnd(ANSWERED, { sessionKey: "s1" });
    assert.deepEqual(onDisk, [spoolName("r1")],
      "the outcome was not durable at the moment of the POST");
  });

  it("leaves nothing behind when the report lands", async () => {
    const home = testHome();
    const h = driverOn(home);
    await h.driver.onSessionStart({ sessionKey: "s1" });
    assert.ok(await h.driver.onAgentEnd(ANSWERED, { sessionKey: "s1" }));
    assert.deepEqual(listing(h.dir), []);
  });
});

describe("the consumer: held results go out before more work is claimed", () => {
  it("drains before the ATTENDED lane claims", async () => {
    const home = testHome();
    const order = [];
    let refuse = true;
    const h = driverOn(home, {
      claim: async () => {
        order.push("claim");
        return { rollouts: [{ rolloutId: "r1", turnInput: "w", leaseToken: "l" }] };
      },
      report: async (r) => {
        order.push(`report:${r.rolloutId}`);
        if (refuse) throw new TransportError("upstream is down");
      },
    });
    await h.driver.onSessionStart({ sessionKey: "s1" });
    await h.driver.onAgentEnd(ANSWERED, { sessionKey: "s1" });
    refuse = false;
    await h.driver.onSessionStart({ sessionKey: "s2" });

    assert.deepEqual(order, ["claim", "report:r1", "report:r1", "claim"],
      "a finished result must not wait behind the next rollout");
    assert.deepEqual(listing(h.dir), []);
  });

  it("drains before the UNATTENDED lane claims", async () => {
    // The lane that used to hold its own `transport.claim`. If it still did,
    // this would claim without ever draining.
    const home = testHome();
    const order = [];
    let refuse = true;
    const h = driverOn(home, {
      claim: async () => {
        order.push("claim");
        return { rollouts: [{ rolloutId: "r1", turnInput: "w", leaseToken: "l" }] };
      },
      report: async (r) => {
        order.push(`report:${r.rolloutId}`);
        if (refuse) throw new TransportError("upstream is down");
      },
    });
    const runner = createUnattendedRunner({
      driver: h.driver, startTurn: async () => ({ started: true }),
    });
    await runner.tick();
    await h.driver.onAgentEnd(ANSWERED, { sessionKey: "percepteye-rollout-r1" });
    refuse = false;
    await runner.tick();

    assert.deepEqual(order, ["claim", "report:r1", "report:r1", "claim"]);
    assert.deepEqual(listing(h.dir), []);
  });

  it("claims anyway when the drain itself fails", async () => {
    // A local outbox fault must not stop the agent claiming work. It is named
    // as itself, rather than reported as an unreachable control plane.
    const home = testHome();
    const warns = [];
    const transport = {
      agentId: "a1",
      claim: async () => ({ rollouts: [] }),
      report: async () => {}, abandon: async () => {}, heartbeat: async () => {},
    };
    const driver = createRolloutDriver({
      transport,
      enqueue: async () => ({ enqueued: true }),
      logger: { info() {}, warn: (m) => warns.push(String(m)) },
      env: { PERCEPTEYE_HOME: home },
      outbox: { drain: async () => { throw new Error("disk is gone"); },
                deliver: async () => true },
    });
    assert.deepEqual(await driver.claim(1), { rollouts: [] });
    assert.ok(warns.some((w) => /outbox drain failed.*disk is gone/.test(w)),
      `the drain failure was not named as itself: ${warns.join(" | ")}`);
  });
});

describe("restart recovery, through the driver", () => {
  it("a second process delivers what the first could not", async () => {
    const home = testHome();
    const first = driverOn(home, {
      report: async () => { throw new TransportError("upstream is down"); },
    });
    await first.driver.onSessionStart({ sessionKey: "s1" });
    await first.driver.onAgentEnd(ANSWERED, { sessionKey: "s1" });
    assert.deepEqual(listing(first.dir), [spoolName("r1")]);

    // A fresh driver over the same home: no in-memory state, no lease token.
    const second = driverOn(home, { claim: async () => ({ rollouts: [] }) });
    await second.driver.onSessionStart({ sessionKey: "s2" });
    assert.deepEqual(second.calls.sent.map(([id, o]) => [id, o.finalText]),
      [["r1", "the answer"]]);
    assert.deepEqual(listing(second.dir), []);
  });
});

describe("the heartbeat cannot become the outage", () => {
  /** A driver whose heartbeat cadence this test drives by hand. */
  function beating({ heartbeat, logger }) {
    const scheduled = [];
    const driver = createRolloutDriver({
      transport: {
        agentId: "a1", leaseMs: 30_000,
        claim: async () => ({ rollouts: [] }),
        report: async () => {}, abandon: async () => {},
        heartbeat,
      },
      enqueue: async () => ({ enqueued: true }),
      logger,
      env: { PERCEPTEYE_HOME: testHome() },
      heartbeatScheduler: (callback, delayMs) => {
        const token = { callback, delayMs };
        scheduled.push(token);
        return token;
      },
      heartbeatCanceller: () => {},
    });
    driver.track("s1", { rolloutId: "r1", leaseToken: "lease" });
    return { driver, scheduled };
  }

  it("KEEPS RENEWING after an exception it does not recognise", async () => {
    // The original incident, reproduced from one unexpected exception type:
    // renewal stops, the reaper requeues a rollout that is still running, and
    // no report is ever accepted.
    let beats = 0;
    const h = beating({
      heartbeat: async () => { beats += 1; throw new RangeError("something unexpected"); },
      logger: { info() {}, warn() {} },
    });
    await h.scheduled[0].callback();
    assert.equal(beats, 1);
    assert.equal(h.scheduled.length, 2,
      "an unrecognised failure stopped the renewal chain");
    await h.scheduled[1].callback();
    assert.equal(beats, 2);
    assert.equal(h.driver.heartbeats.has("s1"), true);
  });

  it("KEEPS RENEWING when the host's own logger throws", async () => {
    // `logger` belongs to the host. A gateway whose logger raises must not
    // lose its leases over it -- and under Node's default policy the rejection
    // this used to produce is fatal to the whole process, not just the lease.
    let beats = 0;
    const h = beating({
      heartbeat: async () => { beats += 1; throw new TransportError("502"); },
      logger: { info() {}, warn: () => { throw new Error("a logger that raises"); } },
    });
    await assert.doesNotReject(async () => { await h.scheduled[0].callback(); });
    assert.equal(h.scheduled.length, 2, "a throwing logger stopped the renewal chain");
    await h.scheduled[1].callback();
    assert.equal(beats, 2);
  });

  it("KEEPS RENEWING when the lease-loss handler itself fails", async () => {
    // A `cancel` seam that throws is already guarded; this is the guard's own
    // guard. What must not happen is an exception escaping the beat.
    const h = beating({
      heartbeat: async () => { throw new LeaseLost("gone"); },
      logger: { info() {}, warn: () => { throw new Error("a logger that raises"); } },
    });
    await assert.doesNotReject(async () => { await h.scheduled[0].callback(); });
    assert.equal(h.driver.heartbeats.has("s1"), false,
      "a lost lease must still stop the chain");
  });

  it("still stops the chain when the lease is genuinely gone", async () => {
    const h = beating({
      heartbeat: async () => { throw new LeaseLost("gone"); },
      logger: { info() {}, warn() {} },
    });
    await h.scheduled[0].callback();
    assert.equal(h.scheduled.length, 1,
      "renewing a lease the control plane took back is work against a stale row");
    assert.equal(h.driver.inFlight.has("s1"), false);
  });

  it("says so once when the beat cannot even be scheduled", async () => {
    const warns = [];
    const driver = createRolloutDriver({
      transport: {
        agentId: "a1", leaseMs: 30_000,
        claim: async () => ({ rollouts: [] }),
        report: async () => {}, abandon: async () => {}, heartbeat: async () => {},
      },
      enqueue: async () => ({ enqueued: true }),
      logger: { info() {}, warn: (m) => warns.push(String(m)) },
      env: { PERCEPTEYE_HOME: testHome() },
      heartbeatScheduler: () => { throw new Error("no timers left"); },
      heartbeatCanceller: () => {},
    });
    assert.doesNotThrow(() => {
      driver.track("s1", { rolloutId: "r1", leaseToken: "lease" });
    });
    assert.ok(warns.some((w) => /can no longer be renewed/.test(w)),
      `an unrenewable lease was not announced: ${warns.join(" | ")}`);
  });
});

describe("the production wiring", () => {
  it("registerRolloutDriver gives the driver an outbox under PERCEPTEYE_HOME", () => {
    const home = testHome();
    const api = {
      on: () => {},
      logger: { info() {}, warn() {} },
      config: { plugins: { entries: { "agent-flywheel": {
        hooks: { allowConversationAccess: true } } } } },
      session: { workflow: { enqueueNextTurnInjection: async () => ({ enqueued: true }) } },
    };
    const driver = registerRolloutDriver(api, {
      config: { mode: "training", apiKey: "pefw_x", agentId: "svc-7" },
      pluginId: "agent-flywheel",
      transport: {
        agentId: "svc-7",
        health: async () => ({ contract_versions_supported: ["flywheel/1"] }),
        register: async () => ({}),
        claim: async () => ({ rollouts: [] }),
        report: async () => {}, abandon: async () => {}, heartbeat: async () => {},
      },
      env: { PERCEPTEYE_HOME: home },
    });
    assert.equal(driver.outbox.dir, join(home, "outbox", "svc-7"),
      "the production path must not fall back to a default home or a default agent");
  });
});
