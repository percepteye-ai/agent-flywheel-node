/**
 * OTel GenAI span egress, and the parity that makes the two SDKs swappable.
 *
 * A customer deploys this package or the pip one, never both, and the promise
 * is that they emit the same telemetry. That promise used to be checked by
 * grepping the Python module's source for attribute-key strings, which proved
 * the strings existed somewhere and nothing about what either SDK emitted.
 *
 * It is now a GOLDEN FIXTURE: `test/fixtures/genai-golden.json`, byte-identical
 * to the Python repository's `tests/fixtures/genai-golden.json`, holds a
 * scripted scenario and the exact spans it must produce -- names, kinds,
 * times, statuses and every attribute, content JSON compared as text. Each
 * suite renders the scenario through its own SDK and must match it; the
 * Python suite also validates every content value against the OpenTelemetry
 * GenAI JSON schemas.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  recordToolCallSpan,
  recordTurnSpan,
  tracingAvailable,
  __resetTracerForTests,
} from "../src/tracing.js";

const FIXTURE = new URL("./fixtures/genai-golden.json", import.meta.url);
const PY_FIXTURE = new URL(
  "../../percepteye-agent-flywheel/tests/fixtures/genai-golden.json",
  import.meta.url,
);
const golden = () => JSON.parse(readFileSync(FIXTURE, "utf8"));

/** The API surface the module reads: span kinds and status codes. */
const API = { SpanKind: { INTERNAL: 0 }, SpanStatusCode: { ERROR: 2 } };
const KINDS = { 0: "INTERNAL" };
const STATUS = { 2: "ERROR" };

/** A tracer that records what was set, standing in for the customer's. */
function fakeTracer() {
  const spans = [];
  return {
    spans,
    startSpan(name, options = {}) {
      const span = {
        name,
        kind: options.kind,
        startTime: options.startTime,
        endTime: undefined,
        attributes: { ...(options.attributes ?? {}) },
        status: null,
        ended: false,
        isRecording: () => true,
        setAttribute(k, v) { this.attributes[k] = v; },
        setStatus(s) { this.status = s; },
        end(t) { this.ended = true; this.endTime = t; },
      };
      spans.push(span);
      return span;
    },
  };
}

function withTracer(fn) {
  const t = fakeTracer();
  __resetTracerForTests(t, API);
  try { return fn(t); } finally { __resetTracerForTests(); }
}

/** A span in the fixture's shape. */
function normalise(span) {
  const status = span.status
    ? { code: STATUS[span.status.code] ?? String(span.status.code),
        ...(span.status.message ? { description: span.status.message } : {}) }
    : { code: "UNSET" };
  const attributes = {};
  for (const k of Object.keys(span.attributes).sort()) {
    attributes[k] = span.attributes[k];
  }
  return {
    name: span.name,
    kind: KINDS[span.kind] ?? String(span.kind),
    start_time_ms: span.startTime,
    end_time_ms: span.endTime,
    status,
    attributes,
  };
}

const camel = (key) => key.replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());

/** The fixture's scenario through THIS SDK, keys camelCased for Node. */
function render(scenario) {
  return withTracer((t) => {
    for (const step of structuredClone(scenario)) {
      const { call, name, arguments: args, ...rest } = step;
      const opts = Object.fromEntries(
        Object.entries(rest).map(([k, v]) => [camel(k), v]));
      if (call === "tool_call") recordToolCallSpan(name, args, opts);
      else if (call === "turn") recordTurnSpan(opts);
      else throw new Error(`unknown scenario call ${call}`);
    }
    return t.spans.map(normalise);
  });
}

describe("the golden fixture shared with the Python SDK", () => {
  it("renders the scenario to exactly the expected spans", () => {
    const g = golden();
    const got = render(g.scenario);
    assert.deepEqual(got.map((s) => s.name), g.spans.map((s) => s.name));
    got.forEach((span, i) => assert.deepEqual(span, g.spans[i], span.name));
  });

  it("is byte-identical to the Python SDK's copy", (t) => {
    if (!existsSync(PY_FIXTURE)) {
      t.skip("python sdk checkout not present");
      return;
    }
    assert.ok(
      readFileSync(PY_FIXTURE).equals(readFileSync(FIXTURE)),
      "the golden fixture differs between the Node and Python SDKs; copy the " +
      "changed one over the other in the same change",
    );
  });

  it("exercises what it claims to: objects, nulls, failures, a whole turn", () => {
    const spans = render(golden().scenario);
    const [ok, failed, turn, rollout] = spans;
    assert.deepEqual(JSON.parse(ok.attributes["gen_ai.tool.call.arguments"]),
                     { location: "Paris", unit: "celsius" });
    // A JSON-string argument became the object it encodes.
    assert.equal(
      JSON.parse(failed.attributes["gen_ai.tool.call.arguments"]).party, 2);
    assert.equal(JSON.parse(ok.attributes["gen_ai.tool.call.result"]).next_cursor,
                 null);
    assert.equal(failed.status.code, "ERROR");
    assert.equal(failed.attributes["error.type"], "Conflict");
    assert.equal("gen_ai.tool.call.result" in failed.attributes, false);
    assert.equal(ok.end_time_ms - ok.start_time_ms, 120);
    assert.deepEqual(turn.attributes["gen_ai.response.finish_reasons"], ["stop"]);
    assert.equal(rollout.attributes["percepteye.rollout.id"], "rollout-42");
    assert.equal("percepteye.turn.id" in rollout.attributes, false);
  });
});

describe("rules stated once each", () => {
  it("cuts nothing, whatever its size, and never splits a surrogate pair", () => {
    const big = { blob: "z".repeat(50_000), emoji: "\u{1F4E6}".repeat(10_000) };
    withTracer((t) => {
      recordToolCallSpan("upload", big, { outcome: "ok", result: big });
      recordTurnSpan({ inputText: "q".repeat(100_000),
                       outputText: "\u{1F4E6}".repeat(30_000) });
      const [tool, turn] = t.spans;
      assert.deepEqual(JSON.parse(tool.attributes["gen_ai.tool.call.arguments"]), big);
      assert.deepEqual(JSON.parse(tool.attributes["gen_ai.tool.call.result"]), big);
      const out = JSON.parse(turn.attributes["gen_ai.output.messages"]);
      assert.equal(out[0].parts[0].content, "\u{1F4E6}".repeat(30_000));
      recordToolCallSpan("f", {}, { outcome: "failed", error: "e".repeat(5_000) });
      assert.equal(t.spans[2].status.message, "e".repeat(5_000));
    });
  });

  it("leaves a string argument holding an inexact integer as a string", () => {
    // Parsing it would change the number; Python refuses the same input.
    withTracer((t) => {
      recordTurnSpan({
        inputMessages: [{ role: "assistant", parts: [{
          type: "tool_call", name: "f", arguments: '{"id": 9007199254740993}',
        }] }],
      });
      const [msg] = JSON.parse(t.spans[0].attributes["gen_ai.input.messages"]);
      assert.equal(msg.parts[0].arguments, '{"id": 9007199254740993}');
    });
  });

  it("leaves an unknown outcome's status UNSET", () => {
    withTracer((t) => {
      recordToolCallSpan("book", {}, { outcome: "unknown" });
      assert.equal(t.spans[0].status, null);
    });
  });

  it("says nothing rather than asserting an empty turn", () => {
    withTracer((t) => {
      recordTurnSpan({ turnId: "turn_3" });
      assert.equal(t.spans.length, 0);
    });
  });

  it("is a silent no-op, never a throw, without the optional dependency", () => {
    __resetTracerForTests();
    assert.equal(tracingAvailable(), false);
    recordToolCallSpan("x", { a: 1 }, { outcome: "ok" });
    recordTurnSpan({ inputText: "hi" });
  });
});

// ── the recorder: which ids a tool call is stamped with ─────────────────────

async function recordOne({ mode, env, rolloutFor = null, ctx, identity = null }) {
  const { createRecorder } = await import("../src/record.js");
  const prior = process.env.PERCEPTEYE_AGENT_MODE;
  const t = fakeTracer();
  __resetTracerForTests(t, API);
  if (env === undefined) delete process.env.PERCEPTEYE_AGENT_MODE;
  else process.env.PERCEPTEYE_AGENT_MODE = env;
  try {
    createRecorder({
      writer: { write: () => true }, mode, rolloutFor,
      executionIdentity: identity,
    }).handle(
      { toolName: "book", params: { day: "tue" }, toolCallId: "call_9",
        result: { id: 7 }, durationMs: 42 },
      ctx,
    );
    return t.spans[0];
  } finally {
    __resetTracerForTests();
    if (prior === undefined) delete process.env.PERCEPTEYE_AGENT_MODE;
    else process.env.PERCEPTEYE_AGENT_MODE = prior;
  }
}

describe("which id a tool call is stamped with", () => {
  const CTX = { runId: "run_1", sessionKey: "agent:main:slack:c1",
                agentId: "main", taskId: "case-3" };

  it("a production mode from the PLUGIN CONFIG is honoured with the env unset", async () => {
    // THE P0 DEFECT: the recorder read only PERCEPTEYE_AGENT_MODE, so with the
    // mode set in the plugin config and the variable unset it fell back to
    // training and stamped the host's run id as a rollout id -- and a consumer
    // that drops self-emitted spans dropped every production tool call.
    const span = await recordOne({ mode: "production", env: undefined, ctx: CTX });
    assert.equal("percepteye.rollout.id" in span.attributes, false);
    assert.equal(span.attributes["percepteye.turn.id"], "run_1");
  });

  it("a production tool call carries its conversation, task and identity", async () => {
    const sha = "b".repeat(64);
    const span = await recordOne({
      mode: "production", ctx: CTX,
      identity: { fingerprintFor: () => ({ execution_sha256: sha }) },
    });
    const a = span.attributes;
    assert.equal(a["gen_ai.conversation.id"], "agent:main:slack:c1");
    assert.equal(a["percepteye.conversation.id"], "agent:main:slack:c1");
    assert.equal(a["percepteye.task.id"], "case-3");
    assert.equal(a["percepteye.agent.execution_sha256"], sha);
  });

  it("a training rollout carries the CONTROL PLANE's rollout id, not the run id", async () => {
    const span = await recordOne({
      mode: "training", ctx: CTX,
      rolloutFor: (ctx) => (ctx.sessionKey === CTX.sessionKey
        ? { rolloutId: "rl_mc_77" } : null),
    });
    assert.equal(span.attributes["percepteye.rollout.id"], "rl_mc_77");
    assert.equal("percepteye.turn.id" in span.attributes, false);
    // A rollout carries no production correlation, as in Python's serve().
    assert.equal("gen_ai.conversation.id" in span.attributes, false);
  });

  it("a training install's ordinary session is the customer's own turn", async () => {
    const span = await recordOne({ mode: "training", ctx: CTX, rolloutFor: () => null });
    assert.equal("percepteye.rollout.id" in span.attributes, false);
    assert.equal(span.attributes["percepteye.turn.id"], "run_1");
  });

  it("the span covers the call: it starts durationMs before it ends", async () => {
    const span = await recordOne({ mode: "production", ctx: CTX });
    assert.equal(span.endTime - span.startTime, 42);
    assert.equal(span.kind, 0);
    assert.equal(span.attributes["gen_ai.tool.type"], "function");
    assert.equal(JSON.parse(span.attributes["gen_ai.tool.call.result"]).id, 7);
  });

  it("the plugin hands the recorder its CONFIG mode", async () => {
    // Wiring, not the unit: register the plugin with production in its config
    // and PERCEPTEYE_AGENT_MODE unset, fire after_tool_call, read the span.
    const { default: plugin, HOOK_NAME } = await import("../src/index.js");
    const hooks = {};
    const api = { on: (name, fn) => { (hooks[name] ??= []).push(fn); } };
    const prior = process.env.PERCEPTEYE_AGENT_MODE;
    delete process.env.PERCEPTEYE_AGENT_MODE;
    const t = fakeTracer();
    __resetTracerForTests(t, API);
    try {
      plugin.register(api, { mode: "production" }, {
        PERCEPTEYE_CAPTURE_DIR: mkdtempSync(join(tmpdir(), "pe-cap-")),
      });
      for (const fn of hooks[HOOK_NAME]) {
        fn({ toolName: "book", params: {}, runId: "run_5" },
           { runId: "run_5", sessionKey: "s1" });
      }
      const span = t.spans.find((s) => s.name === "execute_tool book");
      assert.ok(span, "no tool span was emitted");
      assert.equal("percepteye.rollout.id" in span.attributes, false);
      assert.equal(span.attributes["percepteye.turn.id"], "run_5");
      // Read as training, a production call also loses its production
      // correlation -- the conversation its turn belongs to.
      assert.equal(span.attributes["gen_ai.conversation.id"], "s1");
    } finally {
      __resetTracerForTests();
      if (prior !== undefined) process.env.PERCEPTEYE_AGENT_MODE = prior;
    }
  });
});

describe("the plugin wires the rollout driver to the recorder", () => {
  it("a tool call in a claimed rollout's session carries that rollout's id", async () => {
    const { default: plugin, HOOK_NAME, PLUGIN_ID } = await import("../src/index.js");
    const hooks = {};
    const api = {
      on: (name, fn) => { (hooks[name] ??= []).push(fn); },
      config: { plugins: { entries: {
        [PLUGIN_ID]: { hooks: { allowConversationAccess: true } } } } },
      session: { workflow: { enqueueNextTurnInjection: async () => ({ enqueued: true }) } },
      logger: { info() {}, warn() {} },
    };
    const t = fakeTracer();
    __resetTracerForTests(t, API);
    try {
      const out = plugin.register(api, {
        mode: "training", apiKey: "pefw_test",
        // Refused at once: nothing in this test may reach a real control plane.
        controlPlaneUrl: "http://127.0.0.1:9/api/flywheel/v1",
      }, { PERCEPTEYE_TRAJECTORY_DIR: "" });
      out.rollouts.track("s1", { rolloutId: "rl_mc_9" });
      for (const fn of hooks[HOOK_NAME]) {
        fn({ toolName: "book", params: {}, runId: "run_host_1" },
           { runId: "run_host_1", sessionKey: "s1" });
      }
      const span = t.spans.find((s) => s.name === "execute_tool book");
      assert.equal(span.attributes["percepteye.rollout.id"], "rl_mc_9");
      assert.equal("percepteye.turn.id" in span.attributes, false);
      out.rollouts.inFlight.delete("s1");
    } finally {
      __resetTracerForTests();
    }
  });
});

// ── the turn: one span, carrying the whole turn ─────────────────────────────

const SHA = "5f1c6b3e0d7a9e2c4b8f1a6d3c0e9b7a2f4d6c8e1b3a5f7d9c2e4b6a8d0f1c3e";

/** The golden turn as the HOST hands it over: its own transcript format. */
const HOST_TRANSCRIPT = [
  { role: "user",
    content: "What's the weather in Paris, and book Chez Nous for 2 at 19:30?" },
  { role: "assistant", stopReason: "toolUse", content: [
    { type: "toolCall", id: "call_weather_1", name: "get_weather",
      arguments: { location: "Paris", unit: "celsius" } }] },
  { role: "toolResult", toolCallId: "call_weather_1", toolName: "get_weather",
    isError: false, content: [{ type: "text",
      text: '{"temperature":14,"conditions":"rainy ☔","alerts":[],"next_cursor":null}' }] },
  { role: "assistant", stopReason: "toolUse", content: [
    { type: "text", text: "Booking now." },
    { type: "toolCall", id: "call_book_2", name: "book_table",
      arguments: { restaurant: "Chez Nous", party: 2, time: "19:30" } }] },
  { role: "toolResult", toolCallId: "call_book_2", toolName: "book_table",
    isError: true, content: [{ type: "text",
      text: "table already booked for 19:30 — try 20:00" }] },
  { role: "assistant", stopReason: "stop", content: [{ type: "text",
    text: "It's 14 °C and rainy in Paris \u{1F327}. Chez Nous is full at 19:30 — shall I try 20:00?" }] },
];

async function captureTurn({ answersExpected = true, agentEnd = true } = {}) {
  const { createTurnCapture } = await import("../src/capture.js");
  const { recordExecutionFingerprint, turnDir } = await import("../src/turns.js");
  const root = mkdtempSync(join(tmpdir(), "pe-turn-"));
  const cap = createTurnCapture({ root });
  const t = fakeTracer();
  __resetTracerForTests(t, API);
  try {
    const ctx = { runId: "turn-7", sessionKey: "conv-7", taskId: "case-7",
                  agentId: "concierge" };
    recordExecutionFingerprint(turnDir(root, "turn-7"), { execution_sha256: SHA });
    cap.onMessageReceived(
      { runId: "turn-7", content: HOST_TRANSCRIPT[0].content },
      { sessionKey: "conv-7", taskId: "case-7" }, { answersExpected });
    cap.onModelInput(
      { runId: "turn-7",
        systemPrompt: "You are a concise concierge. Give temperatures in °C." },
      ctx);
    if (agentEnd) {
      cap.onAgentEnd({ runId: "turn-7", messages: HOST_TRANSCRIPT,
                       success: true, durationMs: 1500 }, ctx);
    }
    return t.spans;
  } finally {
    __resetTracerForTests();
  }
}

describe("a captured turn", () => {
  it("is ONE invoke_agent span whose attributes are the golden turn's, byte for byte", async () => {
    // The host's own transcript, through the host adapter, lands on exactly
    // the bytes the golden fixture pins for the same turn -- which Python
    // renders identically. The transcript used to be read for its last text
    // and discarded.
    const spans = await captureTurn();
    assert.equal(spans.length, 1);
    const [span] = spans;
    const want = golden().spans.find((s) => s.name === "invoke_agent concierge"
      && s.attributes["percepteye.turn.id"] === "turn-7");
    assert.deepEqual(normalise(span).attributes, want.attributes);
    assert.equal(span.endTime - span.startTime, 1500);
    assert.equal(span.name, "invoke_agent concierge");
  });

  it("is emitted from the user's message ALONE when no answer can arrive", async () => {
    const spans = await captureTurn({ answersExpected: false, agentEnd: false });
    assert.equal(spans.length, 1);
    const a = spans[0].attributes;
    assert.deepEqual(JSON.parse(a["gen_ai.input.messages"]), [{
      role: "user", parts: [{ type: "text", content: HOST_TRANSCRIPT[0].content }],
    }]);
    assert.equal("gen_ai.output.messages" in a, false);
    assert.equal(a["gen_ai.conversation.id"], "conv-7");
  });

  it("emits nothing from the user's message when the answer will come", async () => {
    const spans = await captureTurn({ answersExpected: true, agentEnd: false });
    assert.equal(spans.length, 0);
  });

  it("marks a failed run ERROR", async () => {
    const { createTurnCapture } = await import("../src/capture.js");
    const cap = createTurnCapture({ root: mkdtempSync(join(tmpdir(), "pe-turn-")) });
    withTracer((t) => {
      cap.onAgentEnd({ runId: "r9", success: false, error: "provider timeout",
                       messages: [{ role: "user", content: "hi" }] }, {});
      assert.equal(t.spans[0].status.code, 2);
      assert.equal(t.spans[0].status.message, "provider timeout");
      assert.equal(t.spans[0].attributes["error.type"], "_OTHER");
    });
  });

  it("maps the host's stop reasons to the convention's", async () => {
    const { genaiTurn } = await import("../src/host.js");
    const ended = (stopReason) => genaiTurn([
      { role: "user", content: "go" },
      { role: "assistant", stopReason, content: [{ type: "text", text: "x" }] },
    ]).output[0].finish_reason;
    assert.equal(ended("stop"), "stop");
    assert.equal(ended("length"), "length");
    assert.equal(ended("toolUse"), "tool_call");
    assert.equal(ended("error"), "error");
    // A finish reason expected and not received is `error` in the convention.
    assert.equal(ended("aborted"), "error");
    // An unknown one is carried, never guessed at.
    assert.equal(ended("somethingNew"), "somethingNew");
  });

  it("has no answer when the run did not end on one", async () => {
    const { genaiTurn } = await import("../src/host.js");
    const turn = genaiTurn(HOST_TRANSCRIPT.slice(0, 3));
    assert.deepEqual(turn.output, []);
    assert.equal(turn.input.length, 3);
    assert.equal(turn.input[2].role, "tool");
  });

  it("the subscribed hook emits the user's half when the host drops agent_end", async () => {
    // Wiring: `registerTurnCapture` asks the host's own predicate once and
    // hands the answer to the message hook.
    const { createTurnCapture, registerTurnCapture } = await import("../src/capture.js");
    for (const granted of [false, true]) {
      const hooks = {};
      const api = {
        on: (name, fn) => { (hooks[name] ??= []).push(fn); },
        config: { plugins: { entries: {
          "agent-flywheel": { hooks: { allowConversationAccess: granted } } } } },
      };
      const root = mkdtempSync(join(tmpdir(), "pe-reg-"));
      registerTurnCapture(api, {
        config: { apiKey: null, agentId: "a" }, pluginId: "agent-flywheel",
        turns: createTurnCapture({ root }), env: { PERCEPTEYE_CAPTURE_DIR: root },
      });
      withTracer((t) => {
        for (const fn of hooks.message_received) {
          fn({ runId: "r1", content: "hi", sessionKey: "s" }, {});
        }
        assert.equal(t.spans.length, granted ? 0 : 1, `granted=${granted}`);
      });
    }
  });

  it("writing a turn's text emits no span of its own", async () => {
    const { recordTurnText } = await import("../src/turns.js");
    withTracer((t) => {
      const dir = join(mkdtempSync(join(tmpdir(), "pe-turns-")), "turn_1");
      assert.equal(recordTurnText(dir, "task", "book me tuesday"), true);
      assert.equal(recordTurnText(dir, "answer", "booked"), true);
      assert.equal(t.spans.length, 0);
    });
  });
});
