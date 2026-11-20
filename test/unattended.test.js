/**
 * THE MODE IS THE ONLY SWITCH. Training drives; production cannot reach here.
 *
 * This header used to say the lane was opt-in and that "an operator has to
 * turn it on". Commit 2db3b15 deleted `PERCEPTEYE_UNATTENDED` and the header
 * outlived it -- so a reviewer asking "does this plugin start turns by
 * itself?" read a file whose first suite is titled "the mode is the only
 * switch" and was told the opposite by the paragraph above it.
 *
 * This lane starts turns through a host seam OpenClaw restricts for its own
 * scheduling API, so the two properties that actually make it defensible are
 * the ones asserted hardest here:
 *
 *   1. It is confined to training mode STRUCTURALLY -- production never
 *      constructs the driver, so this module is unreachable there.
 *   2. When the seam is not there it DEGRADES: it STOPS POLLING and leaves
 *      the injection lane to claim, rather than claiming a rollout every poll
 *      and handing it straight back. Mission Control spends an attempt on
 *      each of those and retires the rollout unrun at the third, so "degrades
 *      instead of failing" is only true if the loop actually stops.
 */
import { testEnv } from "./support/home.js";
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
    registerProvider: () => {},
  };
};
const TRAINING_ENV = () => testEnv({
  PERCEPTEYE_AGENT_MODE: "training", PERCEPTEYE_API_KEY: "k",
});

describe("the mode is the only switch", () => {
  it("training mode subscribes the gateway hooks; nothing else is needed", () => {
    const api = trainingApi();
    register(api, {}, TRAINING_ENV());
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
    register(api, {}, testEnv({ PERCEPTEYE_AGENT_MODE: "production" }));
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

function harness({ started = true, degraded = false, rollouts, pollMs } = {}) {
  const calls = { claim: 0, report: [], abandon: [], turns: [], warns: [] };
  const transport = {
    claim: async () => {
      calls.claim += 1;
      // DISTINCT ids per claim, like a real queue: the churn this suite pins
      // is one rollout burned per poll, and a fixture that hands back the
      // same row every time hides how many of them there were.
      return {
        rollouts: rollouts
          ?? [{ rolloutId: `r${calls.claim}`, turnInput: "t", leaseToken: "lt" }],
      };
    },
    report: async (r, o) => { calls.report.push([r, o]); },
    abandon: async (r, o) => { calls.abandon.push([r, o]); },
  };
  const driver = createRolloutDriver({
    env: testEnv(),
    transport, enqueue: async () => ({ enqueued: true }),
  });
  const runner = createUnattendedRunner({
    // No `transport`: this lane claims through `driver.claim`, which is the
    // one seam that drains held results before asking for more work.
    driver, pollMs,
    logger: { info() {}, warn: (m) => calls.warns.push(String(m)) },
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
    // INJECTED THROUGH THE DRIVER, because that is where claiming now happens.
    // This used to hand the runner its own `transport` with a throwing
    // `claim`; once the runner started claiming via `driver.claim` that object
    // was simply unused, and the test asserted that a runner whose claim
    // SUCCEEDS does not reject -- which is not the property it is named for.
    const driver = createRolloutDriver({
      env: testEnv(),
      transport: {
        claim: async () => { throw new Error("down"); },
        report: async () => {}, abandon: async () => {},
      },
      enqueue: async () => ({ enqueued: true }),
    });
    const runner = createUnattendedRunner({
      driver, startTurn: async () => ({ started: true }),
    });
    await assert.doesNotReject(async () => { await runner.tick(); });
  });

  it("stop() is safe before start() and idempotent", () => {
    const h = harness();
    assert.doesNotThrow(() => { h.runner.stop(); h.runner.stop(); });
  });
});

describe("a dead seam stops this lane instead of eating the queue", () => {
  it("claims ONCE across many ticks, not once per tick", async () => {
    // THE FAILURE THIS PINS. `giveBack` posts `entrypoint_error`, and Mission
    // Control's `claim` increments `attempt` while `abandon` requeues only
    // while `attempt < max_attempts` (default 3). So a runner that claims and
    // hands back on every poll retires each rollout ABANDONED, unrun, inside
    // 90 seconds -- and the earlier code did exactly that, forever, having
    // announced that it had "fallen back to the default lane".
    const h = harness({ started: false, degraded: true });
    for (let i = 0; i < 5; i += 1) await h.runner.tick();
    assert.equal(h.calls.claim, 1,
      "the degraded runner kept claiming; each extra claim spends one of a " +
      "rollout's three attempts on a turn that can never start");
    assert.equal(h.calls.abandon.length, 1);
    assert.equal(h.calls.turns.length, 1);
  });

  it("says so ONCE, and says that it stopped polling", async () => {
    const h = harness({ started: false, degraded: true });
    for (let i = 0; i < 3; i += 1) await h.runner.tick();
    assert.equal(h.calls.warns.length, 1, "the fallback is announced once");
    assert.match(h.calls.warns[0], /stopped polling/);
  });

  it("CANCELS THE POLLER, not just the claiming", async () => {
    // Asserted on `polling`, not on the claim count, and that is the point:
    // the claim count stays at 1 whether or not the interval was cleared,
    // because `tick`'s guard turns every later wake-up into an early return.
    // A test that checked only the count would pass with `stopTimer()`
    // deleted, leaving a 30s timer running forever in a customer's gateway
    // for a lane the operator was told had gone quiet.
    const h = harness({ started: false, degraded: true, pollMs: 5 });
    h.runner.start();
    assert.equal(h.runner.polling, true);
    await h.runner.tick();
    assert.equal(h.runner.polling, false,
      "the poll interval survived the degradation");
    await new Promise((r) => { setTimeout(r, 60); });
    assert.equal(h.calls.claim, 1, "it woke up and claimed again anyway");
    h.runner.stop();
  });

  it("a refusal is NOT a degradation, so the loop keeps working", async () => {
    // Cron answered and said no to this one job. That is a per-rollout error,
    // not a closed seam, and stopping the lane on it would turn one bad job
    // into an outage.
    const h = harness({ started: false, degraded: false });
    await h.runner.tick();
    await h.runner.tick();
    assert.equal(h.calls.claim, 2);
    assert.equal(h.calls.warns.length, 0);
  });

  it("start() re-arms it, because only a fresh cron context calls start()", async () => {
    // `gateway_start` and `cron_changed` are the only callers, and both mean
    // the host just handed over a cron context -- which is what keeps a
    // later-arriving cron usable rather than caching the degradation forever.
    const h = harness({ started: false, degraded: true });
    await h.runner.tick();
    await h.runner.tick();
    assert.equal(h.calls.claim, 1);
    h.runner.start();
    await h.runner.tick();
    h.runner.stop();
    assert.equal(h.calls.claim, 2, "a re-armed runner must claim again");
  });
});

describe("stopping, starting and pacing (ND-H9)", () => {
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
  };

  it("a starter that THROWS gives the rollout back and leaves nothing tracked", async () => {
    const h = harness();
    const runner = createUnattendedRunner({
      driver: h.driver, logger: { info() {}, warn() {} },
      startTurn: async () => { throw new Error("cron.add exploded"); },
    });
    assert.equal(await runner.tick(), null);
    assert.equal(h.calls.abandon.length, 1);
    assert.match(h.calls.abandon[0][1].detail, /cron\.add exploded/);
    assert.equal(h.driver.inFlight.size, 0);
    assert.equal(h.driver.heartbeats.size, 0);
  });

  it("one concurrency gate for both lanes: an attended rollout blocks the unattended claim", async () => {
    const h = harness();
    await h.driver.onSessionStart({ sessionKey: "a-person" });
    assert.equal(h.driver.inFlight.size, 1);
    await h.runner.tick();
    assert.equal(h.calls.claim, 1, "the unattended lane claimed past concurrency: 1");
    assert.equal(h.calls.turns.length, 0);
  });

  it("...and an unattended rollout blocks the attended claim", async () => {
    const h = harness();
    await h.runner.tick();
    assert.equal(await h.driver.onSessionStart({ sessionKey: "a-person" }), null);
    assert.equal(h.calls.claim, 1);
  });

  it("a claim that lands after stop() is handed back, not started", async () => {
    let answer;
    const calls = { abandon: [], turns: [] };
    const driver = createRolloutDriver({
      env: testEnv(),
      transport: {
        claim: () => new Promise((r) => { answer = r; }),
        report: async () => {}, abandon: async (r, o) => { calls.abandon.push([r, o]); },
      },
      enqueue: async () => ({ enqueued: true }),
    });
    const runner = createUnattendedRunner({
      driver, startTurn: async (t) => { calls.turns.push(t); return { started: true }; },
    });
    const ticking = runner.tick();
    await settle();
    runner.stop();
    answer({ rollouts: [{ rolloutId: "r-late", turnInput: "t", leaseToken: "lt" }] });
    assert.equal(await ticking, null);
    assert.deepEqual(calls.turns, []);
    assert.equal(calls.abandon[0][0].rolloutId, "r-late");
    assert.equal(driver.inFlight.size, 0);
  });

  it("cron_changed after gateway_stop does not restart the poller; gateway_start does", () => {
    const h = harness();
    h.runner.start();
    h.runner.stop();
    h.runner.resume();
    assert.equal(h.runner.polling, false, "a cron change restarted a stopped gateway's poller");
    h.runner.start();
    assert.equal(h.runner.polling, true);
    h.runner.stop();
  });

  it("is wired that way to the host's hooks", () => {
    const hooks = new Map();
    const api = { ...trainingApi(), on: (n, fn) => hooks.set(n, fn) };
    const out = register(api, {}, TRAINING_ENV());
    const runner = out.rollouts.unattended;
    hooks.get("gateway_start")({}, {});
    hooks.get("gateway_stop")({}, {});
    return settle().then(() => {
      hooks.get("cron_changed")({}, { getCron: () => null });
      return settle();
    }).then(() => {
      assert.equal(runner.polling, false);
    });
  });

  it("paces itself by the control plane's pollAfterMs", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let claims = 0;
    const driver = createRolloutDriver({
      env: testEnv(),
      transport: {
        claim: async () => { claims += 1; return { rollouts: [], pollAfterMs: 1_000 }; },
        report: async () => {}, abandon: async () => {},
      },
      enqueue: async () => ({ enqueued: true }),
    });
    const runner = createUnattendedRunner({
      driver, pollMs: 30_000, startTurn: async () => ({ started: true }),
    });
    runner.start();
    t.mock.timers.tick(30_000);
    await settle();
    assert.equal(claims, 1);
    t.mock.timers.tick(1_000);
    await settle();
    assert.equal(claims, 2, "the next poll waited pollMs, not the server's pollAfterMs");
    runner.stop();
  });
});
