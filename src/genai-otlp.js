/**
 * One production turn's model boundary, rendered as a real OTel GenAI trace.
 *
 * THE NODE HALF OF ONE CONTRACT. The Python SDK's `agent_flywheel/genai_otlp.py`
 * is the other half, and the two are held to the SAME bytes for the same
 * observation by a golden file both suites read
 * (`test/fixtures/genai-capture-golden.json`, a byte-identical copy of the
 * Python repo's `tests/fixtures/genai_capture_golden.json`) and by the Python
 * repo's `scripts/cross_language_abi_check.sh`, which runs both renderers and
 * compares what they wrote. A comment asking the two to agree would not be a
 * mechanism; that is.
 *
 * WHAT THIS IS. When production capture observes the agent's MODEL BOUNDARY
 * during a turn -- the exact messages a model call was sent, the system
 * instructions, the tool definitions it was offered, what it answered, and
 * what each tool it asked for returned -- that observation is written beside
 * the turn (`OBSERVATION_FILENAME`). This module turns it into ONE OTLP/JSON
 * `ExportTraceServiceRequest`: an `invoke_agent` root with one `chat` span per
 * model call and one `execute_tool` span per tool call, content per the GenAI
 * semantic conventions. That is what the turn upload carries as `genai_trace`.
 *
 * THE RENDERER AND THE READER ARE PURE: values in, values out. No clock, no
 * randomness, no filesystem. (`newTraceId`, `newSpanId` and `nowUnixNano` are
 * the writer's helpers, kept here so the id and clock encodings live beside
 * the one reader that checks them.)
 *
 * WHAT IT NEVER DOES:
 *
 *   - truncate. A prompt cut short is a prompt the model never saw;
 *   - invent content. A turn with no observed model call renders to `null`,
 *     never to a trace rebuilt from the turn's text fields;
 *   - mark a decision or stamp `percepteye.rollout.id`. A production turn is
 *     the customer's own traffic, and a span carrying that id is dropped
 *     downstream as our training traffic.
 *
 * ONE ENCODING FOR CONTENT: compact JSON in the value's own key order, the
 * order this runtime would have serialized to the model. The one thing the two
 * runtimes cannot share is the order of integer-like object keys (JavaScript
 * enumerates them first) and the spelling of an integral float (`1` here,
 * `1.0` in Python). Each SDK renders its own runtime's form, and the golden
 * file pins that divergence as a vector of its own.
 *
 * Zero dependencies.
 */

import { randomBytes } from "node:crypto";

/** Where a turn directory keeps its observed model boundary, one record per line. */
export const OBSERVATION_FILENAME = "genai_observation.jsonl";

/** The instrumentation scope every rendered trace names. */
export const SCOPE_NAME = "percepteye.agent_flywheel";

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const DECIMAL = /^[0-9]+$/;

// OTLP/JSON SpanKind integers: INTERNAL for the agent and a tool execution,
// CLIENT for a request to a model provider.
const INTERNAL = 1;
const CLIENT = 3;
// OTLP Status.StatusCode ERROR, set only when an operation ended in an error.
const STATUS_ERROR = 2;

/** A content value as the JSON string carried on the span. */
export function contentJson(value) {
  return JSON.stringify(value);
}

/** Wall-clock nanoseconds as a decimal string (the value exceeds 2**53). */
export function nowUnixNano() {
  return (BigInt(Date.now()) * 1000000n).toString();
}

function randomHex(nBytes) {
  for (;;) {
    const value = randomBytes(nBytes).toString("hex");
    // The all-zero id is INVALID in OTLP; vanishingly rare, never emitted.
    if (/[^0]/.test(value)) return value;
  }
}

/** A fresh OTLP trace id: 32 lowercase hex, never all zeros. */
export function newTraceId() {
  return randomHex(16);
}

/** A fresh OTLP span id: 16 lowercase hex, never all zeros. */
export function newSpanId() {
  return randomHex(8);
}

function isId(value, pattern) {
  return typeof value === "string" && pattern.test(value) && /[^0]/.test(value);
}

function nanos(value) {
  return typeof value === "string" && DECIMAL.test(value) ? value : null;
}

function text(value) {
  return typeof value === "string" && value ? value : null;
}

const s = (value) => ({ stringValue: value });
const attr = (key, value) => ({ key, value });
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function finishSpan(op, attrs, { traceId, spanId, parent, name, kind, start, end }) {
  const errorType = text(op.error_type);
  if (errorType) attrs.push(attr("error.type", s(errorType)));
  return {
    traceId,
    spanId,
    parentSpanId: parent,
    name,
    kind,
    startTimeUnixNano: start,
    endTimeUnixNano: end,
    attributes: attrs,
    status: errorType ? { code: STATUS_ERROR } : {},
  };
}

function chatSpan(op, { traceId, parent, conversationId }) {
  const spanId = op.span_id;
  const start = nanos(op.start_time_unix_nano);
  const end = nanos(op.end_time_unix_nano);
  const provider = text(op.provider_name);
  // The conventions REQUIRE the provider and the requested model on an
  // inference span; a call observed without either is skipped rather than
  // rendered as a span the published standard does not recognise.
  const requestModel = text(op.request_model);
  const inputs = op.input_messages;
  if (!isId(spanId, HEX16) || !start || !end || !provider || !requestModel
      || !Array.isArray(inputs)) {
    return null;
  }
  const attrs = [
    attr("gen_ai.operation.name", s("chat")),
    attr("gen_ai.provider.name", s(provider)),
    attr("gen_ai.request.model", s(requestModel)),
  ];
  const responseModel = text(op.response_model);
  if (responseModel) attrs.push(attr("gen_ai.response.model", s(responseModel)));
  if (conversationId) attrs.push(attr("gen_ai.conversation.id", s(conversationId)));
  const finish = op.finish_reasons;
  if (Array.isArray(finish) && finish.length
      && finish.every((f) => typeof f === "string")) {
    attrs.push(attr("gen_ai.response.finish_reasons", {
      arrayValue: { values: finish.map((f) => s(f)) },
    }));
  }
  const system = op.system_instructions;
  if (Array.isArray(system) && system.length) {
    attrs.push(attr("gen_ai.system_instructions", s(contentJson(system))));
  }
  attrs.push(attr("gen_ai.input.messages", s(contentJson(inputs))));
  const outputs = op.output_messages;
  if (Array.isArray(outputs) && outputs.length) {
    attrs.push(attr("gen_ai.output.messages", s(contentJson(outputs))));
  }
  const tools = op.tool_definitions;
  if (Array.isArray(tools) && tools.length) {
    attrs.push(attr("gen_ai.tool.definitions", s(contentJson(tools))));
  }
  return finishSpan(op, attrs, {
    traceId, spanId, parent, name: `chat ${requestModel}`, kind: CLIENT, start, end,
  });
}

function toolSpan(op, { traceId, parent, conversationId, agentName }) {
  const spanId = op.span_id;
  const start = nanos(op.start_time_unix_nano);
  const end = nanos(op.end_time_unix_nano);
  const name = text(op.tool_name);
  if (!isId(spanId, HEX16) || !start || !end || !name) return null;
  const attrs = [
    attr("gen_ai.operation.name", s("execute_tool")),
    attr("gen_ai.tool.name", s(name)),
  ];
  const toolType = text(op.tool_type);
  if (toolType) attrs.push(attr("gen_ai.tool.type", s(toolType)));
  const callId = text(op.tool_call_id);
  if (callId) attrs.push(attr("gen_ai.tool.call.id", s(callId)));
  if (has(op, "arguments")) {
    attrs.push(attr("gen_ai.tool.call.arguments", s(contentJson(op.arguments))));
  }
  // A result and an error are exclusive: an execution that raised returned
  // nothing, and recording both would say it did.
  if (has(op, "result") && !text(op.error_type)) {
    attrs.push(attr("gen_ai.tool.call.result", s(contentJson(op.result))));
  }
  if (conversationId) attrs.push(attr("gen_ai.conversation.id", s(conversationId)));
  attrs.push(attr("gen_ai.agent.name", s(agentName)));
  return finishSpan(op, attrs, {
    traceId, spanId, parent, name: `execute_tool ${name}`,
    kind: INTERNAL, start, end,
  });
}

/**
 * The turn's OTLP/JSON `ExportTraceServiceRequest`, or `null`.
 *
 * `null` when nothing was observed at a model call. See the Python
 * `render_turn_trace`, whose rules this is: the same skip-never-guess rule for
 * an operation it cannot encode, the same root, the same attribute order.
 */
export function renderTurnTrace(observation, { agentName, conversationId = null } = {}) {
  if (!isObject(observation) || !text(agentName)) return null;
  const traceId = observation.trace_id;
  const rootId = observation.span_id;
  const start = nanos(observation.start_time_unix_nano);
  const end = nanos(observation.end_time_unix_nano);
  const operations = observation.operations;
  if (!isId(traceId, HEX32) || !isId(rootId, HEX16) || !start || !end
      || !Array.isArray(operations)) {
    return null;
  }
  const conversation = text(conversationId);
  const children = [];
  let provider = null;
  for (const op of operations) {
    if (!isObject(op)) continue;
    let span = null;
    if (op.operation === "chat") {
      span = chatSpan(op, { traceId, parent: rootId, conversationId: conversation });
      if (span !== null && provider === null) provider = op.provider_name;
    } else if (op.operation === "execute_tool") {
      span = toolSpan(op, {
        traceId, parent: rootId, conversationId: conversation, agentName,
      });
    }
    if (span !== null) children.push(span);
  }
  if (provider === null) return null;
  const rootAttrs = [
    attr("gen_ai.operation.name", s("invoke_agent")),
    attr("gen_ai.provider.name", s(provider)),
    attr("gen_ai.agent.name", s(agentName)),
  ];
  if (conversation) rootAttrs.push(attr("gen_ai.conversation.id", s(conversation)));
  const root = {
    traceId,
    spanId: rootId,
    name: `invoke_agent ${agentName}`,
    kind: INTERNAL,
    startTimeUnixNano: start,
    endTimeUnixNano: end,
    attributes: rootAttrs,
    status: {},
  };
  return {
    resourceSpans: [{
      resource: { attributes: [attr("service.name", s(agentName))] },
      scopeSpans: [{ scope: { name: SCOPE_NAME }, spans: [root, ...children] }],
    }],
  };
}

function record(line) {
  try {
    const value = JSON.parse(line);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The observation one turn directory's `OBSERVATION_FILENAME` holds.
 *
 * The same three records and the same rules as the Python
 * `observation_from_lines`: the first `trace` record names the trace,
 * operations are ordered by start with append order breaking ties, the root
 * covers the turn and every operation, and a line that does not parse is
 * skipped. Deterministic in the file's bytes, so a retried upload of the same
 * turn carries the same trace.
 */
export function observationFromLines(lines) {
  let header = null;
  const ops = [];
  const ends = [];
  lines.forEach((line, position) => {
    if (typeof line !== "string" || !line.trim()) return;
    const rec = record(line);
    if (rec === null) return;
    if (rec.record === "trace" && header === null) {
      if (isId(rec.trace_id, HEX32) && isId(rec.span_id, HEX16)
          && nanos(rec.start_time_unix_nano)) {
        header = rec;
      }
    } else if (rec.record === "operation") {
      const start = nanos(rec.start_time_unix_nano);
      const end = nanos(rec.end_time_unix_nano);
      if (start && end) {
        const { record: _drop, ...op } = rec;
        ops.push({ start: BigInt(start), position, op });
        ends.push(BigInt(end));
      }
    } else if (rec.record === "end") {
      const end = nanos(rec.end_time_unix_nano);
      if (end) ends.push(BigInt(end));
    }
  });
  if (header === null || ops.length === 0) return null;
  ops.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1
    : a.position - b.position));
  const headerStart = BigInt(header.start_time_unix_nano);
  const start = headerStart < ops[0].start ? headerStart : ops[0].start;
  let end = start;
  for (const e of ends) if (e > end) end = e;
  return {
    trace_id: header.trace_id,
    span_id: header.span_id,
    start_time_unix_nano: start.toString(),
    end_time_unix_nano: end.toString(),
    operations: ops.map((o) => o.op),
  };
}

/** The `trace` line, as written. */
export function traceRecord({ traceId, spanId, start }) {
  return contentJson({
    record: "trace", trace_id: traceId, span_id: spanId, start_time_unix_nano: start,
  });
}

/** One `operation` line, as written. */
export function operationRecord(op) {
  return contentJson({ record: "operation", ...op });
}

/** The `end` line, as written. */
export function endRecord(end) {
  return contentJson({ record: "end", end_time_unix_nano: end });
}
