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
import { readFileSync, existsSync } from "node:fs";

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

describe("which id a tool call is stamped with", () => {
  /**
   * The bug the two ids exist to prevent: a production turn stamped as a
   * rollout, which makes a customer's own telemetry unable to answer "how
   * much of my traffic was training" — every served turn looks like
   * contributed work. Python guards it by REQUIRING the kind rather than
   * defaulting it; Node resolves it from the mode, so the mode must be
   * pinned here or the same defect reappears with a green suite.
   */
  async function spanFor(mode) {
    const { createRecorder } = await import("../src/record.js");
    const prior = process.env.PERCEPTEYE_AGENT_MODE;
    const t = fakeTracer();
    __resetTracerForTests(t, { SpanStatusCode: { ERROR: 2 } });
    process.env.PERCEPTEYE_AGENT_MODE = mode;
    try {
      createRecorder({ writer: { write: () => true } }).handle(
        { toolName: "book", params: {}, result: {} }, { runId: "scope_1" },
      );
      return t.spans[0].attributes;
    } finally {
      __resetTracerForTests();
      if (prior === undefined) delete process.env.PERCEPTEYE_AGENT_MODE;
      else process.env.PERCEPTEYE_AGENT_MODE = prior;
    }
  }

  it("production traffic is a TURN, never a rollout", async () => {
    const a = await spanFor("production");
    assert.equal(a["percepteye.turn.id"], "scope_1");
    assert.equal("percepteye.rollout.id" in a, false);
  });

  it("training traffic is a ROLLOUT, never a turn", async () => {
    const a = await spanFor("training");
    assert.equal(a["percepteye.rollout.id"], "scope_1");
    assert.equal("percepteye.turn.id" in a, false);
  });
});
