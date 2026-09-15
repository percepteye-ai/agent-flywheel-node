/**
 * TRAINING MODE DRIVES; PRODUCTION MODE DOES NOT EXIST HERE.
 *
 * The first suite is the load-bearing one. "Production claims no work and
 * starts no turn" is promised in the README and in the manifest, and the only
 * thing that makes it true is that `register()` never reaches
 * `registerRolloutDriver`. So the test asserts the ABSENCE OF THE
 * SUBSCRIPTIONS -- not that a handler declined to act, which is what a runtime
 * `if` would give and which a later edit could invert without any test going
 * red.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { register, PLUGIN_ID } from "../src/index.js";
import { resolveDeclaration } from "../src/declaration.js";
import { LeaseLost } from "../src/errors.js";
import { withholdFingerprints } from "../src/execution-identity.js";
import { SDK_UA } from "../src/http.js";
import {
  MAX_INJECTION_BYTES, conversationAccessGranted, createRolloutDriver,
  driveVerdict, lastAssistantText, registerRolloutDriver, taskText,
} from "../src/rollout.js";

// ROLLOUT-EXCLUSIVE hooks only. `agent_end` used to be in this list and had
// to come out: production turn capture subscribes it too, to record the
// agent's answer, so its presence no longer discriminates between the two
// lanes. Narrowing the list does NOT weaken the claim -- "the driver is never
// constructed in production" is asserted directly by the production-branch
// test below, which is the assertion that actually caught a deleted split.
const ROLLOUT_HOOKS = [
  "session_start", "session_end", "gateway_start", "before_agent_run",
  "before_tool_call",
];

/** A host api that records what was subscribed. */
function fakeApi({ conversationAccess = true, enqueue } = {}) {
  const hooks = [];
  const enqueued = [];
  const logs = [];
  return {
    hooks,
    enqueued,
    logs,
    id: PLUGIN_ID,
    logger: {
      info: (m) => logs.push(String(m)),
      warn: (m) => logs.push(String(m)),
    },
    on: (name, fn) => hooks.push({ name, fn }),
    config: {
      plugins: {
        entries: {
          [PLUGIN_ID]: { hooks: { allowConversationAccess: conversationAccess } },
        },
      },
    },
    session: {
      workflow: {
        enqueueNextTurnInjection: enqueue ?? (async (injection) => {
          enqueued.push(injection);
          return { enqueued: true, id: "i1", sessionKey: injection.sessionKey };
        }),
      },
    },
  };
}

// NO KEY BY DEFAULT, and that is not incidental. `register()` in production
// mode asks the control plane for the capture verdict when a key is
// configured, so a fixture carrying one would have every mode-split test
// firing a live request at the real control plane. The verdict path is
// exercised directly, with an injected transport, in its own suite below.
const ENV = (mode, { key = null } = {}) => ({
  PERCEPTEYE_AGENT_MODE: mode,
  ...(key ? { PERCEPTEYE_API_KEY: key } : {}),
  PERCEPTEYE_TRAJECTORY_DIR: "",
});

describe("the mode split is structural", () => {
  it("registers NO rollout hook in production mode", () => {
    const api = fakeApi();
    register(api, {}, ENV("production"));
    const names = api.hooks.map((h) => h.name);
    for (const hook of ROLLOUT_HOOKS) {
      assert.ok(
        !names.includes(hook),
        `production mode subscribed '${hook}'. Claiming no work must be the ` +
        `ABSENCE of the subscription, not a branch inside the handler.`,
      );
    }
  });

  it("does not REACH the rollout driver in production mode", () => {
    // THE ASSERTION ABOVE IS NOT ENOUGH ON ITS OWN, and a mutation proved it:
    // deleting the structural split entirely -- calling registerRolloutDriver
    // unconditionally -- left every "no hook was registered" assertion GREEN,
    // because `driveVerdict` then declined on the same mode and registered
    // nothing anyway. The test passed for a reason that had nothing to do with
    // the property it claimed to protect.
    //
    // So this asserts WHICH BRANCH RAN, which is the structural claim itself.
    // The line below is emitted only by the production path; under a deleted
    // split it is absent even though the hook list still looks right.
    //
    // The marker used to be the phrase "observe-only", and it moved when
    // production mode stopped being observe-only: it now applies the approved
    // system prompt. What the branch still guarantees -- and what this asserts
    // -- is the half that did not change: no rollout is claimed and no turn is
    // started. A marker kept for its familiarity would have gone on passing
    // while naming a promise the package no longer makes.
    const api = fakeApi();
    register(api, {}, ENV("production"));
    assert.ok(
      api.logs.some((l) => l.includes("claims no rollout and starts no turn")),
      "production mode did not take its own path; the mode split " +
      "has been replaced by a runtime check inside the driver, which is a " +
      "promise a later edit can silently invert",
    );
  });

  it("still records tool outcomes in production mode", () => {
    // Claiming no rollouts is not the same as doing nothing. The recorder is
    // the whole point of a production install.
    const api = fakeApi();
    const out = register(api, {}, ENV("production"));
    assert.equal(api.hooks.map((h) => h.name).includes("after_tool_call"), true);
    assert.equal(out.mode, "production");
    assert.equal(out.rollouts, null);
  });

  it("registers the rollout hooks in training mode", () => {
    const api = fakeApi();
    const out = register(api, {}, ENV("training", { key: "pefw_test" }));
    const names = api.hooks.map((h) => h.name);
    for (const hook of ROLLOUT_HOOKS) {
      assert.ok(names.includes(hook), `training mode did not subscribe '${hook}'`);
    }
    assert.notEqual(out.rollouts, null);
  });

  it("degrades an UNREADABLE mode to production, never to training", () => {
    // A typo is somebody trying to stop contributing. Defaulting to training
    // would resume claiming rollouts on their credentials.
    const api = fakeApi();
    const out = register(api, {}, ENV("prodction"));
    assert.equal(out.mode, "production");
    const names = api.hooks.map((h) => h.name);
    for (const hook of ROLLOUT_HOOKS) assert.ok(!names.includes(hook));
    // ...and the recorder survives the bad setting.
    assert.ok(names.includes("after_tool_call"));
  });
});

describe("driveVerdict names ONE cause", () => {
  // THE canonical answer to "may this install claim work", and the only one.
  // A `rolloutsPermitted(config)` helper in mode.js briefly asked mode and key
  // but not conversation access -- half the predicate, exported, tested, and
  // called by nothing. Two answers to one question is how a client comes to
  // believe it may claim work it cannot report.
  const api = fakeApi();

  it("refuses in production mode", () => {
    const v = driveVerdict({ mode: "production", apiKey: "k" }, api, PLUGIN_ID);
    assert.equal(v.canDrive, false);
    assert.match(v.reason, /claims no rollouts/);
  });

  it("refuses with no key, and says which setting", () => {
    const v = driveVerdict({ mode: "training", apiKey: null }, api, PLUGIN_ID);
    assert.equal(v.canDrive, false);
    assert.match(v.reason, /PERCEPTEYE_API_KEY/);
  });

  it("refuses without conversation access, naming the exact host setting", () => {
    // The answer arrives on `agent_end`, which this host DROPS for a
    // non-bundled plugin without the opt-in. Claiming work we cannot report
    // holds a lease until it lapses.
    const blocked = fakeApi({ conversationAccess: false });
    const v = driveVerdict({ mode: "training", apiKey: "k" }, blocked, PLUGIN_ID);
    assert.equal(v.canDrive, false);
    assert.match(v.reason, /allowConversationAccess=true/);
  });

  it("permits when all three hold", () => {
    const v = driveVerdict({ mode: "training", apiKey: "k" }, api, PLUGIN_ID);
    assert.equal(v.canDrive, true);
    assert.equal(v.reason, null);
  });

  it("reads the host's own predicate: absent is NOT granted", () => {
    assert.equal(conversationAccessGranted({ config: {} }, PLUGIN_ID), false);
    assert.equal(
      conversationAccessGranted(
        { config: { plugins: { entries: { [PLUGIN_ID]: { hooks: {} } } } } },
        PLUGIN_ID), false);
  });
});

describe("training worker registration gates every claim", () => {
  function registrationHarness({
    fail = false,
    executionIdentity = null,
    servedContracts = ["flywheel/1"],
    config = {},
    declaration = null,
  } = {}) {
    const order = [];
    const registrations = [];
    const api = fakeApi();
    const transport = {
      async health() {
        order.push("health");
        return { contract_versions_supported: servedContracts };
      },
      async register(spec) {
        order.push("register");
        registrations.push(spec);
        if (fail) throw new Error("registration refused");
        return { accepted: true };
      },
      async claim() {
        order.push("claim");
        return { rollouts: [] };
      },
      async report() {},
      async abandon() {},
      async heartbeat() {},
    };
    const driver = registerRolloutDriver(api, {
      config: { mode: "training", apiKey: "key", agentId: "support", ...config },
      transport,
      pluginId: PLUGIN_ID,
      logger: api.logger,
      executionIdentity,
      declaration,
    });
    return { api, driver, order, registrations };
  }

  const STARTUP = () => ({
    registrationFingerprint: Object.freeze({ execution_sha256: "a".repeat(64) }),
    registrationDescription: Object.freeze({
      agent_name: "support", framework: "openclaw", source_type: "sdk_runtime",
      role: "standalone", tool_definitions: null, system_prompt: "observed",
      incomplete: ["tool_definitions"],
    }),
  });

  it("omits the description AND its digest when introspection is refused", async () => {
    // Python's serve() under PERCEPTEYE_INTROSPECT=0: the key absent is the
    // customer's opt-out, and the digest is derived from what they refused.
    const h = registrationHarness({
      config: { introspect: false }, executionIdentity: STARTUP(),
    });
    await h.driver.onSessionStart({ sessionKey: "refused" });
    assert.equal("discovered_agent" in h.registrations[0], false);
    assert.equal("agent_execution_sha256" in h.registrations[0], false);
  });

  it("merges a declaration over the startup observation, anchoring no digest", async () => {
    const h = registrationHarness({
      executionIdentity: withholdFingerprints(STARTUP()),
      declaration: resolveDeclaration({ tools: [{ name: "refund" }] }),
    });
    await h.driver.onSessionStart({ sessionKey: "declared" });
    const spec = h.registrations[0];
    assert.deepEqual(spec.discovered_agent, {
      agent_name: "support", framework: "openclaw", source_type: "sdk_declared",
      role: "standalone", system_prompt: "observed",
      tool_definitions: [{ name: "refund", description: "", input_schema: {},
                           original_format: "anthropic_tool" }],
    });
    assert.equal("agent_execution_sha256" in spec, false);
  });

  it("registers the rollout worker before its first attended claim", async () => {
    const h = registrationHarness();
    assert.deepEqual(h.order, ["health"], "startup begins without a session");
    await h.driver.onSessionStart({ sessionKey: "s1" });
    assert.deepEqual(h.order, ["health", "register", "claim"]);
    assert.equal(h.registrations.length, 1);
    assert.deepEqual(h.registrations[0], {
      agent_id: "support",
      mode: "rollout",
      sdk: SDK_UA,
      contract_version: "flywheel/1",
      reports_tool_calls: true,
      isolation: "inprocess",
      concurrency: 1,
      input_shape: "text",
      entrypoint: "openclaw-plugin",
      discovered_agent: null,
    });
  });

  it("binds registration to the exact startup evidence before claiming", async () => {
    const execution = "a".repeat(64);
    const description = Object.freeze({
      agent_name: "support",
      framework: "openclaw",
      tool_definitions: [],
    });
    const h = registrationHarness({
      executionIdentity: {
        registrationFingerprint: Object.freeze({
          execution_sha256: execution,
        }),
        registrationDescription: description,
      },
    });

    await h.driver.onSessionStart({ sessionKey: "bound" });
    assert.deepEqual(h.order, ["health", "register", "claim"]);
    assert.equal(h.registrations[0].agent_execution_sha256, execution);
    assert.equal(h.registrations[0].discovered_agent, description);
  });

  it("never claims when registration is refused, and attempts it once", async () => {
    const h = registrationHarness({ fail: true });
    assert.equal(await h.driver.onSessionStart({ sessionKey: "s1" }), null);
    assert.equal(await h.driver.onSessionStart({ sessionKey: "s2" }), null);
    assert.deepEqual(h.order, ["health", "register"]);
    assert.equal(h.registrations.length, 1);
    assert.equal(
      h.api.logs.filter((line) => line.includes("registration failed")).length,
      1,
    );
  });

  it("refuses an incompatible control plane before registration or claim", async () => {
    const h = registrationHarness({ servedContracts: ["flywheel/0"] });
    assert.equal(await h.driver.ensureRegistered(), false);
    assert.equal(await h.driver.onSessionStart({ sessionKey: "s1" }), null);
    assert.deepEqual(h.order, ["health"]);
    assert.equal(h.registrations.length, 0);
    assert.equal(
      h.api.logs.filter((line) => line.includes("control plane speaks")).length,
      1,
    );
  });

  it("uses the same registration gate for unattended claims", async () => {
    const h = registrationHarness();
    await h.driver.unattended.tick();
    assert.deepEqual(h.order, ["health", "register", "claim"]);
  });
});

/** A transport that records calls instead of making them. */
function fakeTransport(overrides = {}) {
  const calls = { claim: [], report: [], abandon: [] };
  return {
    calls,
    claim: overrides.claim ?? (async (n) => {
      calls.claim.push(n);
      return { rollouts: [{ rolloutId: "r1", turnInput: "do the thing", leaseToken: "lt" }] };
    }),
    report: overrides.report ?? (async (r, o) => { calls.report.push([r, o]); }),
    abandon: overrides.abandon ?? (async (r, o) => { calls.abandon.push([r, o]); }),
  };
}

describe("the claim / deliver / report loop", () => {
  it("delivers the claimed task into the next turn", async () => {
    const enqueued = [];
    const tx = fakeTransport();
    const d = createRolloutDriver({
      transport: tx,
      enqueue: async (i) => { enqueued.push(i); return { enqueued: true, id: "i" }; },
    });
    const r = await d.onSessionStart({ sessionKey: "s1" });
    assert.equal(r.rolloutId, "r1");
    assert.equal(enqueued.length, 1);
    assert.match(enqueued[0].text, /do the thing/);
    assert.equal(enqueued[0].sessionKey, "s1");
    // Deduped on the ROLLOUT, so a re-claim of the same work cannot deliver
    // the task twice into one session.
    assert.equal(enqueued[0].idempotencyKey, "percepteye-rollout-r1");
  });

  it("GIVES THE ROLLOUT BACK when the host declines to queue the task", async () => {
    // The agent will never see it. Holding the lease until it lapses makes the
    // queue look busy while nothing runs.
    const tx = fakeTransport();
    const d = createRolloutDriver({
      transport: tx,
      enqueue: async () => ({ enqueued: false, id: "", sessionKey: "s1" }),
    });
    assert.equal(await d.onSessionStart({ sessionKey: "s1" }), null);
    assert.equal(tx.calls.abandon.length, 1);
    assert.equal(tx.calls.abandon[0][1].reason, "entrypoint_error");
    assert.equal(tx.calls.report.length, 0);
    assert.equal(d.inFlight.size, 0);
  });

  it("refuses a task larger than the host's injection ceiling", async () => {
    // Over the ceiling the host returns `enqueued:false` with no reason, so
    // the size is checked here and named as the cause.
    const tx = fakeTransport({
      claim: async () => ({
        rollouts: [{ rolloutId: "big", turnInput: "x".repeat(MAX_INJECTION_BYTES + 1), leaseToken: "lt" }],
      }),
    });
    let sent = 0;
    const d = createRolloutDriver({
      transport: tx,
      enqueue: async () => { sent += 1; return { enqueued: true }; },
    });
    assert.equal(await d.onSessionStart({ sessionKey: "s1" }), null);
    assert.equal(sent, 0, "an oversized task must not be sent at all");
    assert.match(tx.calls.abandon[0][1].detail, /caps a next-turn injection/);
  });

  it("reports the answer when the agent finishes", async () => {
    const tx = fakeTransport();
    const d = createRolloutDriver({ transport: tx, enqueue: async () => ({ enqueued: true }) });
    await d.onSessionStart({ sessionKey: "s1" });
    await d.onAgentEnd(
      { success: true, messages: [{ role: "assistant", content: "the answer" }] },
      { sessionKey: "s1" },
    );
    assert.equal(tx.calls.report.length, 1);
    assert.equal(tx.calls.report[0][1].finalText, "the answer");
    assert.equal(tx.calls.abandon.length, 0);
  });

  it("REPORTS a failed run rather than abandoning it", async () => {
    // The agent ran and failed. That is a real attempt and exactly what
    // training must see -- the opposite handling from a substrate fault.
    const tx = fakeTransport();
    const d = createRolloutDriver({ transport: tx, enqueue: async () => ({ enqueued: true }) });
    await d.onSessionStart({ sessionKey: "s1" });
    await d.onAgentEnd(
      { success: false, messages: [{ role: "assistant", content: "I could not" }] },
      { sessionKey: "s1" },
    );
    assert.equal(tx.calls.report.length, 1);
    assert.equal(tx.calls.abandon.length, 0);
    // `success` is not asserted true on a failed run, and never `[]` for calls.
    assert.equal(tx.calls.report[0][1].success, undefined);
  });

  it("gives back a rollout whose session ended with no answer", async () => {
    const tx = fakeTransport();
    const d = createRolloutDriver({ transport: tx, enqueue: async () => ({ enqueued: true }) });
    await d.onSessionStart({ sessionKey: "s1" });
    await d.onSessionEnd({ sessionKey: "s1", reason: "shutdown" });
    assert.equal(tx.calls.report.length, 0, "an answerless rollout must not be reported");
    assert.equal(tx.calls.abandon[0][1].reason, "entrypoint_error");
  });

  it("gives it back with a REQUEUING reason, never 'cancelled'", async () => {
    // `cancelled` is the one reason Mission Control never requeues:
    // `RolloutRepository.abandon` computes
    // `requeue = attempt < max_attempts and reason != "cancelled"`, so it
    // retires the rollout ABANDONED with its remaining attempts unused. This
    // path used to send exactly that, and the ordinary case for it is not a
    // cancellation at all -- an operator opens a session, the task is queued
    // for the NEXT turn, and they close it without ever taking one. Nothing
    // ran, so the work is worth handing back.
    const tx = fakeTransport();
    const d = createRolloutDriver({ transport: tx, enqueue: async () => ({ enqueued: true }) });
    await d.onSessionStart({ sessionKey: "s1" });
    await d.onSessionEnd({ sessionKey: "s1", reason: "shutdown" });
    assert.notEqual(
      tx.calls.abandon[0][1].reason, "cancelled",
      "'cancelled' is terminal in Mission Control; a session that simply " +
      "ended must leave the rollout requeueable",
    );
    assert.match(tx.calls.abandon[0][1].detail, /before the agent answered/);
    assert.equal(d.inFlight.size, 0);
  });

  it("does not claim twice for one session", async () => {
    const tx = fakeTransport();
    const d = createRolloutDriver({ transport: tx, enqueue: async () => ({ enqueued: true }) });
    await d.onSessionStart({ sessionKey: "s1" });
    await d.onSessionStart({ sessionKey: "s1" });
    assert.equal(tx.calls.claim.length, 1);
  });

  it("lets the agent run normally when the control plane is unreachable", async () => {
    const tx = fakeTransport({ claim: async () => { throw new Error("down"); } });
    const d = createRolloutDriver({ transport: tx, enqueue: async () => ({ enqueued: true }) });
    assert.equal(await d.onSessionStart({ sessionKey: "s1" }), null);
    assert.equal(d.inFlight.size, 0);
  });

  it("does nothing at all when there is no work", async () => {
    const tx = fakeTransport({ claim: async () => ({ rollouts: [] }) });
    let sent = 0;
    const d = createRolloutDriver({
      transport: tx, enqueue: async () => { sent += 1; return { enqueued: true }; },
    });
    assert.equal(await d.onSessionStart({ sessionKey: "s1" }), null);
    assert.equal(sent, 0);
    assert.equal(tx.calls.abandon.length, 0);
  });

  it("ignores an agent_end for a session it never claimed for", async () => {
    const tx = fakeTransport();
    const d = createRolloutDriver({ transport: tx, enqueue: async () => ({ enqueued: true }) });
    await d.onAgentEnd({ success: true, messages: [] }, { sessionKey: "other" });
    assert.equal(tx.calls.report.length, 0);
  });

  it("renews the granted lease at a fixed cadence until reporting finishes", async () => {
    const scheduled = [];
    const beats = [];
    let finishReport;
    const reportGate = new Promise((resolve) => { finishReport = resolve; });
    const tx = {
      leaseMs: 30_000,
      async claim() {
        return { rollouts: [{
          rolloutId: "r-heartbeat", turnInput: "work", leaseToken: "lease-1",
          leaseExpiresTs: 109,
        }] };
      },
      async heartbeat(rollout) { beats.push(rollout.rolloutId); },
      async report() { await reportGate; },
      async abandon() {},
    };
    const d = createRolloutDriver({
      transport: tx,
      enqueue: async () => ({ enqueued: true }),
      now: () => 100_000,
      heartbeatScheduler: (callback, delayMs) => {
        const token = { callback, delayMs, cancelled: false };
        scheduled.push(token);
        return token;
      },
      heartbeatCanceller: (token) => { token.cancelled = true; },
    });
    await d.onSessionStart({ sessionKey: "s1" });
    assert.equal(scheduled[0].delayMs, 3_000);
    await scheduled[0].callback();
    assert.deepEqual(beats, ["r-heartbeat"]);
    assert.equal(scheduled[1].delayMs, 3_000,
      "an absolute lease clock was incorrectly recomputed after each beat");

    const reporting = d.onAgentEnd(
      { success: true, messages: [{ role: "assistant", content: "done" }] },
      { sessionKey: "s1" },
    );
    await Promise.resolve();
    assert.equal(d.heartbeats.size, 1, "renewal stopped before the result POST finished");
    finishReport();
    await reporting;
    assert.equal(d.heartbeats.size, 0);
    assert.equal(scheduled[1].cancelled, true);
  });

  it("does not treat a heartbeat racing a terminal report as revocation", async () => {
    const scheduled = [];
    let finishReport;
    const reportGate = new Promise((resolve) => { finishReport = resolve; });
    const d = createRolloutDriver({
      transport: {
        leaseMs: 3_000,
        async claim() {
          return { rollouts: [{
            rolloutId: "r-report-race", turnInput: "work", leaseToken: "lease",
          }] };
        },
        async heartbeat() { throw new LeaseLost("result already closed lease"); },
        async report() { await reportGate; },
        async abandon() {},
      },
      enqueue: async () => ({ enqueued: true }),
      heartbeatScheduler: (callback) => {
        scheduled.push({ callback });
        return scheduled.at(-1);
      },
      heartbeatCanceller() {},
    });
    await d.onSessionStart({ sessionKey: "s1" });
    d.onBeforeAgentRun({}, { sessionKey: "s1", runId: "host-run-1" });
    const result = d.onAgentEnd(
      { success: true, messages: [{ role: "assistant", content: "done" }] },
      { sessionKey: "s1", runId: "host-run-1" },
    );
    await Promise.resolve();
    await scheduled[0].callback();
    assert.equal(d.blockNextRun.has("s1"), false);
    assert.equal(d.revokedRuns.has("s1"), false);
    assert.equal(d.reporting.has("s1"), true);
    assert.equal(d.onBeforeAgentRun({}, { sessionKey: "s1", runId: "next" }), undefined);
    finishReport();
    await result;
    assert.equal(d.reporting.has("s1"), false);
  });

  it("paces a long initial grant against the ten-minute renewal ceiling", async () => {
    const scheduled = [];
    const d = createRolloutDriver({
      transport: {
        leaseMs: 1_800_000,
        async claim() {
          return { rollouts: [{
            rolloutId: "r-long", turnInput: "work", leaseToken: "lease",
            leaseExpiresTs: 1_900,
          }] };
        },
        async heartbeat() {}, async report() {}, async abandon() {},
      },
      enqueue: async () => ({ enqueued: true }),
      now: () => 100_000,
      heartbeatScheduler: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return scheduled.at(-1);
      },
      heartbeatCanceller() {},
    });
    await d.onSessionStart({ sessionKey: "s1" });
    assert.equal(scheduled[0].delayMs, 200_000);
  });

  it("drops a result when the server says its lease was already lost", async () => {
    const scheduled = [];
    const cancelled = [];
    let reports = 0;
    const tx = {
      leaseMs: 3_000,
      async claim() {
        return { rollouts: [{
          rolloutId: "r-lost", turnInput: "work", leaseToken: "lease-1",
        }] };
      },
      async heartbeat() { throw new LeaseLost("requeued"); },
      async report() { reports += 1; },
      async abandon() {},
    };
    const d = createRolloutDriver({
      transport: tx,
      enqueue: async () => ({ enqueued: true }),
      cancel: async (request) => { cancelled.push(request); return true; },
      heartbeatScheduler: (callback) => {
        const token = { callback };
        scheduled.push(token);
        return token;
      },
      heartbeatCanceller() {},
    });
    await d.onSessionStart({ sessionKey: "s1" });
    d.onBeforeAgentRun({}, { sessionKey: "s1", runId: "host-run-1" });
    await scheduled[0].callback();
    assert.equal(d.inFlight.size, 0);
    assert.equal(d.heartbeats.size, 0);
    await d.onAgentEnd(
      { success: true, messages: [{ role: "assistant", content: "too late" }] },
      { sessionKey: "s1" },
    );
    assert.equal(reports, 0);
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0].sessionKey, "s1");
    assert.equal(cancelled[0].runId, "host-run-1");
  });

  it("fences later tool side effects when the host cannot abort an active run", async () => {
    const scheduled = [];
    const d = createRolloutDriver({
      transport: {
        leaseMs: 3_000,
        async claim() {
          return { rollouts: [{
            rolloutId: "r-active", turnInput: "work", leaseToken: "lease",
          }] };
        },
        async heartbeat() { throw new LeaseLost("requeued"); },
        async report() {}, async abandon() {},
      },
      enqueue: async () => ({ enqueued: true }),
      heartbeatScheduler: (callback) => {
        scheduled.push({ callback });
        return scheduled.at(-1);
      },
      heartbeatCanceller() {},
    });
    await d.onSessionStart({ sessionKey: "s1" });
    d.onBeforeAgentRun({}, { sessionKey: "s1", runId: "host-run-1" });
    await scheduled[0].callback();
    assert.equal(
      d.onBeforeToolCall(
        { runId: "host-run-1", toolName: "write" },
        { sessionKey: "s1", runId: "host-run-1" },
      ).block,
      true,
    );
    assert.equal(
      d.onBeforeToolCall(
        { runId: "other-run", toolName: "read" },
        { sessionKey: "s1", runId: "other-run" },
      ),
      undefined,
    );
    await d.onAgentEnd(
      { runId: "host-run-1", success: false, messages: [] },
      { sessionKey: "s1" },
    );
    assert.equal(d.revokedRuns.size, 0);
  });

  it("blocks and drains an injected turn whose lease was lost before it ran", async () => {
    const scheduled = [];
    const d = createRolloutDriver({
      transport: {
        leaseMs: 3_000,
        async claim() {
          return { rollouts: [{
            rolloutId: "r-queued", turnInput: "work", leaseToken: "lease",
          }] };
        },
        async heartbeat() { throw new LeaseLost("requeued"); },
        async report() {}, async abandon() {},
      },
      enqueue: async () => ({ enqueued: true }),
      cancel: async () => false,
      heartbeatScheduler: (callback) => {
        scheduled.push({ callback });
        return scheduled.at(-1);
      },
      heartbeatCanceller() {},
    });
    await d.onSessionStart({ sessionKey: "s1" });
    await scheduled[0].callback();
    assert.equal(d.blockNextRun.has("s1"), true);
    const decision = d.onBeforeAgentRun({}, { sessionKey: "s1", runId: "late" });
    assert.equal(decision.outcome, "block");
    assert.equal(d.blockNextRun.has("s1"), false);
  });
});

describe("reading the agent's answer", () => {
  it("takes the LAST assistant message", () => {
    assert.equal(lastAssistantText([
      { role: "assistant", content: "first" },
      { role: "user", content: "then" },
      { role: "assistant", content: "last" },
    ]), "last");
  });

  it("joins structured content parts", () => {
    assert.equal(
      lastAssistantText([{ role: "assistant", content: [{ text: "a" }, { text: "b" }] }]),
      "ab");
  });

  it("returns empty rather than inventing an answer", () => {
    assert.equal(lastAssistantText(null), "");
    assert.equal(lastAssistantText([{ role: "user", content: "hi" }]), "");
  });
});

describe("the task the agent reads", () => {
  it("carries the rollout id and the task", () => {
    const t = taskText({ rolloutId: "r9", turnInput: "summarise the log" });
    assert.match(t, /r9/);
    assert.match(t, /summarise the log/);
  });
});

describe("two events for one session claim once", () => {
  it("does not claim twice while the first claim is still in flight", async () => {
    // The `inFlight` guard alone was checked BEFORE the claim's await, so two
    // concurrent session_start events both passed it and leased two rollouts
    // for one session -- only one of which could ever be delivered, the other
    // left to lapse.
    let release;
    const gate = new Promise((r) => { release = r; });
    const tx = fakeTransport({
      claim: async () => {
        await gate;
        return { rollouts: [{ rolloutId: "r1", turnInput: "t", leaseToken: "lt" }] };
      },
    });
    let claims = 0;
    const counting = { ...tx, claim: async (n) => { claims += 1; return tx.claim(n); } };
    const d = createRolloutDriver({
      transport: counting, enqueue: async () => ({ enqueued: true }),
    });
    const a = d.onSessionStart({ sessionKey: "s1" });
    const b = d.onSessionStart({ sessionKey: "s1" });
    release();
    await Promise.all([a, b]);
    assert.equal(claims, 1, "one session must lease at most one rollout");
  });

  it("frees the reservation so a later session can claim again", async () => {
    // The reservation must not become a permanent lockout: a session that was
    // offered no work has to be able to ask again on its next start.
    let claims = 0;
    const tx = fakeTransport({
      claim: async () => { claims += 1; return { rollouts: [] }; },
    });
    const d = createRolloutDriver({ transport: tx, enqueue: async () => ({ enqueued: true }) });
    await d.onSessionStart({ sessionKey: "s1" });
    await d.onSessionStart({ sessionKey: "s1" });
    assert.equal(claims, 2, "a session that got no work must be able to ask again");
  });
});
