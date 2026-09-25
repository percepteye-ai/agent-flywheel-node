/**
 * The model-boundary renderer, held to the golden BOTH SDKs render.
 *
 * `test/fixtures/genai-capture-golden.json` is a byte-identical copy of the
 * Python SDK's `tests/fixtures/genai_capture_golden.json`. Its `mc_golden_*`
 * vectors carry Mission Control's own golden turns verbatim as the expected
 * traces, so they are an oracle neither renderer produced. The copy is checked
 * against the Python authority here when that checkout sits beside this one,
 * and by the Python repo's cross-language ABI check, which runs both renderers.
 */
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  SCOPE_NAME, contentJson, newSpanId, newTraceId, observationFromLines,
  renderTurnTrace,
} from "../src/genai-otlp.js";

const GOLDEN_URL = new URL("./fixtures/genai-capture-golden.json", import.meta.url);
const GOLDEN_BYTES = readFileSync(GOLDEN_URL);
const GOLDEN = JSON.parse(GOLDEN_BYTES.toString("utf8"));

const spans = (trace) => trace.resourceSpans.flatMap(
  (rs) => rs.scopeSpans.flatMap((ss) => ss.spans));
const attrs = (span) => Object.fromEntries(span.attributes.map((a) => [a.key, a.value]));
const clone = (v) => JSON.parse(JSON.stringify(v));

describe("the golden both SDKs render", () => {
  for (const vector of GOLDEN.vectors) {
    it(`renders ${vector.name}`, () => {
      assert.deepStrictEqual(
        renderTurnTrace(clone(vector.observation), {
          agentName: vector.agent_name, conversationId: vector.conversation_id,
        }),
        vector.genai_trace,
      );
    });
  }

  it("carries Mission Control's three turns and a refusal", () => {
    const names = GOLDEN.vectors.map((v) => v.name);
    assert.deepStrictEqual(names.filter((n) => n.startsWith("mc_golden_")),
      ["mc_golden_turn_0", "mc_golden_turn_1", "mc_golden_turn_2"]);
    assert.ok(GOLDEN.vectors.some((v) => v.genai_trace === null));
    assert.ok(GOLDEN.observation_lines.length);
  });

  it("renders this runtime's own side of the one asymmetry", () => {
    // JavaScript enumerates integer-like keys first and spells 1.0 as 1.
    const a = GOLDEN.runtime_asymmetry;
    const got = renderTurnTrace(clone(a.observation), {
      agentName: a.agent_name, conversationId: a.conversation_id,
    });
    assert.deepStrictEqual(got, a.genai_trace_node);
    assert.notDeepStrictEqual(got, a.genai_trace_python);
  });

  for (const vector of GOLDEN.observation_lines) {
    it(`reads back ${vector.name}`, () => {
      assert.deepStrictEqual(observationFromLines(vector.lines), vector.observation);
    });
  }

  it("is the Python authority's golden, byte for byte", () => {
    const sibling = [
      "../../agent-flywheel/tests/fixtures/genai_capture_golden.json",
      "../../percepteye-agent-flywheel/tests/fixtures/genai_capture_golden.json",
    ].map((rel) => new URL(rel, import.meta.url)).find(existsSync);
    if (!sibling) return;
    assert.ok(readFileSync(sibling).equals(GOLDEN_BYTES),
      "test/fixtures/genai-capture-golden.json is not the Python SDK's golden");
  });
});

function observation(chat = {}) {
  return {
    trace_id: newTraceId(),
    span_id: newSpanId(),
    start_time_unix_nano: "900",
    end_time_unix_nano: "2100",
    operations: [{
      operation: "chat",
      span_id: newSpanId(),
      start_time_unix_nano: "1000",
      end_time_unix_nano: "2000",
      provider_name: "openai",
      request_model: "gpt-4o-mini",
      input_messages: [{ role: "user", parts: [{ type: "text", content: "hi" }] }],
      output_messages: [{
        role: "assistant", parts: [{ type: "text", content: "hello" }],
        finish_reason: "stop",
      }],
      ...chat,
    }],
  };
}

describe("what the intake enforces, as properties", () => {
  it("renders nothing for a turn with no observed model call", () => {
    const obs = observation();
    obs.operations = [];
    assert.equal(renderTurnTrace(obs, { agentName: "a" }), null);
    assert.equal(renderTurnTrace(null, { agentName: "a" }), null);
    assert.equal(renderTurnTrace(observation(), { agentName: "" }), null);
  });

  it("skips a model call with no provider or requested model", () => {
    // The conventions REQUIRE both on an inference span.
    for (const missing of ["provider_name", "request_model"]) {
      const obs = observation();
      delete obs.operations[0][missing];
      assert.equal(renderTurnTrace(obs, { agentName: "a" }), null, missing);
    }
  });

  it("never truncates a megabyte message", () => {
    const big = "x".repeat(1 << 20) + "é\u{1f4e6}";
    const trace = renderTurnTrace(observation({
      input_messages: [{ role: "user", parts: [{ type: "text", content: big }] }],
    }), { agentName: "a" });
    const sent = JSON.parse(attrs(spans(trace)[1])["gen_ai.input.messages"].stringValue);
    assert.equal(sent[0].parts[0].content, big);
  });

  it("never marks a decision or claims to be training traffic", () => {
    const trace = renderTurnTrace(observation(), { agentName: "a", conversationId: "c" });
    const keys = spans(trace).flatMap((s) => Object.keys(attrs(s)));
    assert.deepStrictEqual(keys.filter((k) => k.startsWith("percepteye.")), []);
    assert.deepStrictEqual(trace.resourceSpans[0].scopeSpans[0].scope, { name: SCOPE_NAME });
  });

  it("puts exactly the turn's conversation on every span, and none without one", () => {
    const obs = GOLDEN.vectors[0].observation;
    const trace = renderTurnTrace(obs, { agentName: "a", conversationId: "conv-7" });
    assert.deepStrictEqual(
      [...new Set(spans(trace).map((s) => attrs(s)["gen_ai.conversation.id"].stringValue))],
      ["conv-7"]);
    const bare = renderTurnTrace(obs, { agentName: "a" });
    assert.ok(spans(bare).every((s) => !("gen_ai.conversation.id" in attrs(s))));
  });

  it("records an error as a status and a type, never as a result", () => {
    const obs = observation();
    obs.operations.push({
      operation: "execute_tool", span_id: newSpanId(),
      start_time_unix_nano: "2001", end_time_unix_nano: "2002",
      tool_name: "t", arguments: {}, result: "should not appear", error_type: "Error",
    });
    const tool = spans(renderTurnTrace(obs, { agentName: "a" })).at(-1);
    assert.deepStrictEqual(tool.status, { code: 2 });
    assert.deepStrictEqual(attrs(tool)["error.type"], { stringValue: "Error" });
    assert.ok(!("gen_ai.tool.call.result" in attrs(tool)));
  });

  it("writes content as compact JSON in the value's own order", () => {
    assert.equal(contentJson({ b: 1, a: [null, true, "é"] }),
      '{"b":1,"a":[null,true,"é"]}');
  });

  it("mints the OTLP id encodings", () => {
    for (let i = 0; i < 64; i += 1) {
      assert.match(newTraceId(), /^[0-9a-f]{32}$/);
      assert.match(newSpanId(), /^[0-9a-f]{16}$/);
    }
  });
});
