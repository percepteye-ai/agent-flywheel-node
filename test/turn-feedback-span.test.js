/**
 * What a user did with a PRODUCTION turn, on that turn's trace. The Python
 * SDK's `tests/test_turn_feedback_on_its_span.py`, case for case.
 *
 * A production turn has no episode for `POST /turn-feedback` to join, so
 * `reportTurnFeedback(signal, { turnId })` puts the feedback where the turn
 * went: the customer's TracerProvider. The turn's span has ended by then, so
 * the event rides a span of its own, linked to the turn's.
 * `test/fixtures/turn_feedback_span.json` is that export, byte for byte the
 * Python SDK's copy (`fixture_parity.test.js`).
 */
import "./support/home.js";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { InvalidFeedback, rfc3339UnixNanos } from "../src/wire.js";
import {
  createTurnCapture, createTurnUploader, reportTurnFeedbackOnItsSpan,
} from "../src/capture.js";
import { __resetTracerForTests, recordTurnSpan } from "../src/tracing.js";

const TURN = "turn-7";
const AT = "2026-11-10T09:00:00.25Z";
const ROOT = Symbol("root context");

/** A tracer that records what it is asked, with sequential ids. */
function fakeTracer() {
  const spans = [];
  let next = 0;
  const open = (name, options = {}, context = undefined) => {
    next += 1;
    const id = next;
    const span = {
      name, attributes: {}, events: [], links: options.links ?? [], context,
      ended: false,
      isRecording: () => true,
      spanContext: () => ({
        traceId: id.toString(16).padStart(32, "0"),
        spanId: id.toString(16).padStart(16, "0"),
      }),
      setAttribute(k, v) { this.attributes[k] = v; },
      setStatus() {},
      addEvent(eventName, attributes, time) {
        this.events.push({ name: eventName, attributes, time });
      },
      end() { this.ended = true; },
    };
    spans.push(span);
    return span;
  };
  return {
    spans,
    startSpan: open,
    startActiveSpan(name, fn) { return fn(open(name)); },
  };
}

function withTracer(fn) {
  const t = fakeTracer();
  __resetTracerForTests(t, { ROOT_CONTEXT: ROOT });
  try { return fn(t); } finally { __resetTracerForTests(); }
}

const value = (v) => (typeof v === "boolean" ? { boolValue: v }
  : Number.isInteger(v) ? { intValue: String(v) }
  : typeof v === "number" ? { doubleValue: v } : { stringValue: String(v) });
const attributes = (attrs) => Object.keys(attrs).sort()
  .map((key) => ({ key, value: value(attrs[key]) }));

/** OTLP/JSON of the recorded spans, as the Python test builds it. */
function otlpJson(spans) {
  const out = spans.map((span, position) => {
    const { traceId, spanId } = span.spanContext();
    const row = {
      traceId, spanId, name: span.name, kind: 1,
      startTimeUnixNano: String(1794301100000000000n + BigInt(position * 2)),
      endTimeUnixNano: String(1794301100000000001n + BigInt(position * 2)),
      attributes: attributes(span.attributes),
    };
    if (span.events.length) {
      row.events = span.events.map((e) => ({
        name: e.name,
        timeUnixNano: String(BigInt(e.time[0]) * 1_000_000_000n + BigInt(e.time[1])),
        attributes: attributes(e.attributes),
      }));
    }
    if (span.links.length) {
      row.links = span.links.map(({ context }) => ({
        traceId: context.traceId, spanId: context.spanId }));
    }
    return row;
  });
  return { resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [
    { scope: { name: "agent-flywheel" }, spans: out }] }] };
}

/** The production turn the Python test serves -- a question, then an answer
 * -- through the capture hooks a host calls, as the Python test goes through
 * `turn()` and `record_answer`: the answer's span names its conversation
 * because the answer path reads the turn's own (`onAgentEnd`). */
function aTurn() {
  const cap = createTurnCapture({
    root: mkdtempSync(join(tmpdir(), "percepteye-span-turn-")) });
  const host = { agentId: "main" };
  cap.onMessageReceived(
    { runId: TURN, content: "where is my order?", sessionKey: "c1" }, host);
  cap.onAgentEnd(
    { runId: TURN, messages: [{ role: "assistant", content: "It ships tomorrow." }] }, host);
}

describe("feedback on a production turn", () => {
  it("is an event on a span linked to its turn's", () => {
    withTracer((t) => {
      aTurn();
      assert.equal(reportTurnFeedbackOnItsSpan("corrected", {
        turnId: TURN, occurredAt: AT, feedbackId: "fb-1" }), "fb-1");
      const [question, answer, feedback] = t.spans;
      assert.equal(feedback.name, "percepteye.turn.feedback");
      assert.equal(feedback.context, ROOT, "a trace of its own");
      assert.deepEqual(feedback.links.map((l) => l.context.spanId),
        [question.spanContext().spanId, answer.spanContext().spanId]);
      assert.equal(feedback.attributes["percepteye.turn.id"], TURN);
      assert.equal(feedback.ended, true);
      const [event] = feedback.events;
      assert.equal(event.name, "percepteye.turn.feedback");
      assert.deepEqual(event.time, [1794301200, 250000000]);
      assert.deepEqual(event.attributes, {
        "percepteye.turn.feedback.signal": "corrected",
        "percepteye.turn.feedback.id": "fb-1" });
    });
  });

  it("exports as the shared fixture", () => {
    withTracer((t) => {
      aTurn();
      reportTurnFeedbackOnItsSpan("corrected", {
        turnId: TURN, occurredAt: AT, feedbackId: "fb-1" });
      const emitted = `${JSON.stringify(otlpJson(t.spans), null, 2)}\n`;
      assert.equal(emitted, readFileSync(
        new URL("./fixtures/turn_feedback_span.json", import.meta.url), "utf8"));
    });
  });

  it("is what reportTurnFeedback does with a turnId, AND queues it for the route", () => {
    // Design 2026-11-21, contract A: a production turn's feedback is uploaded
    // over the SDK's own transport by its turn_id, as well as recorded on its
    // trace. Mutation: skip the queue for a turnId -- red.
    withTracer((t) => {
      const root = mkdtempSync(join(tmpdir(), "percepteye-span-feedback-"));
      const u = createTurnUploader({ transport: {}, agentId: "a1", root });
      aTurn();
      assert.equal(u.reportTurnFeedback("accepted", {
        turnId: TURN, occurredAt: AT, feedbackId: "fb-9" }), "fb-9");
      assert.equal(t.spans.at(-1).name, "percepteye.turn.feedback");
      const queued = readdirSync(root).filter((n) => n.startsWith(".feedback."));
      assert.equal(queued.length, 1);
      assert.deepEqual(JSON.parse(readFileSync(join(root, queued[0]), "utf8")), {
        feedback_id: "fb-9", occurred_at: AT, signal: "accepted", turn_id: TURN,
      });
    });
  });

  it("queues a turnId's feedback with no tracer at all", () => {
    const root = mkdtempSync(join(tmpdir(), "percepteye-span-feedback-"));
    const u = createTurnUploader({ transport: {}, agentId: "a1", root });
    assert.equal(u.reportTurnFeedback("corrected", {
      turnId: TURN, occurredAt: AT, feedbackId: "fb-10" }), "fb-10");
    assert.equal(readdirSync(root).filter((n) => n.startsWith(".feedback.")).length, 1);
  });

  it("names a turn this process never recorded", () => {
    withTracer((t) => {
      assert.notEqual(reportTurnFeedbackOnItsSpan("accepted", {
        turnId: "elsewhere", occurredAt: AT }), null);
      const [span] = t.spans;
      assert.deepEqual(span.links, []);
      assert.equal(span.attributes["percepteye.turn.id"], "elsewhere");
    });
  });

  it("does not link a rollout's turn", () => {
    withTracer((t) => {
      recordTurnSpan({ outputText: "x", turnId: TURN, rolloutId: "rl_1" });
      reportTurnFeedbackOnItsSpan("accepted", { turnId: TURN, occurredAt: AT });
      assert.deepEqual(t.spans.at(-1).links, []);
    });
  });

  it("times the event to the nanosecond the report states", () => {
    assert.equal(rfc3339UnixNanos("2026-11-10T09:00:00.123456789+05:30"),
      1794281400123456789n);
    assert.equal(rfc3339UnixNanos("2026-11-10T09:00:00.1234567891Z"),
      1794301200123456789n);
    assert.equal(rfc3339UnixNanos("0050-01-01T00:00:00Z"), -60589296000000000000n);
  });

  it("records nothing without a tracer", () => {
    __resetTracerForTests(null);
    try {
      assert.equal(reportTurnFeedbackOnItsSpan("accepted", {
        turnId: TURN, occurredAt: AT }), null);
    } finally {
      __resetTracerForTests();
    }
  });

  for (const [options, words] of [
    [{ signal: "liked", turnId: TURN }, /signal must be one of/],
    [{ signal: "accepted", turnId: "../x" }, /turn_id is not a valid/],
    [{ signal: "accepted", turnId: TURN, episodeId: "rl_1", turnIndex: 0 }, /not both/],
    [{ signal: "accepted", turnId: TURN, occurredAt: "2026-11-10" },
      /occurred_at must be an RFC 3339 time/],
  ]) {
    it(`refuses at the call: ${words}`, () => {
      withTracer((t) => {
        const { signal, ...rest } = options;
        assert.throws(() => reportTurnFeedbackOnItsSpan(signal, rest),
          (err) => err instanceof InvalidFeedback && words.test(err.message));
        assert.equal(t.spans.length, 0);
      });
    });
  }
});
