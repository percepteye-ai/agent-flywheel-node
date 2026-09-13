import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  canonicalObservationSha256, createExecutionIdentityTracker,
  normalizeExecutionSnapshot,
} from "../src/execution-identity.js";
import { register } from "../src/index.js";
import { createRolloutDriver } from "../src/rollout.js";
import {
  readExecutionFingerprint, recordExecutionFingerprint, recordTurnText, turnDir,
  turnWire,
} from "../src/turns.js";

const EVENT = {
  runId: "run-1",
  sessionId: "session-1",
  provider: "openai-compatible",
  model: "customer-model",
  systemPrompt: "You are a support agent.",
  tools: [{
    name: "lookup",
    description: "Look up a record",
    parameters: { type: "object", properties: { id: { type: "string" } } },
  }],
};

const SNAPSHOT = {
  adapterName: "customer-host",
  executionIdentityComplete: true,
  executionComponents: { customer_agent_code: "a".repeat(64) },
};

const STARTUP_OBSERVATION = {
  systemPrompt: EVENT.systemPrompt,
  tools: EVENT.tools,
  provider: EVENT.provider,
  model: EVENT.model,
};

const tracker = (snapshot = SNAPSHOT) => createExecutionIdentityTracker({
  executionSnapshot: snapshot,
  mode: "training",
  agentId: "support",
});

describe("generic execution reconciliation", () => {
  it("exposes one immutable pre-claim fingerprint from the runtime descriptor path", () => {
    const value = tracker({
      ...SNAPSHOT,
      startupObservation: STARTUP_OBSERVATION,
    });
    const registered = value.registrationFingerprint;
    assert.match(registered.execution_sha256, /^[0-9a-f]{64}$/);
    assert.equal(Object.isFrozen(registered), true);
    const description = value.registrationDescription;
    assert.equal(description.agent_name, "support");
    assert.equal(description.system_prompt, STARTUP_OBSERVATION.systemPrompt);
    assert.equal(description.tool_definitions[0].name, "lookup");
    assert.equal(Object.isFrozen(description), true);
    assert.equal(Object.isFrozen(description.tool_definitions), true);
    assert.equal(Object.isFrozen(description.tool_definitions[0]), true);

    const runtime = value.observe(EVENT, { runId: "run-1" });
    assert.deepEqual(runtime.fingerprint, registered);
    assert.throws(() => {
      registered.execution_sha256 = "b".repeat(64);
    }, TypeError);
    assert.throws(() => {
      description.tool_definitions[0].name = "caller-rewrite";
    }, TypeError);
    assert.deepEqual(value.registrationFingerprint, runtime.fingerprint);
  });

  it("reconciles fields a host omits per run from exact startup evidence", () => {
    const value = tracker({
      ...SNAPSHOT,
      startupObservation: STARTUP_OBSERVATION,
    });
    const currentOpenClawEvent = { ...EVENT };
    delete currentOpenClawEvent.tools;
    const observed = value.observe(currentOpenClawEvent, { runId: "run-1" });
    assert.deepEqual(observed.fingerprint, value.registrationFingerprint);

    const drifted = value.observe({
      ...currentOpenClawEvent, runId: "run-2", model: "different-model",
    }, {});
    assert.notDeepEqual(drifted.fingerprint, value.registrationFingerprint);
    assert.equal(
      value.observe({ runId: "bare" }, {}), null,
      "a run id alone must not inherit the registered execution",
    );
  });

  it("keeps startup evidence optional and runtime reconciliation backward compatible", () => {
    const value = tracker();
    assert.equal(value.registrationFingerprint, null);
    assert.equal(value.registrationDescription, null);
    assert.match(
      value.observe(EVENT, { runId: "run-1" }).fingerprint.execution_sha256,
      /^[0-9a-f]{64}$/,
    );
  });

  it("abstains on lossy startup evidence without disabling exact runtime evidence", () => {
    const cases = [
      { ...STARTUP_OBSERVATION, tools: undefined },
      { ...STARTUP_OBSERVATION, tools: [...EVENT.tools, { description: "nameless" }] },
      { ...STARTUP_OBSERVATION, provider: "" },
      // The closed observation has no caller-authored final-digest field.
      { ...STARTUP_OBSERVATION, execution_sha256: "b".repeat(64) },
    ];
    for (const startupObservation of cases) {
      const value = tracker({ ...SNAPSHOT, startupObservation });
      assert.equal(value.enabled, true);
      assert.equal(value.registrationFingerprint, null);
      assert.equal(value.registrationDescription, null);
      assert.ok(value.observe(EVENT, { runId: "run-1" }).fingerprint);
    }
  });

  it("emits only from complete adapter evidence plus an exact observation", () => {
    const enabled = tracker();
    const observed = enabled.observe(EVENT, { runId: "run-1" });
    assert.match(observed.fingerprint.execution_sha256, /^[0-9a-f]{64}$/);

    assert.equal(tracker(null).observe(EVENT, { runId: "run-1" }), null);
    assert.equal(
      tracker({ ...SNAPSHOT, executionIdentityComplete: false })
        .observe(EVENT, { runId: "run-1" }),
      null,
    );
    assert.equal(tracker().observe({ ...EVENT, tools: undefined }, {}), null);
    assert.equal(tracker().observe({ ...EVENT, provider: undefined }, {}), null);
    assert.equal(
      tracker().observe({
        ...EVENT, tools: [...EVENT.tools, { description: "nameless" }],
      }, {}),
      null,
    );
  });

  it("abstains on the current OpenClaw llm_input shape, which has no tools", () => {
    const actualHostShape = {
      runId: "run-1",
      sessionId: "session-1",
      provider: "effective-provider",
      model: "effective-post-policy-model",
      systemPrompt: "assembled prompt",
      prompt: "task",
      historyMessages: [],
      imagesCount: 0,
    };
    assert.equal(tracker().observe(actualHostShape, {}), null);
  });

  it("treats component names as opaque and refuses a caller-authored digest", () => {
    assert.equal(normalizeExecutionSnapshot(SNAPSHOT).snapshot.executionComponents
      .customer_agent_code, "a".repeat(64));
    const invalid = normalizeExecutionSnapshot({
      ...SNAPSHOT,
      executionComponents: { execution_sha256: "b".repeat(64) },
    });
    assert.equal(invalid.snapshot, null);
    assert.match(invalid.reason, /must not author/);
    assert.equal(normalizeExecutionSnapshot({
      ...SNAPSHOT,
      executionComponents: { ["bad\ud800name"]: "b".repeat(64) },
    }).snapshot, null);
    const normalized = normalizeExecutionSnapshot({
      ...SNAPSHOT,
      startupObservation: STARTUP_OBSERVATION,
    });
    assert.deepEqual(normalized.snapshot.startupObservation, STARTUP_OBSERVATION);
  });

  it("matches the Python canonical vector and rejects lossy JSON values", () => {
    const value = {
      unicode: "😀",
      ordered: { "\ue000": 1, "😀": 2 },
      numbers: [1, 1.0, -0, 0.1, 9_007_199_254_740_991],
      values: [null, true, false, "line\n"],
    };
    assert.equal(
      canonicalObservationSha256(value),
      "d7666c3413207b73217f8b97029984e2105d4b5a9128572af42609e60486cac5",
    );
    assert.equal(
      canonicalObservationSha256({ zero: -0 }),
      canonicalObservationSha256({ zero: 0 }),
    );
    assert.throws(
      () => canonicalObservationSha256({ unsafe: 9_007_199_254_740_992 }),
      /exact JSON range/,
    );
    assert.throws(
      () => canonicalObservationSha256({ bad: "\ud800" }),
      /invalid Unicode/,
    );
  });

  it("changes when behavior or adapter-attested state changes", () => {
    const first = tracker().observe(EVENT, {}).fingerprint.execution_sha256;
    const changedPrompt = tracker().observe(
      { ...EVENT, systemPrompt: `${EVENT.systemPrompt} Be terse.` }, {},
    ).fingerprint.execution_sha256;
    const changedState = tracker({
      ...SNAPSHOT,
      executionComponents: { customer_agent_code: "b".repeat(64) },
    }).observe(EVENT, {}).fingerprint.execution_sha256;
    assert.notEqual(first, changedPrompt);
    assert.notEqual(first, changedState);
  });

  it("hashes the full observation before its lossy storage projection", () => {
    const withNul = tracker().observe({
      ...EVENT, systemPrompt: "You are a\0support agent.",
    }, {}).fingerprint.execution_sha256;
    const projectedTwin = tracker().observe({
      ...EVENT, systemPrompt: "You are asupport agent.",
    }, {}).fingerprint.execution_sha256;
    assert.notEqual(withNul, projectedTwin);

    const cyclicTool = { name: "lookup", parameters: {} };
    cyclicTool.parameters.self = cyclicTool.parameters;
    assert.equal(tracker().observe({ ...EVENT, tools: [cyclicTool] }, {}), null);
    assert.equal(tracker().observe({
      ...EVENT, systemPrompt: "bad\ud800prompt",
    }, {}), null);
  });

  it("invalidates a run that observes two different descriptors", () => {
    const value = tracker();
    assert.ok(value.observe(EVENT, {}).fingerprint);
    const second = value.observe({ ...EVENT, model: "different-model" }, {});
    assert.equal(second.fingerprint, null);
    assert.equal(second.conflict, true);
    assert.equal(value.fingerprintFor(EVENT, {}), null);
  });

  it("scopes identity to a run and consumes it without poisoning a reused session", () => {
    const value = tracker();
    const firstEvent = { ...EVENT, runId: "run-1", sessionId: "shared-session" };
    const secondEvent = {
      ...EVENT,
      runId: "run-2",
      sessionId: "shared-session",
      model: "next-effective-model",
    };
    const first = value.observe(firstEvent, {}).fingerprint;
    const second = value.observe(secondEvent, {}).fingerprint;
    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first.execution_sha256, second.execution_sha256);
    assert.deepEqual(value.consumeFingerprintFor(firstEvent, {}), first);
    assert.equal(value.fingerprintFor(firstEvent, {}), null);
    assert.deepEqual(value.fingerprintFor(secondEvent, {}), second);
  });
});

describe("identity reaches reports without becoming policy identity", () => {
  it("names invalid configured evidence once and keeps capture running", () => {
    const warnings = [];
    const api = {
      on() {},
      logger: { info() {}, warn: (message) => warnings.push(message) },
    };
    const plugin = register(api, {
      mode: "production",
      executionSnapshot: {
        ...SNAPSHOT,
        executionComponents: { execution_sha256: "b".repeat(64) },
      },
    }, { PERCEPTEYE_CAPTURE_DIR: mkdtempSync(join(tmpdir(), "pe-invalid-id-")) });
    assert.ok(plugin);
    assert.equal(plugin.executionIdentity.enabled, false);
    assert.equal(warnings.filter((message) => (
      message.includes("exact execution identity is disabled")
    )).length, 1);
  });

  it("wires the host observation into the exact production turn", () => {
    const root = mkdtempSync(join(tmpdir(), "pe-identity-wired-"));
    const handlers = new Map();
    const api = {
      on: (name, fn) => handlers.set(name, fn),
      logger: { info() {}, warn() {} },
    };
    register(api, {
      mode: "production",
      executionSnapshot: SNAPSHOT,
    }, { PERCEPTEYE_CAPTURE_DIR: root });
    handlers.get("message_received")({
      runId: "run-1", content: "help", sessionKey: "session-1",
    }, {});
    handlers.get("llm_input")(EVENT, { runId: "run-1", sessionKey: "session-1" });
    const wire = turnWire(turnDir(root, "run-1"));
    assert.match(wire.agent_fingerprint.execution_sha256, /^[0-9a-f]{64}$/);
  });

  it("persists on a turn and a conflicting writer makes the wire abstain", () => {
    const dir = mkdtempSync(join(tmpdir(), "pe-identity-"));
    recordTurnText(dir, "task", "help");
    const first = { execution_sha256: "a".repeat(64) };
    assert.equal(recordExecutionFingerprint(dir, first), true);
    assert.deepEqual(readExecutionFingerprint(dir), first);
    assert.deepEqual(turnWire(dir).agent_fingerprint, first);

    assert.equal(recordExecutionFingerprint(
      dir, { execution_sha256: "b".repeat(64) }), false);
    assert.equal(readExecutionFingerprint(dir), null);
    assert.equal("agent_fingerprint" in turnWire(dir), false);
  });

  it("stamps the SDK-reconciled digest on a rollout report", async () => {
    const identity = tracker();
    identity.observe(EVENT, { sessionKey: "s1" });
    const reports = [];
    const transport = {
      claim: async () => ({ rollouts: [{
        rolloutId: "r1", turnInput: "help", leaseToken: "lease",
      }] }),
      report: async (rollout, output) => reports.push([rollout, output]),
      abandon: async () => {},
    };
    const driver = createRolloutDriver({
      transport,
      enqueue: async () => ({ enqueued: true }),
      executionIdentity: identity,
    });
    await driver.onSessionStart({ sessionKey: "s1" });
    await driver.onAgentEnd(
      { runId: "run-1", messages: [{ role: "assistant", content: "done" }] },
      { sessionKey: "s1" },
    );
    assert.match(
      reports[0][1].agentFingerprint.execution_sha256, /^[0-9a-f]{64}$/,
    );
    assert.deepEqual(Object.keys(reports[0][1].agentFingerprint), ["execution_sha256"]);
  });
});
