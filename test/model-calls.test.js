import { testEnv } from "./support/home.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createModelCallCounter } from "../src/model-calls.js";
import {
  createRolloutDriver, registerRolloutDriver,
} from "../src/rollout.js";
import { rolloutOutputToWire } from "../src/wire.js";

function completed(runId, callId, sessionKey) {
  return { runId, callId, sessionKey, outcome: "completed" };
}

describe("independent model-call accounting", () => {
  it("counts exact host call ids only inside the claimed lifecycle", () => {
    const counter = createModelCallCounter();
    assert.equal(counter.observeStarted({ runId: "before", callId: "c0" }), false);
    assert.equal(counter.begin("session-1"), true);
    assert.equal(counter.observeStarted({
      runId: "run-1", callId: "c1", sessionKey: "session-1",
    }), true);
    assert.equal(counter.observeEnded(completed("run-1", "c1", "session-1")), true);
    assert.equal(counter.observeStarted({
      runId: "run-1", callId: "c2", sessionKey: "session-1",
    }), true);
    assert.equal(counter.observeEnded(completed("run-1", "c2", "session-1")), true);
    assert.deepEqual(
      counter.finish("session-1", { runId: "run-1" }),
      { count: 2, reason: null },
    );
  });

  it("never turns absent observation into an asserted zero", () => {
    const counter = createModelCallCounter();
    counter.begin("session-1");
    const result = counter.finish("session-1", { runId: "run-1" });
    assert.equal(result.count, null);
    assert.match(result.reason, /no provider-call start/);
  });

  it("fails closed on duplicates, missing terminals, errors, and mixed sessions", () => {
    for (const corrupt of [
      (counter) => {
        counter.observeStarted({ runId: "r", callId: "c", sessionKey: "s" });
        counter.observeStarted({ runId: "r", callId: "c", sessionKey: "s" });
        counter.observeEnded(completed("r", "c", "s"));
      },
      (counter) => {
        counter.observeStarted({ runId: "r", callId: "c", sessionKey: "s" });
      },
      (counter) => {
        counter.observeStarted({ runId: "r", callId: "c", sessionKey: "s" });
        counter.observeEnded({
          runId: "r", callId: "c", sessionKey: "s", outcome: "error",
        });
      },
      (counter) => {
        counter.observeStarted({ runId: "r", callId: "c", sessionKey: "other" });
        counter.observeEnded(completed("r", "c", "other"));
      },
    ]) {
      const counter = createModelCallCounter();
      counter.begin("s");
      corrupt(counter);
      assert.equal(counter.finish("s", { runId: "r" }).count, null);
    }
  });

  it("keeps concurrent host runs separate by run and session identity", () => {
    const counter = createModelCallCounter();
    counter.begin("s1");
    counter.begin("s2");
    counter.observeStarted({ runId: "r2", callId: "c2", sessionKey: "s2" });
    counter.observeEnded(completed("r2", "c2", "s2"));
    counter.observeStarted({ runId: "r1", callId: "c1", sessionKey: "s1" });
    counter.observeEnded(completed("r1", "c1", "s1"));
    assert.equal(counter.finish("s1", { runId: "r1" }).count, 1);
    assert.equal(counter.finish("s2", { runId: "r2" }).count, 1);
  });

  it("accepts the host sessionId alias without weakening run binding", () => {
    const counter = createModelCallCounter();
    counter.begin("s1");
    assert.equal(counter.observeStarted({
      runId: "r1", callId: "c1", sessionId: "s1",
    }), true);
    assert.equal(counter.observeEnded({
      runId: "r1", callId: "c1", outcome: "completed",
    }, { sessionId: "s1" }), true);
    assert.deepEqual(counter.finish("s1", { runId: "r1" }), {
      count: 1, reason: null,
    });
  });

  it("does not attribute sessionless or conflicting evidence across rollouts", () => {
    const counter = createModelCallCounter();
    counter.begin("s1");
    counter.begin("s2");
    assert.equal(counter.observeStarted({ runId: "r0", callId: "c0" }), false);
    assert.equal(counter.finish("s1", { runId: "r0" }).count, null);
    assert.equal(counter.finish("s2", { runId: "r0" }).count, null);

    counter.begin("s1");
    counter.begin("s2");
    counter.observeStarted({ runId: "shared", callId: "a", sessionKey: "s1" });
    counter.observeStarted({ runId: "shared", callId: "b", sessionKey: "s2" });
    assert.equal(counter.finish("s1", { runId: "shared" }).count, null);
    assert.equal(counter.finish("s2", { runId: "shared" }).count, null);
  });

  it("ignores ordinary sessions and consumes stale run records on finish", () => {
    const counter = createModelCallCounter();
    counter.begin("rollout");
    assert.equal(counter.observeStarted({
      runId: "ordinary", callId: "outside", sessionKey: "human-chat",
    }), false);
    counter.observeStarted({ runId: "old", callId: "c", sessionKey: "rollout" });
    counter.observeEnded(completed("old", "c", "rollout"));
    assert.equal(counter.finish("rollout", { runId: "different" }).count, null);

    counter.begin("rollout");
    assert.equal(counter.finish("rollout", { runId: "old" }).count, null);
  });
});

describe("rollout reporting", () => {
  function harness() {
    const reports = [];
    const warnings = [];
    const driver = createRolloutDriver({
      env: testEnv(),
      transport: {
        claim: async () => ({ rollouts: [{ rolloutId: "r1", turnInput: "go" }] }),
        report: async (_rollout, output) => reports.push(output),
        abandon: async () => {},
      },
      enqueue: async () => ({ enqueued: true }),
      logger: { info() {}, warn: (message) => warnings.push(String(message)) },
    });
    return { driver, reports, warnings };
  }

  it("reports the host count without consulting the gateway", async () => {
    const h = harness();
    await h.driver.onSessionStart({ sessionKey: "s1" });
    h.driver.onModelCallStarted({ runId: "run-1", callId: "call-1", sessionKey: "s1" });
    h.driver.onModelCallEnded(completed("run-1", "call-1", "s1"));
    h.driver.onModelCallStarted({ runId: "run-1", callId: "call-2", sessionKey: "s1" });
    h.driver.onModelCallEnded(completed("run-1", "call-2", "s1"));
    await h.driver.onAgentEnd(
      { runId: "run-1", success: true, messages: [{ role: "assistant", content: "done" }] },
      { sessionKey: "s1" },
    );
    assert.equal(h.reports[0].llmCallCount, 2);
    assert.deepEqual(h.warnings, []);
  });

  it("omits missing evidence and tells the operator it is ineligible", async () => {
    const h = harness();
    await h.driver.onSessionStart({ sessionKey: "s1" });
    await h.driver.onAgentEnd(
      { runId: "run-1", success: true, messages: [{ role: "assistant", content: "done" }] },
      { sessionKey: "s1" },
    );
    assert.equal(h.reports[0].llmCallCount, undefined);
    assert.equal("llm_call_count" in rolloutOutputToWire(h.reports[0]), false);
    assert.equal(h.warnings.length, 1);
    assert.match(h.warnings[0], /ineligible for verified on-policy training/);
  });

  it("lets a broken custom observer cost eligibility, never the report", async () => {
    const reports = [];
    const driver = createRolloutDriver({
      env: testEnv(),
      transport: {
        claim: async () => ({ rollouts: [{ rolloutId: "r1", turnInput: "go" }] }),
        report: async (_rollout, output) => reports.push(output),
        abandon: async () => {},
      },
      enqueue: async () => ({ enqueued: true }),
      modelCalls: {
        begin() { throw new Error("broken begin"); },
        finish() { throw new Error("broken finish"); },
      },
    });
    await driver.onSessionStart({ sessionKey: "s1" });
    await assert.doesNotReject(() => driver.onAgentEnd(
      { runId: "run-1", messages: [{ role: "assistant", content: "done" }] },
      { sessionKey: "s1" },
    ));
    assert.equal(reports.length, 1);
    assert.equal(reports[0].llmCallCount, undefined);
  });

  it("registers no invented OpenClaw provider-call hooks or count claim", async () => {
    const handlers = new Map();
    const reports = [];
    const api = {
      on: (name, handler) => handlers.set(name, handler),
      config: {
        plugins: { entries: { flywheel: {
          hooks: { allowConversationAccess: true },
        } } },
      },
      session: { workflow: {
        enqueueNextTurnInjection: async () => ({ enqueued: true }),
      } },
    };
    const driver = registerRolloutDriver(api, {
      env: testEnv(),
      config: { mode: "training", apiKey: "key" },
      pluginId: "flywheel",
      transport: {
        report: async (_rollout, output) => reports.push(output),
        abandon: async () => {},
      },
    });
    assert.equal(handlers.has("model_call_started"), false);
    assert.equal(handlers.has("model_call_ended"), false);
    driver.track("s1", { rolloutId: "r1" });
    await driver.onAgentEnd(
      { runId: "run-1", messages: [{ role: "assistant", content: "done" }] },
      { sessionKey: "s1" },
    );
    assert.equal(reports[0].llmCallCount, undefined);
  });
});
