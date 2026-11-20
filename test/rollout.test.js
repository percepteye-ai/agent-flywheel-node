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
import { testEnv } from "./support/home.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { register, PLUGIN_ID } from "../src/index.js";
import { resolveDeclaration } from "../src/declaration.js";
import { LeaseLost, TransportError } from "../src/errors.js";
import { withholdFingerprints } from "../src/execution-identity.js";
import { SDK_UA } from "../src/http.js";
import {
  MAX_INJECTION_BYTES, REGISTRATION_RETRY_BASE_MS, REGISTRATION_RETRY_MAX_MS,
  conversationAccessGranted, createRolloutDriver,
  driveVerdict, lastAssistantText, registerRolloutDriver, taskText,
} from "../src/rollout.js";
import { OUTCOME_FILENAME, TRAJECTORY_DIR_ENV } from "../src/trajectory.js";
import { rolloutOutputToWire } from "../src/wire.js";

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
function fakeApi({ conversationAccess = true, enqueue, providerSurface = true } = {}) {
  const hooks = [];
  const enqueued = [];
  const logs = [];
  const providers = [];
  return {
    hooks,
    enqueued,
    logs,
    providers,
    /** What the host's hook dispatcher would get back from `name`. */
    hook: (name) => hooks.find((h) => h.name === name)?.fn,
    ...(providerSurface ? { registerProvider: (p) => providers.push(p) } : {}),
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
// A home of its own each time: training mode holds results under it and
// production mode captures turns under it.
const ENV = (mode, { key = null } = {}) => testEnv({
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

  it("tells application code which episode a host session is running", () => {
    // The Python SDK's `current_rollout_id()`. Without it the README's
    // `reportOutcome("resolved", { episodeId })` could not be written: the id
    // reached nothing but the task text the agent reads.
    const api = fakeApi();
    const out = register(api, {}, ENV("training", { key: "pefw_test" }));
    assert.equal(out.currentRolloutId({ sessionKey: "s1" }), null);
    out.rollouts.track("s1", { rolloutId: "rl_mc_41" });
    try {
      assert.equal(out.currentRolloutId({ sessionKey: "s1" }), "rl_mc_41");
      // The host names a session either way; both are one session here.
      assert.equal(out.currentRolloutId({ sessionId: "s1" }), "rl_mc_41");
      // Another session of the same install runs no rollout.
      assert.equal(out.currentRolloutId({ sessionKey: "s2" }), null);
      assert.equal(out.currentRolloutId(undefined), null);
    } finally {
      out.rollouts.inFlight.delete("s1");
    }
    assert.equal(out.currentRolloutId({ sessionKey: "s1" }), null);
  });

  it("has no episode to name in production mode", () => {
    const out = register(fakeApi(), {}, ENV("production"));
    assert.equal(out.currentRolloutId({ sessionKey: "s1" }), null);
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

  it("does not blame the mode, or fail the load, over an invalid agentId", () => {
    // The fallback used to assume every ConfigurationError was the mode's
    // and retry unguarded: an invalid agentId threw again out of register()
    // -- a failed plugin load -- having been about to say "not a mode".
    for (const env of [ENV("training"), ENV("prodction")]) {
      const api = fakeApi();
      const out = register(api, { agentId: "../escape" }, env);
      assert.equal(out, null);
      assert.equal(api.hooks.length, 0, "nothing is registered under a name nobody gave");
      const said = api.logs.join("\n");
      assert.match(said, /agentId must be a non-empty, control-free identifier/);
      assert.doesNotMatch(said, /Running in production mode/);
    }
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
    failures = [],
    clock = null,
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
        if (failures.length) throw failures.shift();
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
      env: testEnv(),
      config: { mode: "training", apiKey: "key", agentId: "support", ...config },
      transport,
      pluginId: PLUGIN_ID,
      logger: api.logger,
      executionIdentity,
      declaration,
      ...(clock ? { now: clock.now, random: () => 1 } : {}),
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

  it("sends a declared api_spec and keeps the observed digest", async () => {
    // A spec alone is no description: it withholds no identity, and the
    // observed description registers as observed.
    const h = registrationHarness({
      executionIdentity: STARTUP(),
      declaration: resolveDeclaration({ api_spec: "https://x.example/spec" }),
    });
    await h.driver.onSessionStart({ sessionKey: "spec" });
    const spec = h.registrations[0];
    assert.equal(spec.api_spec, "https://x.example/spec");
    assert.equal(spec.discovered_agent.source_type, "sdk_runtime");
    assert.equal(spec.agent_execution_sha256, "a".repeat(64));
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

  it("retries a TRANSIENT registration failure after a backoff, then claims", async () => {
    // ND-H8: a control plane that was down at boot disabled rollouts for the
    // life of the process.
    let t = 1_000_000;
    const clock = { now: () => t };
    const h = registrationHarness({
      clock,
      failures: [
        new TransportError("POST /agents -> HTTP 503: restarting", { statusCode: 503 }),
        new TransportError("fetch failed"),
      ],
    });
    assert.equal(await h.driver.ensureRegistered(), false);
    // Inside the wait, however many claims arrive, nothing is re-asked.
    assert.equal(await h.driver.onSessionStart({ sessionKey: "s1" }), null);
    assert.equal(h.registrations.length, 1);
    t += REGISTRATION_RETRY_BASE_MS;
    assert.equal(await h.driver.ensureRegistered(), false, "a second transient failure");
    assert.equal(h.registrations.length, 2);
    t += REGISTRATION_RETRY_BASE_MS;
    assert.equal(await h.driver.ensureRegistered(), false, "the wait doubled");
    assert.equal(h.registrations.length, 2);
    t += REGISTRATION_RETRY_BASE_MS;
    assert.equal(await h.driver.ensureRegistered(), true);
    await h.driver.onSessionStart({ sessionKey: "s2" });
    assert.ok(h.order.includes("claim"), "rollouts resume without a restart");
    assert.match(h.api.logs.join("\n"), /rollouts are paused .* retried in 5s/);
  });

  it("does not retry a 4xx refusal", async () => {
    let t = 1_000_000;
    const h = registrationHarness({
      clock: { now: () => t },
      failures: [new TransportError("POST /agents -> HTTP 403: no", { statusCode: 403 })],
    });
    assert.equal(await h.driver.ensureRegistered(), false);
    t += REGISTRATION_RETRY_MAX_MS * 10;
    assert.equal(await h.driver.ensureRegistered(), false);
    assert.equal(h.registrations.length, 1);
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

describe("a rollout samples through ITS OWN gateway (the checkpoint being trained)", () => {
  // `rollout.llmUrl` / `rollout.apiKey` were parsed and read nowhere, so every
  // OpenClaw rollout ran on the host's configured model and was scored as the
  // checkpoint's. Driven end to end through what the host calls: the
  // `before_model_resolve` hook, then the registered provider's transport
  // and credential seams.
  function routedHarness(api = fakeApi()) {
    const transport = {
      async health() { return { contract_versions_supported: ["flywheel/1"] }; },
      async register() { return { accepted: true }; },
      async claim() {
        return { rollouts: [{
          rolloutId: "r7", turnInput: "do it", llmUrl: "https://cp.example/llm/v1/o/org/rollouts/r7",
          apiKey: "rk_r7", deadlineTs: Date.now() / 1000 + 3600,
        }] };
      },
      async report() {}, async abandon() {}, async heartbeat() {},
    };
    const driver = registerRolloutDriver(api, {
      env: testEnv(), config: { mode: "training", apiKey: "key", agentId: "support" },
      transport, pluginId: PLUGIN_ID, logger: api.logger,
    });
    return { api, driver };
  }
  const OURS = { provider: "percepteye-flywheel" };

  it("routes a rollout session's model calls to rollout.llmUrl with the rollout's key, and reverts when it ends", async () => {
    const { api, driver } = routedHarness();
    assert.equal(api.providers.length, 1, "the provider is registered before any claim");
    const provider = api.providers[0];
    const resolve = api.hook("before_model_resolve");
    assert.ok(resolve, "before_model_resolve is subscribed in training mode");

    await driver.onSessionStart({ sessionKey: "s1" });
    assert.deepEqual(resolve({ prompt: "hi" }, { sessionKey: "s1" }), {
      providerOverride: "percepteye-flywheel", modelOverride: "policy",
    });
    assert.deepEqual(provider.normalizeTransport(OURS), {
      api: "openai-completions", baseUrl: "https://cp.example/llm/v1/o/org/rollouts/r7",
    });
    assert.equal(provider.resolveSyntheticAuth(OURS).apiKey, "rk_r7");
    // Somebody else's provider and a session with no rollout are never ours.
    assert.equal(provider.normalizeTransport({ provider: "openai" }), undefined);
    assert.equal(provider.resolveSyntheticAuth({ provider: "openai" }), undefined);
    assert.equal(resolve({ prompt: "hi" }, { sessionKey: "a-person" }), undefined);

    await driver.onAgentEnd(
      { success: true, messages: [{ role: "assistant", content: "done" }] },
      { sessionKey: "s1" },
    );
    assert.equal(resolve({ prompt: "hi" }, { sessionKey: "s1" }), undefined,
      "the session's next turn runs on the host's own model");
    assert.equal(provider.normalizeTransport(OURS), undefined);
    assert.equal(provider.resolveSyntheticAuth(OURS), undefined);
  });

  it("claims nothing on a host that cannot register the provider, and says why", async () => {
    const api = fakeApi({ providerSurface: false });
    const { driver } = routedHarness(api);
    assert.equal(driver, null);
    assert.ok(!api.hooks.some((h) => h.name === "session_start"));
    assert.match(api.logs.join("\n"), /not claiming rollouts: .*api\.registerProvider is missing/);
  });
});

describe("a rollout reports the tool calls its session made (reports_tool_calls: true)", () => {
  // Registration declares reports_tool_calls: true, which stops the control
  // plane refusing the worker for reporting none -- and onAgentEnd sent none.
  // Driven through register(): the host's after_tool_call hook, the real
  // recorder and writer, the driver's report, and the request on the wire.
  async function throughRegister(drive) {
    const realFetch = globalThis.fetch;
    const posted = [];
    globalThis.fetch = async (url, init) => {
      const path = new URL(url).pathname;
      if (init?.method === "POST") {
        posted.push({ path, body: init.body ? JSON.parse(init.body) : null });
      }
      const body = path.endsWith("/health")
        ? { contract_versions_supported: ["flywheel/1"] } : {};
      return new Response(JSON.stringify(body), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    try {
      const api = fakeApi();
      const env = testEnv({
        PERCEPTEYE_AGENT_MODE: "training", PERCEPTEYE_API_KEY: "pefw_test",
        PERCEPTEYE_CONTROL_PLANE_URL: "http://cp.test/api/flywheel/v1",
      });
      const out = register(api, {}, env);
      await drive(api, out, env);
      return posted;
    } finally {
      globalThis.fetch = realFetch;
    }
  }
  const end = (out) => out.rollouts.onAgentEnd(
    { success: true, messages: [{ role: "assistant", content: "done" }] },
    { sessionKey: "s1" },
  );

  it("sends the calls observed in the rollout's session, and only those", async () => {
    let dir = null;
    const posted = await throughRegister(async (api, out) => {
      const rollout = { rolloutId: "r42", turnInput: "x", llmUrl: "http://cp.test/llm", apiKey: "rk" };
      out.rollouts.track("s1", rollout);
      dir = out.rollouts.trajectoryDirFor({ sessionKey: "s1" });
      const tool = api.hook("after_tool_call");
      tool({ toolName: "read", params: { path: "a" }, result: "ok", toolCallId: "c1" },
        { sessionKey: "s1", runId: "run1" });
      tool({ toolName: "mcp_lookup", params: {}, result: { status: 200 } },
        { sessionKey: "s1", runId: "run1" });
      // A person's own session in the same process is not this rollout's.
      tool({ toolName: "write", params: {}, result: "ok" },
        { sessionKey: "a-person", runId: "run2" });
      await end(out);
    });
    const result = posted.find((p) => p.path.endsWith("/rollouts/r42/result"));
    assert.ok(result, "the result was posted");
    assert.deepEqual(result.body.tool_calls.map((c) => [c.name, c.outcome]),
      [["read", "ok"], ["mcp_lookup", "unknown"]]);
    assert.equal(result.body.tool_calls[0].tool_call_id, "c1");
    assert.equal(result.body.tool_calls_omitted_count, 0);
    assert.equal(existsSync(dir), false, "the trajectory is removed once reported");
  });

  it("sends [] -- observed zero -- for a rollout that made no call", async () => {
    const posted = await throughRegister(async (_api, out) => {
      out.rollouts.track("s1", { rolloutId: "r43", turnInput: "x", llmUrl: "u", apiKey: "k" });
      await end(out);
    });
    const result = posted.find((p) => p.path.endsWith("/rollouts/r43/result"));
    assert.deepEqual(result.body.tool_calls, []);
  });

  it("counts an unreadable line as omitted, never as a complete list", async () => {
    const posted = await throughRegister(async (api, out) => {
      out.rollouts.track("s1", { rolloutId: "r44", turnInput: "x", llmUrl: "u", apiKey: "k" });
      api.hook("after_tool_call")({ toolName: "read", params: {}, result: "ok" },
        { sessionKey: "s1", runId: "run1" });
      const dir = out.rollouts.trajectoryDirFor({ sessionKey: "s1" });
      writeFileSync(join(dir, "tool_calls.jsonl"), "{not json\n", { flag: "a" });
      await end(out);
    });
    const result = posted.find((p) => p.path.endsWith("/rollouts/r44/result"));
    assert.equal(result.body.tool_calls.length, 1);
    assert.equal(result.body.tool_calls_omitted_count, 1);
  });
});

describe("gateway_stop and a host logger that throws (ND-M10)", () => {
  function stopHarness({ logger } = {}) {
    const api = fakeApi();
    if (logger) api.logger = logger;
    const scheduled = [];
    const transport = {
      async health() { return { contract_versions_supported: ["flywheel/1"] }; },
      async register() { return { accepted: true }; },
      async claim() { return { rollouts: [] }; },
      async report() {},
      async abandon() { throw new Error("control plane down"); },
      async heartbeat() {},
    };
    const driver = registerRolloutDriver(api, {
      env: testEnv(), config: { mode: "training", apiKey: "key", agentId: "support" },
      transport, pluginId: PLUGIN_ID, logger: api.logger,
    });
    return { api, driver, scheduled };
  }

  it("gateway_stop stops every lease renewal and deadline timer", async () => {
    const { api, driver } = stopHarness();
    driver.track("s1", {
      rolloutId: "r1", turnInput: "x", leaseToken: "lt",
      deadlineTs: Date.now() / 1000 + 3600,
    });
    driver.track("s2", { rolloutId: "r2", turnInput: "x", leaseToken: "lt2" });
    assert.equal(driver.heartbeats.size, 2);
    const states = [...driver.heartbeats.values()];
    api.hook("gateway_stop")({}, {});
    await new Promise((r) => setImmediate(r));
    assert.equal(driver.heartbeats.size, 0, "a stopping gateway kept renewing leases");
    for (const state of states) assert.equal(state.stopped, true);
  });

  it("a hook failure whose logger also throws is not an unhandled rejection", async () => {
    const throwing = { info() {}, warn() { throw new Error("logger is gone"); } };
    const { api, driver } = stopHarness({ logger: throwing });
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      driver.track("s1", { rolloutId: "r1", turnInput: "x" });
      // session_end gives the rollout back; abandon fails, the driver logs,
      // the logger throws, the hook's own catch logs, and that throws too.
      api.hook("session_end")({ sessionKey: "s1", reason: "closed" }, {});
      for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    assert.deepEqual(unhandled, []);
  });
});

describe("the claim / deliver / report loop", () => {
  it("delivers the claimed task into the next turn", async () => {
    const enqueued = [];
    const tx = fakeTransport();
    const d = createRolloutDriver({
      env: testEnv(),
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
      env: testEnv(),
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
      env: testEnv(),
      transport: tx,
      enqueue: async () => { sent += 1; return { enqueued: true }; },
    });
    assert.equal(await d.onSessionStart({ sessionKey: "s1" }), null);
    assert.equal(sent, 0, "an oversized task must not be sent at all");
    assert.match(tx.calls.abandon[0][1].detail, /caps a next-turn injection/);
  });

  it("reports the answer when the agent finishes", async () => {
    const tx = fakeTransport();
    const d = createRolloutDriver({
      env: testEnv(), transport: tx, enqueue: async () => ({ enqueued: true }),
    });
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
    const d = createRolloutDriver({
      env: testEnv(), transport: tx, enqueue: async () => ({ enqueued: true }),
    });
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

  // THE AGENT'S OWN GRADE. The Python runner reads
  // `$PERCEPTEYE_TRAJECTORY_DIR/outcome.json` for a command agent; this lane
  // had no reader, so an agent driven from here could not be scored by its
  // own environment. Same file, same rules (`wire.js reportedOutcome`).
  async function driven(body, { event = { success: false }, write = "during" } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "percepteye-outcome-"));
    const path = join(dir, OUTCOME_FILENAME);
    const tx = fakeTransport();
    const d = createRolloutDriver({
      env: testEnv({ [TRAJECTORY_DIR_ENV]: dir }), transport: tx,
      enqueue: async () => ({ enqueued: true }),
    });
    const put = () => writeFileSync(
      path, typeof body === "string" ? body : JSON.stringify(body));
    if (write === "before") put();
    await d.onSessionStart({ sessionKey: "s1" });
    if (write === "during") put();
    await d.onAgentEnd(
      { ...event, messages: [{ role: "assistant", content: "done" }] },
      { sessionKey: "s1" },
    );
    assert.equal(tx.calls.report.length, 1);
    return { output: tx.calls.report[0][1], path };
  }

  it("reports the grade the agent's own environment stated", async () => {
    const { output, path } = await driven({
      reward: 0.25, success: true,
      checks: [{ id: "db_state", status: "measured", value: 0 }],
      termination: { class: "nonsense" },
      seeds: { environment: 11 },
    });
    assert.equal(output.reward, 0.25);
    assert.equal(output.success, true);
    assert.deepEqual(output.checks, [{ id: "db_state", status: "measured", value: 0 }]);
    // A malformed part is ignored whole and costs the episode nothing else.
    assert.equal(output.termination, undefined);
    assert.deepEqual(output.seeds, { environment: 11 });
    assert.equal(output.finalText, "done");
    const wire = rolloutOutputToWire(output);
    assert.equal(wire.reward, 0.25);
    assert.deepEqual(wire.seeds, { environment: 11 });
    // Read once: the directory is the process's, not the rollout's, and a
    // file left behind would grade the next episode with this one's reward.
    assert.equal(existsSync(path), false);
  });

  it("does not let the file take back a success the host reported", async () => {
    const { output } = await driven(
      { success: false, reward: 0 }, { event: { success: true } });
    assert.equal(output.success, true);
    assert.equal(output.reward, 0);
  });

  it("ignores a malformed grade and never coerces one", async () => {
    const { output } = await driven({ reward: "1", success: "yes" });
    assert.equal(output.reward, undefined);
    assert.equal(output.success, undefined);
  });

  for (const [what, body] of [
    ["is not JSON", "{not json"], ["is not an object", "[1, 2]"], ["is empty", ""],
  ]) {
    it(`reports the answer when the outcome file ${what}`, async () => {
      const { output, path } = await driven(body);
      assert.equal(output.finalText, "done");
      assert.equal(output.reward, undefined);
      assert.equal(existsSync(path), false);
    });
  }

  it("reads NaN and Infinity in an outcome file as nothing stated", async () => {
    // The Python reader takes the same file; `json.dump` writes these.
    const { output } = await driven(
      '{"reward": NaN, "success": true, "seeds": {"sampling": "NaN"}, ' +
      '"checks": [{"id": "a", "status": "abstained", "value": -Infinity}]}');
    assert.equal(output.reward, undefined);
    assert.equal(output.success, true);
    assert.deepEqual(output.seeds, { sampling: "NaN" });
    assert.deepEqual(output.checks, [{ id: "a", status: "abstained" }]);
  });

  it("keeps the first checks of an outcome file that states too many", async () => {
    const { output } = await driven({
      checks: Array.from({ length: 203 }, (_, i) => ({ id: String(i), status: "measured" })),
    });
    assert.equal(output.checks.length, 200);
    assert.equal(rolloutOutputToWire(output).checks_dropped, 3);
  });

  it("does not grade a rollout with a file written before it ran", async () => {
    // An episode that never reached `onAgentEnd` leaves its file behind.
    const { output, path } = await driven({ reward: 1, success: true }, { write: "before" });
    assert.equal(output.reward, undefined);
    assert.equal(output.success, undefined);
    assert.equal(existsSync(path), false);
  });

  it("reads no outcome file when no trajectory directory is set", async () => {
    const tx = fakeTransport();
    const d = createRolloutDriver({
      env: testEnv(), transport: tx, enqueue: async () => ({ enqueued: true }),
    });
    await d.onSessionStart({ sessionKey: "s1" });
    await d.onAgentEnd(
      { success: true, messages: [{ role: "assistant", content: "a" }] },
      { sessionKey: "s1" },
    );
    assert.deepEqual(Object.keys(tx.calls.report[0][1]).filter(
      (k) => tx.calls.report[0][1][k] !== undefined).sort(), ["finalText", "success"]);
  });

  it("gives back a rollout whose session ended with no answer", async () => {
    const tx = fakeTransport();
    const d = createRolloutDriver({
      env: testEnv(), transport: tx, enqueue: async () => ({ enqueued: true }),
    });
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
    const d = createRolloutDriver({
      env: testEnv(), transport: tx, enqueue: async () => ({ enqueued: true }),
    });
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
    const d = createRolloutDriver({
      env: testEnv(), transport: tx, enqueue: async () => ({ enqueued: true }),
    });
    await d.onSessionStart({ sessionKey: "s1" });
    await d.onSessionStart({ sessionKey: "s1" });
    assert.equal(tx.calls.claim.length, 1);
  });

  it("lets the agent run normally when the control plane is unreachable", async () => {
    const tx = fakeTransport({ claim: async () => { throw new Error("down"); } });
    const d = createRolloutDriver({
      env: testEnv(), transport: tx, enqueue: async () => ({ enqueued: true }),
    });
    assert.equal(await d.onSessionStart({ sessionKey: "s1" }), null);
    assert.equal(d.inFlight.size, 0);
  });

  it("does nothing at all when there is no work", async () => {
    const tx = fakeTransport({ claim: async () => ({ rollouts: [] }) });
    let sent = 0;
    const d = createRolloutDriver({
      env: testEnv(),
      transport: tx, enqueue: async () => { sent += 1; return { enqueued: true }; },
    });
    assert.equal(await d.onSessionStart({ sessionKey: "s1" }), null);
    assert.equal(sent, 0);
    assert.equal(tx.calls.abandon.length, 0);
  });

  it("ignores an agent_end for a session it never claimed for", async () => {
    const tx = fakeTransport();
    const d = createRolloutDriver({
      env: testEnv(), transport: tx, enqueue: async () => ({ enqueued: true }),
    });
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
      env: testEnv(),
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

  it("sends no beat once the control plane states the lease at the deadline", async () => {
    // The control plane caps a lease at the rollout's deadline, so once a
    // beat answers that cap no beat can extend it, and beating on at the
    // fixed cadence until the rollout ended was a POST per interval for
    // nothing, in every tenant. The Python SDK's
    // test_no_beat_is_sent_once_the_lease_has_reached_the_deadline.
    // Mutation: drop the deadline rule from `beat` -> a third beat is
    // scheduled, red.
    const beats = [];
    const answers = [{ lease_expires_ts: 300 }, { lease_expires_ts: 400 }];
    const timers = [];
    const tx = {
      leaseMs: 30_000,
      async claim() {
        return { rollouts: [{
          rolloutId: "r-capped", turnInput: "work", leaseToken: "lease-1",
          leaseExpiresTs: 109, deadlineTs: 400,
        }] };
      },
      async heartbeat(rollout) { beats.push(rollout.rolloutId); return answers.shift(); },
      async report() {},
      async abandon() {},
    };
    const d = createRolloutDriver({
      env: testEnv(), transport: tx, enqueue: async () => ({ enqueued: true }),
      now: () => 100_000,
      heartbeatScheduler: (callback, delayMs) => {
        const token = { callback, delayMs, cancelled: false };
        timers.push(token);
        return token;
      },
      heartbeatCanceller: (token) => { token.cancelled = true; },
    });
    const pending = () => timers.filter((x) => x.delayMs === 3_000 && !x.done);
    await d.onSessionStart({ sessionKey: "s1" });
    const run = async () => { const [x] = pending(); x.done = true; await x.callback(); };
    assert.equal(pending().length, 1);
    await run(); // the lease short of the deadline: the next beat is due
    assert.equal(pending().length, 1);
    await run(); // the lease at the deadline: nothing more is due
    assert.deepEqual(beats, ["r-capped", "r-capped"]);
    assert.equal(pending().length, 0, "a beat was scheduled for a lease at its cap");
    assert.equal(d.heartbeats.size, 1, "the rollout is still tracked until it ends");
  });

  it("does not treat a heartbeat racing a terminal report as revocation", async () => {
    const scheduled = [];
    let finishReport;
    const reportGate = new Promise((resolve) => { finishReport = resolve; });
    const d = createRolloutDriver({
      env: testEnv(),
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

  it("a 410 that lands after the rollout was reported touches nothing the session has since", async () => {
    // ND-C2. The heartbeat is in flight when the report completes; its 410
    // arrives after cleanup. It used to block the NEXT ordinary turn
    // (percepteye_lease_lost) and tear down a successor rollout's state.
    const scheduled = [];
    const cancelled = [];
    let answerHeartbeat;
    let claims = 0;
    const d = createRolloutDriver({
      env: testEnv(),
      transport: {
        leaseMs: 3_000,
        async claim() {
          claims += 1;
          return { rollouts: [{
            rolloutId: `r-late-${claims}`, turnInput: "work", leaseToken: `lease-${claims}`,
          }] };
        },
        heartbeat: () => new Promise((_, reject) => {
          answerHeartbeat = () => reject(new LeaseLost("result already closed lease"));
        }),
        async report() {},
        async abandon() {},
      },
      enqueue: async () => ({ enqueued: true }),
      cancel: async (request) => { cancelled.push(request); return true; },
      heartbeatScheduler: (callback) => {
        scheduled.push({ callback, cancelled: false });
        return scheduled.at(-1);
      },
      heartbeatCanceller(token) { token.cancelled = true; },
    });
    await d.onSessionStart({ sessionKey: "s1" });
    d.onBeforeAgentRun({}, { sessionKey: "s1", runId: "run-1" });
    const inFlightBeat = scheduled[0].callback();
    await d.onAgentEnd(
      { success: true, messages: [{ role: "assistant", content: "done" }] },
      { sessionKey: "s1", runId: "run-1" },
    );
    // The session moves on to its next rollout before the 410 lands.
    const second = await d.onSessionStart({ sessionKey: "s1" });
    assert.equal(second.rolloutId, "r-late-2");
    const successor = d.heartbeats.get("s1");
    answerHeartbeat();
    await inFlightBeat;
    assert.equal(d.blockNextRun.has("s1"), false, "the next turn is not refused");
    assert.equal(d.revokedRuns.has("s1"), false);
    assert.equal(d.heartbeats.get("s1"), successor, "the successor's renewal is untouched");
    assert.equal(successor.stopped, false);
    assert.equal(d.inFlight.get("s1")?.rolloutId, "r-late-2");
    assert.deepEqual(cancelled, []);
    assert.equal(d.onBeforeAgentRun({}, { sessionKey: "s1", runId: "run-2" }), undefined);
  });

  it("hands back at once a rollout claimed after its session ended", async () => {
    // ND-H5. session_end arrived while claim(1) was long-polling: it found
    // nothing in flight, and the rollout was then tracked -- a heartbeat
    // renewing a lease for a session that would never run it.
    let answer;
    const tx = fakeTransport({
      claim: () => new Promise((resolve) => { answer = resolve; }),
    });
    tx.heartbeat = async () => {};
    const sent = [];
    const d = createRolloutDriver({
      env: testEnv(), transport: tx,
      enqueue: async (i) => { sent.push(i); return { enqueued: true }; },
    });
    const started = d.onSessionStart({ sessionKey: "s1" });
    await new Promise((r) => setImmediate(r));
    await d.onSessionEnd({ sessionKey: "s1", reason: "closed" });
    answer({ rollouts: [{ rolloutId: "r-orphan", turnInput: "x", leaseToken: "lt" }] });
    assert.equal(await started, null);
    assert.deepEqual(sent, []);
    assert.equal(tx.calls.abandon[0]?.[0].rolloutId, "r-orphan");
    assert.equal(d.inFlight.size, 0);
    assert.equal(d.heartbeats.size, 0, "no lease is renewed for it");
  });

  it("hands back a rollout claimed past its deadline, in both lanes' one claim seam", async () => {
    const tx = fakeTransport({
      claim: async () => ({ rollouts: [{
        rolloutId: "r-late", turnInput: "x", leaseToken: "lt", deadlineTs: 99,
      }] }),
    });
    const sent = [];
    const d = createRolloutDriver({
      env: testEnv(), transport: tx, now: () => 100_000,
      enqueue: async (i) => { sent.push(i); return { enqueued: true }; },
    });
    assert.equal(await d.onSessionStart({ sessionKey: "s1" }), null);
    assert.deepEqual(sent, [], "work the server gave up on is not run");
    assert.equal(tx.calls.abandon[0][1].reason, "deadline_exceeded");
    assert.deepEqual((await d.claim(1)).rollouts, [], "the unattended lane's claim too");
  });

  it("stops a rollout at its deadline and reports it deadline_exceeded", async () => {
    let t = 1_000_000;
    const timers = [];
    const cancelled = [];
    const tx = fakeTransport({
      claim: async () => ({ rollouts: [{
        rolloutId: "r-slow", turnInput: "x", deadlineTs: (t + 60_000) / 1000,
      }] }),
    });
    const d = createRolloutDriver({
      env: testEnv(), transport: tx, now: () => t,
      enqueue: async () => ({ enqueued: true }),
      cancel: async (request) => { cancelled.push(request); return true; },
      heartbeatScheduler: (callback, delayMs) => {
        timers.push({ callback, delayMs });
        return timers.at(-1);
      },
      heartbeatCanceller(timer) { timer.cancelled = true; },
    });
    await d.onSessionStart({ sessionKey: "s1" });
    d.onBeforeAgentRun({}, { sessionKey: "s1", runId: "run-1" });
    const deadline = timers.at(-1);
    assert.equal(deadline.delayMs, 60_000 - 10_000, "stopped short, leaving time to report");
    t += 50_000;
    await deadline.callback();
    await new Promise((r) => setImmediate(r));
    assert.equal(tx.calls.report.length, 1);
    const output = tx.calls.report[0][1];
    assert.equal(output.finalText, "");
    assert.equal(output.exclusion.reason, "deadline_exceeded");
    assert.equal(d.inFlight.has("s1"), false);
    assert.equal(cancelled[0]?.runId, "run-1", "the run is stopped");
    assert.ok(d.onBeforeToolCall({}, { sessionKey: "s1", runId: "run-1" })?.block,
      "and fenced, as a lost lease's run is");
    // The run's own late answer reports nothing a second time.
    await d.onAgentEnd(
      { success: true, messages: [{ role: "assistant", content: "late" }] },
      { sessionKey: "s1", runId: "run-1" },
    );
    assert.equal(tx.calls.report.length, 1);
  });

  it("clears the deadline timer of a rollout that answered in time", async () => {
    const timers = [];
    const tx = fakeTransport({
      claim: async () => ({ rollouts: [{
        rolloutId: "r-quick", turnInput: "x", deadlineTs: Date.now() / 1000 + 600,
      }] }),
    });
    const d = createRolloutDriver({
      env: testEnv(), transport: tx, enqueue: async () => ({ enqueued: true }),
      heartbeatScheduler: (callback, delayMs) => {
        timers.push({ callback, delayMs, cancelled: false });
        return timers.at(-1);
      },
      heartbeatCanceller(timer) { timer.cancelled = true; },
    });
    await d.onSessionStart({ sessionKey: "s1" });
    await d.onAgentEnd(
      { success: true, messages: [{ role: "assistant", content: "done" }] },
      { sessionKey: "s1" },
    );
    assert.equal(timers.at(-1).cancelled, true);
  });

  it("paces a long initial grant against the ten-minute renewal ceiling", async () => {
    const scheduled = [];
    const d = createRolloutDriver({
      env: testEnv(),
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
      env: testEnv(),
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
      env: testEnv(),
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
      env: testEnv(),
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
      env: testEnv(),
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
    const d = createRolloutDriver({
      env: testEnv(), transport: tx, enqueue: async () => ({ enqueued: true }),
    });
    await d.onSessionStart({ sessionKey: "s1" });
    await d.onSessionStart({ sessionKey: "s1" });
    assert.equal(claims, 2, "a session that got no work must be able to ask again");
  });
});
