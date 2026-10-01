/**
 * GenAI span egress, and the parity that makes the two SDKs swappable.
 *
 * A customer deploys this package or the pip one, never both, and the promise
 * is that they behave identically. Node had NO tracing module at all while
 * Python had one, so a Node customer's agent emitted no `gen_ai.*` telemetry:
 * the trace ingest's agent lane selects INTERNAL/CLIENT spans carrying a `gen_ai.*`
 * attribute, so their export produced zero agent records, no conversation, and
 * therefore no next-state signal for the per-step reward model to vote on.
 *
 * These assert the exact span names and attribute keys against the Python
 * module's own source, because "keep these in sync" in a comment is not a
 * mechanism and both sides have drifted before.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_ATTRIBUTE_CHARS,
  MAX_TURN_CHARS,
  recordToolCallSpan,
  recordTurnSpan,
  tracingAvailable,
  __resetTracerForTests,
} from "../src/tracing.js";

/** A tracer that records what was set, standing in for the customer's. */
function fakeTracer() {
  const spans = [];
  return {
    spans,
    startActiveSpan(name, fn) {
      const span = {
        name, attributes: {}, status: null, ended: false,
        isRecording: () => true,
        setAttribute(k, v) { this.attributes[k] = v; },
        setStatus(s) { this.status = s; },
        end() { this.ended = true; },
      };
      spans.push(span);
      return fn(span);
    },
  };
}

function withTracer(fn) {
  const t = fakeTracer();
  __resetTracerForTests(t, { SpanStatusCode: { ERROR: 2 } });
  try { fn(t); } finally { __resetTracerForTests(); }
}

describe("tool call spans", () => {
  it("carries the GenAI convention's names for what it names", () => {
    withTracer((t) => {
      recordToolCallSpan("search_patients", { q: "ann" }, {
        outcome: "ok", toolCallId: "call_7", agentName: "scheduler",
      });
      const s = t.spans[0];
      assert.equal(s.name, "execute_tool search_patients");
      assert.equal(s.attributes["gen_ai.operation.name"], "execute_tool");
      assert.equal(s.attributes["gen_ai.tool.name"], "search_patients");
      assert.equal(s.attributes["gen_ai.tool.call.id"], "call_7");
      assert.equal(s.attributes["gen_ai.agent.name"], "scheduler");
      assert.equal(s.attributes["gen_ai.tool.call.arguments"], '{"q":"ann"}');
      assert.equal(s.ended, true);
    });
  });

  it("namespaces the tri-state outcome as ours, because the convention has no word for it", () => {
    withTracer((t) => {
      recordToolCallSpan("book", null, { outcome: "unknown" });
      const s = t.spans[0];
      assert.equal(s.attributes["percepteye.tool.outcome"], "unknown");
      // UNKNOWN LEAVES THE STATUS UNSET. Marking it OK asserts a success
      // nobody observed; ERROR asserts a failure nobody observed.
      assert.equal(s.status, null);
    });
  });

  it("marks the span an error only on a REPORTED failure", () => {
    withTracer((t) => {
      recordToolCallSpan("book", null, { outcome: "failed", error: "409" });
      assert.equal(t.spans[0].status.code, 2);
      assert.equal(t.spans[0].status.message, "409");
    });
    withTracer((t) => {
      recordToolCallSpan("book", null, { outcome: "ok" });
      assert.equal(t.spans[0].status, null);
    });
  });

  it("keeps a production turn out of the rollout accounting", () => {
    // Stamping a served turn under `percepteye.rollout.id` made a customer's
    // own telemetry unable to answer "how much of my traffic was training".
    withTracer((t) => {
      recordToolCallSpan("book", null, {
        outcome: "ok", turnId: "turn_1", conversationId: "conv_1",
      });
      const a = t.spans[0].attributes;
      assert.equal(a["percepteye.turn.id"], "turn_1");
      assert.equal(a["percepteye.conversation.id"], "conv_1");
      assert.equal("percepteye.rollout.id" in a, false);
    });
  });

  it("truncates a large argument rather than bloating every span", () => {
    withTracer((t) => {
      recordToolCallSpan("x", { blob: "z".repeat(50_000) }, { outcome: "ok" });
      const v = t.spans[0].attributes["gen_ai.tool.call.arguments"];
      assert.ok(v.length <= MAX_ATTRIBUTE_CHARS + "...[truncated]".length);
      assert.ok(v.endsWith("...[truncated]"));
    });
  });
});

describe("turn spans", () => {
  it("is the capture surface a next-state signal is read from", () => {
    withTracer((t) => {
      recordTurnSpan({
        inputText: "book me tuesday", outputText: "booked",
        model: "gpt-x", conversationId: "conv_1", turnId: "turn_2",
      });
      const s = t.spans[0];
      assert.equal(s.name, "chat");
      assert.equal(s.attributes["gen_ai.operation.name"], "chat");
      assert.equal(s.attributes["gen_ai.input.messages"], "book me tuesday");
      assert.equal(s.attributes["gen_ai.output.messages"], "booked");
      assert.equal(s.attributes["gen_ai.request.model"], "gpt-x");
    });
  });

  it("says nothing rather than asserting an empty turn", () => {
    // An empty turn span claims a turn happened and carried no content, which
    // is a different claim from not having been given the content.
    withTracer((t) => {
      recordTurnSpan({ turnId: "turn_3" });
      assert.equal(t.spans.length, 0);
    });
  });

  it("bounds turn content", () => {
    withTracer((t) => {
      recordTurnSpan({ outputText: "y".repeat(MAX_TURN_CHARS + 5000) });
      assert.equal(
        t.spans[0].attributes["gen_ai.output.messages"].length, MAX_TURN_CHARS);
    });
  });
});

describe("absence of the optional dependency", () => {
  it("is a silent no-op, never a throw", () => {
    __resetTracerForTests();
    assert.equal(tracingAvailable(), false);
    // This runs on the customer's own execution path beside the trajectory
    // write. A telemetry failure must cost the span and nothing else.
    recordToolCallSpan("x", { a: 1 }, { outcome: "ok" });
    recordTurnSpan({ inputText: "hi" });
  });
});

describe("parity with the Python SDK", () => {
  const PY = "../../percepteye-agent-flywheel/src/agent_flywheel/tracing.py";

  it("uses the same span names and attribute keys", (t) => {
    if (!existsSync(new URL(PY, import.meta.url))) {
      t.skip("python sdk checkout not present");
      return;
    }
    const py = readFileSync(new URL(PY, import.meta.url), "utf8");
    // Every key this package emits must appear in the Python module. A
    // customer swapping packages must not see their attribute names change.
    for (const key of [
      "gen_ai.operation.name", "gen_ai.tool.name", "gen_ai.tool.call.id",
      "gen_ai.tool.call.arguments", "gen_ai.agent.name",
      "gen_ai.request.model", "gen_ai.input.messages", "gen_ai.output.messages",
      "percepteye.tool.outcome", "percepteye.tool.status_code",
      "percepteye.tool.latency_ms", "percepteye.rollout.id",
      "percepteye.turn.id", "percepteye.conversation.id", "percepteye.task.id",
      "percepteye.agent.execution_sha256",
    ]) {
      assert.ok(py.includes(`"${key}"`), `python sdk is missing ${key}`);
    }
    assert.ok(py.includes('f"execute_tool {name}"'), "tool span name drifted");
    assert.ok(py.includes('start_as_current_span("chat")'), "turn span name drifted");
    assert.ok(py.includes("_MAX_TURN_CHARS = 20_000"), "turn cap drifted");
  });
});

describe("the projection is actually WIRED, not merely present", () => {
  it("a recorded tool call reaches the tracer", async () => {
    // A tracing module nobody calls is a producer with no consumer — the
    // module could be perfect and a customer's export would still carry no
    // gen_ai spans. Python emits from the same call that writes the record;
    // this asserts Node does too.
    const { createRecorder } = await import("../src/record.js");
    const t = fakeTracer();
    __resetTracerForTests(t, { SpanStatusCode: { ERROR: 2 } });
    try {
      const recorder = createRecorder({ writer: { write: () => true } });
      recorder.handle(
        { toolName: "book_appointment", params: { day: "tue" },
          toolCallId: "call_9", result: { id: 7 }, durationMs: 42 },
        { agentId: "scheduler", runId: "scope_1" },
      );
      assert.equal(t.spans.length, 1);
      const a = t.spans[0].attributes;
      assert.equal(a["gen_ai.tool.name"], "book_appointment");
      assert.equal(a["gen_ai.tool.call.id"], "call_9");
      assert.equal(a["percepteye.tool.latency_ms"], 42);
    } finally {
      __resetTracerForTests();
    }
  });

  it("a recorded turn reaches the tracer, which is what next-state needs", async () => {
    const { recordTurnText } = await import("../src/turns.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const t = fakeTracer();
    __resetTracerForTests(t, { SpanStatusCode: { ERROR: 2 } });
    try {
      const dir = join(mkdtempSync(join(tmpdir(), "pe-turns-")), "turn_1");
      recordTurnText(dir, "task", "book me tuesday",
                     { turn_id: "turn_1", conversation_id: "conv_1" });
      recordTurnText(dir, "answer", "booked",
                     { turn_id: "turn_1", conversation_id: "conv_1" });

      assert.equal(t.spans.length, 2);
      // The ASK and the ANSWER land on the convention's two different keys —
      // that ordering is what the ingest reads back as a conversation.
      assert.equal(t.spans[0].attributes["gen_ai.input.messages"], "book me tuesday");
      assert.equal(t.spans[1].attributes["gen_ai.output.messages"], "booked");
      assert.equal(t.spans[0].attributes["percepteye.conversation.id"], "conv_1");
    } finally {
      __resetTracerForTests();
    }
  });

  it("an empty turn writes nothing and emits nothing", async () => {
    const { recordTurnText } = await import("../src/turns.js");
    const t = fakeTracer();
    __resetTracerForTests(t, { SpanStatusCode: { ERROR: 2 } });
    try {
      assert.equal(recordTurnText("/tmp/nope", "answer", "   "), false);
      assert.equal(t.spans.length, 0);
    } finally {
      __resetTracerForTests();
    }
  });
});

// ── the recorder: which ids a tool call is stamped with ─────────────────────

/**
 * One tool call through the recorder, with the mode given to it (`mode`, as
 * the plugin config passes it) and/or set in the environment (`env`;
 * `undefined` unsets it). Returns the span's attributes.
 */
async function recordOne({ mode = null, env, rolloutFor = null, ctx, identity = null }) {
  const { createRecorder } = await import("../src/record.js");
  const prior = process.env.PERCEPTEYE_AGENT_MODE;
  const t = fakeTracer();
  __resetTracerForTests(t, { SpanStatusCode: { ERROR: 2 } });
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
    assert.equal(t.spans.length, 1);
    return t.spans[0].attributes;
  } finally {
    __resetTracerForTests();
    if (prior === undefined) delete process.env.PERCEPTEYE_AGENT_MODE;
    else process.env.PERCEPTEYE_AGENT_MODE = prior;
  }
}

describe("which id a tool call is stamped with", () => {
  /**
   * The bug the two ids exist to prevent: a production turn stamped as a
   * rollout, which makes a customer's own telemetry unable to answer "how
   * much of my traffic was training" — every served turn looks like
   * contributed work, and a consumer that drops self-emitted spans drops
   * every production tool call. Python decides by the scope's kind and
   * stamps the control plane's rollout id; Node must do the same.
   */
  const CTX = { runId: "run_1", sessionKey: "agent:main:slack:c1",
                agentId: "main", taskId: "case-3" };

  it("production traffic from the ENVIRONMENT is a TURN, never a rollout", async () => {
    const a = await recordOne({ env: "production", ctx: { runId: "scope_1" } });
    assert.equal(a["percepteye.turn.id"], "scope_1");
    assert.equal("percepteye.rollout.id" in a, false);
  });

  it("a production mode from the PLUGIN CONFIG is honoured with the env unset", async () => {
    // THE P0 DEFECT: the recorder read only PERCEPTEYE_AGENT_MODE, so with the
    // mode set in the plugin config and the variable unset it fell back to
    // training and stamped the host's run id as a rollout id.
    const a = await recordOne({ mode: "production", env: undefined, ctx: CTX });
    assert.equal("percepteye.rollout.id" in a, false);
    assert.equal(a["percepteye.turn.id"], "run_1");
  });

  it("the plugin config's mode outranks the environment's", async () => {
    const a = await recordOne({ mode: "production", env: "training", ctx: CTX });
    assert.equal("percepteye.rollout.id" in a, false);
    assert.equal(a["percepteye.turn.id"], "run_1");
  });

  it("a production tool call carries its conversation, task and identity", async () => {
    const sha = "b".repeat(64);
    const a = await recordOne({
      mode: "production", ctx: CTX,
      identity: { fingerprintFor: () => ({ execution_sha256: sha }) },
    });
    assert.equal(a["percepteye.conversation.id"], "agent:main:slack:c1");
    assert.equal(a["percepteye.task.id"], "case-3");
    assert.equal(a["percepteye.agent.execution_sha256"], sha);
  });

  it("a training rollout carries the CONTROL PLANE's rollout id, not the run id", async () => {
    const a = await recordOne({
      mode: "training", ctx: CTX,
      identity: { fingerprintFor: () => ({ execution_sha256: "c".repeat(64) }) },
      rolloutFor: (ctx) => (ctx.sessionKey === CTX.sessionKey
        ? { rolloutId: "rl_mc_77" } : null),
    });
    assert.equal(a["percepteye.rollout.id"], "rl_mc_77");
    assert.equal("percepteye.turn.id" in a, false);
    // A rollout carries no production correlation, as in Python's serve().
    assert.equal("percepteye.conversation.id" in a, false);
    assert.equal("percepteye.task.id" in a, false);
    assert.equal("percepteye.agent.execution_sha256" in a, false);
  });

  it("a training install's ordinary session is the customer's own turn", async () => {
    const a = await recordOne({ mode: "training", ctx: CTX, rolloutFor: () => null });
    assert.equal("percepteye.rollout.id" in a, false);
    assert.equal(a["percepteye.turn.id"], "run_1");
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
    __resetTracerForTests(t, { SpanStatusCode: { ERROR: 2 } });
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
      assert.equal(span.attributes["percepteye.conversation.id"], "s1");
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
    __resetTracerForTests(t, { SpanStatusCode: { ERROR: 2 } });
    try {
      const out = plugin.register(api, {
        mode: "training", apiKey: "pefw_test",
        // Refused at once: nothing in this test may reach a real control plane.
        controlPlaneUrl: "http://127.0.0.1:9/api/flywheel/v1",
      }, { PERCEPTEYE_TRAJECTORY_DIR: "" });
      assert.ok(out.rollouts, "the rollout driver was not constructed");
      out.rollouts.track("s1", { rolloutId: "rl_mc_9" });
      try {
        for (const fn of hooks[HOOK_NAME]) {
          fn({ toolName: "book", params: {}, runId: "run_host_1" },
             { runId: "run_host_1", sessionKey: "s1" });
          // The same install's OTHER session holds no rollout: its calls are
          // the customer's own.
          fn({ toolName: "lookup", params: {}, runId: "run_host_2" },
             { runId: "run_host_2", sessionKey: "s2" });
        }
      } finally {
        out.rollouts.inFlight.delete("s1");
      }
      const span = t.spans.find((s) => s.name === "execute_tool book");
      assert.ok(span, "no tool span was emitted");
      assert.equal(span.attributes["percepteye.rollout.id"], "rl_mc_9");
      assert.equal("percepteye.turn.id" in span.attributes, false);
      const other = t.spans.find((s) => s.name === "execute_tool lookup");
      assert.ok(other, "no tool span was emitted for the other session");
      assert.equal("percepteye.rollout.id" in other.attributes, false);
      assert.equal(other.attributes["percepteye.turn.id"], "run_host_2");
    } finally {
      __resetTracerForTests();
    }
  });
});
