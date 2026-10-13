import { testEnv } from "./support/home.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  canonicalCommandArgv, canonicalObservationSha256,
  createExecutionIdentityTracker, executionDescriptorSha256,
  normalizeExecutionSnapshot, normalizeVolatileCommandValues,
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
      env: testEnv(),
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

describe("canonical command argv", () => {
  // The one sentinel the Python SDK spells `fw.TASK`: the argv slot each
  // rollout's task is substituted into. Its identity entry is `task_input`,
  // and it is compared by reference, never stringified.
  const TASK = Symbol("task");
  const DECLARED = ["--daemon-socket"];
  const socketArgv = (path) =>
    ["agent", "--daemon-socket", path, "--mode", "json", TASK];

  /**
   * The descriptor a command entrypoint would register, hashed. Only `argv`
   * varies across these cases, so a digest that moves means the projection
   * moved.
   */
  const commandDigest = (command, volatileValueOptions) => executionDescriptorSha256({
    schema: "percepteye.agent_execution/v1",
    sdk: "agent-flywheel-node/0.1.0",
    contract_version: "flywheel/1",
    entrypoint: {
      kind: "command",
      argv: canonicalCommandArgv(command, {
        volatileValueOptions: normalizeVolatileCommandValues(volatileValueOptions),
        taskSentinel: TASK,
      }),
    },
    attested_components: { "customer.release": "a".repeat(64) },
  });

  it("voids a declared value while its option stays identity", () => {
    // The defect this matches: a PID-bearing socket path re-minted the
    // execution identity on every restart, and Mission Control refuses every
    // episode whose attestation does not match the prepared workload.
    const first = commandDigest(socketArgv("/tmp/agent-111.sock"), DECLARED);
    const second = commandDigest(socketArgv("/tmp/agent-222.sock"), DECLARED);
    assert.equal(first, second);

    // Nothing is detected. The SAME two commands, undeclared, stay two
    // identities -- which is what made every restart a new agent.
    assert.notEqual(
      commandDigest(socketArgv("/tmp/agent-111.sock")),
      commandDigest(socketArgv("/tmp/agent-222.sock")),
    );

    // Presence is identity even though the value is not: an agent with no
    // daemon socket at all must not collide with one that has a private one.
    assert.notEqual(commandDigest(["agent", "--mode", "json", TASK]), first);

    // Both spellings are accepted and neither is rewritten into the other.
    const joinedOne = commandDigest(
      ["agent", "--daemon-socket=/tmp/agent-111.sock", "--mode", "json", TASK],
      DECLARED,
    );
    const joinedTwo = commandDigest(
      ["agent", "--daemon-socket=/tmp/agent-222.sock", "--mode", "json", TASK],
      DECLARED,
    );
    assert.equal(joinedOne, joinedTwo);
    assert.notEqual(joinedOne, first);
  });

  it("still moves the digest for every token that is not the declared value", () => {
    const base = commandDigest(socketArgv("/tmp/agent-111.sock"), DECLARED);
    const moved = {
      other_argument: commandDigest(
        ["agent", "--daemon-socket", "/tmp/agent-111.sock", "--mode", "text", TASK],
        DECLARED,
      ),
      program: commandDigest(
        ["agent2", "--daemon-socket", "/tmp/agent-111.sock", "--mode", "json", TASK],
        DECLARED,
      ),
      dropped_option: commandDigest(["agent", "--mode", "json", TASK]),
      task_slot: commandDigest(
        ["agent", "--daemon-socket", "/tmp/agent-111.sock", TASK, "--mode", "json"],
        DECLARED,
      ),
    };
    for (const [name, value] of Object.entries(moved)) {
      assert.notEqual(value, base, name);
    }
    assert.equal(new Set([base, ...Object.values(moved)]).size,
      Object.keys(moved).length + 1);
  });

  it("names the actual cause when a declaration cannot be honoured", () => {
    const build = (command, values) => canonicalCommandArgv(command, {
      volatileValueOptions: normalizeVolatileCommandValues(values),
      taskSentinel: TASK,
    });

    assert.throws(
      () => build(socketArgv("/tmp/a.sock"), ["--daemon-sock"]),
      { name: "ConfigurationError", message: /does not contain/ },
    );
    // Voiding argv[0] would erase the entrypoint itself.
    assert.throws(
      () => build(socketArgv("/tmp/a.sock"), ["agent"]),
      { name: "ConfigurationError", message: /argv\[0\], the program itself/ },
    );
    assert.throws(
      () => build(["agent", "--mode", "json", "--daemon-socket"], DECLARED),
      { name: "ConfigurationError", message: /no value to void/ },
    );
    assert.throws(
      () => build(["agent", "--daemon-socket", TASK], DECLARED),
      { name: "ConfigurationError", message: /task input sentinel/ },
    );
    assert.throws(
      () => build([], DECLARED),
      { name: "ConfigurationError", message: /at least one argument/ },
    );

    // A bare string is iterable, so accepting one would declare every
    // character; a Map is iterable too and would declare its entries.
    assert.throws(
      () => normalizeVolatileCommandValues("--daemon-socket"),
      { name: "ConfigurationError", message: /not a single string/ },
    );
    assert.throws(
      () => normalizeVolatileCommandValues(new Map([["--daemon-socket", 1]])),
      { name: "ConfigurationError", message: /not a single string/ },
    );
    assert.throws(
      () => normalizeVolatileCommandValues({ "--daemon-socket": true }),
      { name: "ConfigurationError", message: /not a single string/ },
    );
    assert.throws(
      () => normalizeVolatileCommandValues(["  "]),
      { name: "ConfigurationError", message: /non-empty option names/ },
    );
    // A command that is not an array would otherwise be indexed one character
    // at a time; Python's caller guarantees a list, this package has none yet.
    assert.throws(
      () => canonicalCommandArgv("agent --daemon-socket /tmp/a.sock"),
      { name: "ConfigurationError", message: /must be an array/ },
    );

    // A token that is not already a string would have to be stringified to be
    // hashed, and `str()` and `String()` disagree: Python spells True/1.0/None
    // where JavaScript spells true/1/null. Coercing here is how the SAME
    // command would acquire a DIFFERENT identity depending on which SDK
    // registered the agent -- worse than the per-restart instability the
    // projection was added to fix, because it is silent on both sides.
    for (const [token, spelling] of [[8080, 'of type "number"'],
      [true, 'of type "boolean"'], [1.0, 'of type "number"'], [null, "null"],
      [{}, 'of type "object"']]) {
      assert.throws(
        () => build(["agent", "--mode", token], []),
        {
          name: "ConfigurationError",
          message: new RegExp(`command argument 2 is ${spelling}, not a string`),
        },
      );
    }
    // No slot is exempt, including one whose value a declaration would void:
    // a port is exactly the per-process number a caller reaches for, and
    // accepting it there teaches a habit that splits the digest elsewhere.
    assert.throws(
      () => build(["agent", "--daemon-socket", 8080], DECLARED),
      {
        name: "ConfigurationError",
        message: /command argument 2 is of type "number"/,
      },
    );
    // The sentinel is the one non-string that belongs in argv.
    assert.deepEqual(build(["agent", TASK], []), [
      { literal: "agent" }, { task_input: true },
    ]);

    assert.deepEqual(normalizeVolatileCommandValues(null), []);
    assert.deepEqual(normalizeVolatileCommandValues(undefined), []);
    // Deduped, order preserved.
    assert.deepEqual(
      normalizeVolatileCommandValues(["--b", "--a", "--b"]), ["--b", "--a"],
    );
  });

  it("adds no entry shape at all when nothing is declared", () => {
    // Backward compatibility, spelled out rather than implied: with an empty
    // declaration the projection is the plain verbatim argv the descriptor
    // carried before the declaration existed, so an agent that declares
    // nothing keeps the digest it registered. The Python suite asserts the
    // same thing against its own pre-change descriptor, and
    // cross_language_abi_check.sh asserts the two are the same bytes.
    const command = ["agent", "--mode", "json", TASK];
    assert.deepEqual(canonicalCommandArgv(command, { taskSentinel: TASK }), [
      { literal: "agent" },
      { literal: "--mode" },
      { literal: "json" },
      { task_input: true },
    ]);
    assert.deepEqual(
      canonicalCommandArgv(command, { taskSentinel: TASK }),
      command.map((item) => (item === TASK
        ? { task_input: true }
        : { literal: String(item) })),
    );
  });

  it("keeps the option token and voids only the value", () => {
    assert.deepEqual(
      canonicalCommandArgv(socketArgv("/tmp/a.sock"), {
        volatileValueOptions: DECLARED, taskSentinel: TASK,
      }),
      [
        { literal: "agent" },
        { literal: "--daemon-socket" },
        { volatile_value: "--daemon-socket" },
        { literal: "--mode" },
        { literal: "json" },
        { task_input: true },
      ],
    );
    // The joined spelling collapses to ONE entry -- there is no separate
    // option token to keep, because argv never had one.
    assert.deepEqual(
      canonicalCommandArgv(["agent", "--daemon-socket=/tmp/a.sock"], {
        volatileValueOptions: DECLARED,
      }),
      [{ literal: "agent" }, { volatile_value: "--daemon-socket" }],
    );
  });
});
