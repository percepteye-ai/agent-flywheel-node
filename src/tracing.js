/**
 * OpenTelemetry egress: OTel GenAI spans, rendered to the published standard.
 *
 * WHAT "THE STANDARD" MEANS HERE. The GenAI semantic conventions at
 * `open-telemetry/semantic-conventions-genai@8ffdf568e1`: span names, kinds
 * and attributes from its `spans.yaml`/`registry.yaml`, and every content
 * attribute (`gen_ai.input.messages`, `gen_ai.output.messages`,
 * `gen_ai.system_instructions`, `gen_ai.tool.call.arguments`,
 * `gen_ai.tool.call.result`) in the shape its JSON schemas define. Content is
 * written as a JSON STRING, which the convention permits on spans and which is
 * what its own reference instrumentations write.
 *
 * PARITY WITH THE PYTHON SDK'S `agent_flywheel/tracing.py` IS A TEST, NOT A
 * PROMISE. A customer deploys this package or the pip one, never both, so the
 * two must emit the same spans for the same facts. Both repositories carry the
 * same golden fixture (`test/fixtures/genai-golden.json` here,
 * `tests/fixtures/genai-golden.json` there, byte-identical): a scripted
 * scenario and the exact spans it must produce, content JSON included. Each
 * SDK renders the scenario and must match it byte for byte; the Python side
 * also validates every content value against the convention's own schemas.
 *
 * TWO SPANS, both INTERNAL:
 *
 *   execute_tool {tool}   one per recorded tool call, with its real start and
 *                         end, its arguments and (on success) its result as
 *                         objects, and `error.type` plus ERROR on a reported
 *                         failure.
 *   invoke_agent {agent}  one per TURN, carrying the whole turn: the system
 *                         instructions, the history the agent was given and
 *                         the answer it returned. It replaced two half-turn
 *                         `chat` spans, which described neither half as what
 *                         it was -- no model call happened on either.
 *
 * NOTHING IS CUT. There is no size limit on any attribute: a cut at a fixed
 * character count turned a JSON argument into invalid JSON, and on this side
 * of the SDK sliced by UTF-16 code units, so it could also split a surrogate
 * pair. A customer who needs a bound sets one in their own exporter or
 * collector, where it applies to every instrumentation alike.
 *
 * **The turn span is OPT-IN; tool spans are not.** A tool name and an outcome
 * are telemetry; a prompt and a completion are the user's own words, so only
 * text the customer handed over reaches a turn span.
 *
 * **We never install a TracerProvider.** Registering one is once-only: the
 * second caller gets a log line, not an exception. So calling it would either
 * lose all our spans (if the customer configured theirs first) or silently
 * kill the customer's entire GenAI telemetry (if we won). We take whatever
 * provider is already registered and emit into it. With none configured, the
 * API's no-op tracer swallows everything, which is the correct outcome for a
 * library.
 *
 * `percepteye.*` carries what the convention has no word for -- notably the
 * tri-state outcome. The convention cannot say "this tool call's result was
 * never observed", so the projection is documented as lossy rather than bent
 * into a standard attribute that means something else to every consumer.
 */
import { createRequire } from "node:module";

//: Resolved once. ``null`` means the OTel API is not installed, which is the
//: normal case: it is an optional peer dependency and this package ships with
//: no runtime dependencies.
let _tracer = null;
let _resolved = false;
let _api = null;

/**
 * The customer's tracer, or null. NEVER constructs a provider.
 *
 * Resolved with ``createRequire`` rather than a dynamic ``import()`` so this
 * stays SYNCHRONOUS. The Python entry points return nothing and block nothing;
 * an async Node twin would force every call site to differ, and the two
 * packages are supposed to be swappable.
 */
function tracer() {
  if (_resolved) return _tracer;
  _resolved = true;
  try {
    const require = createRequire(import.meta.url);
    _api = require("@opentelemetry/api");
    // getTracer ONLY. No SDK import, no provider construction, no
    // setGlobalTracerProvider — see the module docstring.
    _tracer = _api.trace.getTracer("agent-flywheel");
  } catch {
    _api = null;
    _tracer = null;
  }
  return _tracer;
}

/**
 * True when the OTel API is importable. Says NOTHING about whether the
 * customer configured a provider — with none, spans go to a no-op.
 */
export function tracingAvailable() {
  return tracer() !== null;
}

/**
 * A content attribute's value: the JSON text of `value`, or null when it has
 * none (undefined, a function, a BigInt, a cycle).
 *
 * `JSON.stringify` with no spacing. Python writes the same bytes with
 * `separators=(",", ":")` and `ensure_ascii=False`; the golden fixture is what
 * holds the two to it.
 */
function genaiJson(value) {
  try {
    const out = JSON.stringify(value);
    return typeof out === "string" ? out : null;
  } catch {
    return null;
  }
}

/** Integer literals a JavaScript number cannot hold exactly. */
const LOSSY_INTEGER = /^-?\d+$/;

/**
 * `value` as a JSON object, or null.
 *
 * The convention expects tool arguments and results to be OBJECTS, and says a
 * serialized string SHOULD be deserialized on a best-effort basis. So a string
 * is parsed -- but a string holding an integer beyond +/-(2^53 - 1) is left as
 * it is: parsing it here would silently change the number, and Python, which
 * could hold it, refuses the same input so the two SDKs agree.
 */
function asObject(value) {
  let v = value;
  if (typeof v === "string") {
    let lossy = false;
    try {
      v = JSON.parse(v, (_key, parsed, context) => {
        if (typeof parsed === "number" && !Number.isSafeInteger(parsed)
            && typeof context?.source === "string"
            && LOSSY_INTEGER.test(context.source)) {
          lossy = true;
        }
        return parsed;
      });
    } catch {
      return null;
    }
    if (lossy) return null;
  }
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
}

/**
 * Messages in the convention's shape, ready to serialize.
 *
 * Callers hand over `{role, parts, ...}` objects already -- the host adapter
 * (`host.js`) builds them from the host's own transcript. The one thing done
 * here is the convention's best-effort rule for a `tool_call` part whose
 * `arguments` arrived as a JSON string (the OpenAI wire form): it becomes the
 * object it encodes. Everything else is carried exactly as given, `null`
 * included -- a tool response's `null` is data.
 */
function genaiMessages(messages) {
  if (!Array.isArray(messages)) return null;
  return messages.map((m) => {
    if (!m || typeof m !== "object" || !Array.isArray(m.parts)) return m;
    return {
      ...m,
      parts: m.parts.map((p) => {
        if (p && typeof p === "object" && p.type === "tool_call"
            && typeof p.arguments === "string") {
          const obj = asObject(p.arguments);
          if (obj !== null) return { ...p, arguments: obj };
        }
        return p;
      }),
    };
  });
}

/** One user or assistant text message, the shape a bare string becomes. */
function textMessage(role, text) {
  return { role, parts: [{ type: "text", content: String(text) }] };
}

function markError(span, message) {
  try {
    // SpanStatusCode.ERROR === 2. Read from the API when present so a future
    // renumbering cannot silently invert the verdict.
    const code = _api?.SpanStatusCode?.ERROR ?? 2;
    span.setStatus({ code, message: String(message) });
  } catch {
    // Older/partial API surfaces: `error.type` still carries the verdict.
  }
}

function setIf(span, key, value) {
  if (value === undefined || value === null || value === "") return;
  span.setAttribute(key, value);
}

/** The value, or null when it is not a usable number. */
function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * `gen_ai.conversation.id` AND `percepteye.conversation.id`, the same value.
 *
 * The first is the convention's name and what any consumer reads; the second
 * is this SDK's earlier spelling, kept for one release so a consumer reading
 * it keeps working while it moves.
 */
function setConversation(span, conversationId) {
  if (!conversationId) return;
  span.setAttribute("gen_ai.conversation.id", String(conversationId));
  span.setAttribute("percepteye.conversation.id", String(conversationId));
}

/**
 * The attributes both span kinds carry for correlation.
 *
 * `rolloutId` is stamped only on work that IS a rollout; a production turn
 * carries `percepteye.turn.id` and no rollout id, so a consumer counting "how
 * much of my traffic was training" is not told every served turn was.
 */
function setCorrelation(span, { rolloutId, turnId, conversationId, taskId,
                                 executionSha256 }) {
  setConversation(span, conversationId);
  setIf(span, "percepteye.rollout.id", rolloutId && String(rolloutId));
  setIf(span, "percepteye.turn.id", turnId && String(turnId));
  // Caller-authored correlation evidence only. Asserts no success, no policy
  // identity and no training eligibility.
  setIf(span, "percepteye.task.id", taskId && String(taskId));
  setIf(span, "percepteye.agent.execution_sha256",
        executionSha256 && String(executionSha256));
}

/**
 * `error.type` for a reported failure: the error's class when one was
 * classified, else the status code, else the convention's `_OTHER`.
 */
function errorType(errorClass, statusCode) {
  if (typeof errorClass === "string" && errorClass.trim()) return errorClass;
  if (statusCode !== null && statusCode !== undefined) return String(statusCode);
  return "_OTHER";
}

/**
 * Project one recorded tool call into the customer's traces as an
 * `execute_tool {name}` span.
 *
 * Its END is `endTimeMs` (default: now -- it is recorded when the call
 * returns) and its START is `latencyMs` before that, so the span covers the
 * call rather than the instant it was written down.
 *
 * A no-op when the API is absent, and it NEVER throws: this runs beside the
 * trajectory write on the customer's own execution path, and a telemetry
 * failure must cost us the span and nothing else.
 */
export function recordToolCallSpan(name, args, opts = {}) {
  const t = tracer();
  if (t === null) return;
  const {
    outcome,
    statusCode = null,
    error = null,
    errorClass = null,
    latencyMs = null,
    endTimeMs = null,
    agentName = null,
    rolloutId = null,
    turnId = null,
    conversationId = null,
    taskId = null,
    toolCallId = null,
    executionSha256 = null,
    result = undefined,
  } = opts;
  try {
    const end = finite(endTimeMs) ?? Date.now();
    const latency = finite(latencyMs);
    const start = latency !== null && latency >= 0 ? end - latency : end;
    // The attributes a sampler may decide on go in at CREATION, as the
    // convention asks: operation, tool name, tool type, agent.
    const attributes = {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": String(name),
      // A client-side function the agent's own process ran.
      "gen_ai.tool.type": "function",
    };
    if (agentName) attributes["gen_ai.agent.name"] = String(agentName);
    const span = t.startSpan(`execute_tool ${name}`, {
      kind: _api?.SpanKind?.INTERNAL ?? 0,
      attributes,
      startTime: start,
    });
    try {
      if (typeof span.isRecording === "function" && !span.isRecording()) return;
      // The model-assigned call id: the same value that reappears on the
      // tool response the model is sent next, so it joins the two.
      setIf(span, "gen_ai.tool.call.id", toolCallId && String(toolCallId));
      const argsObject = asObject(args);
      if (argsObject !== null) {
        setIf(span, "gen_ai.tool.call.arguments", genaiJson(argsObject));
      }
      // The result only when execution succeeded, and only as the object the
      // convention's schema requires; a text result reaches the next model
      // call as a tool response, not here.
      if (outcome !== "failed") {
        const resultObject = asObject(result);
        if (resultObject !== null) {
          setIf(span, "gen_ai.tool.call.result", genaiJson(resultObject));
        }
      }

      span.setAttribute("percepteye.tool.outcome", String(outcome));
      if (statusCode !== null && statusCode !== undefined) {
        span.setAttribute("percepteye.tool.status_code", Number(statusCode));
      }
      if (latency !== null) span.setAttribute("percepteye.tool.latency_ms", latency);
      setCorrelation(span, {
        rolloutId, turnId, conversationId, taskId, executionSha256,
      });

      // Only a REPORTED failure sets the span to error. An `unknown` outcome
      // leaves the status unset: marking it OK would assert a success nobody
      // observed, and ERROR a failure nobody observed.
      if (outcome === "failed") {
        span.setAttribute("error.type", errorType(errorClass, statusCode));
        markError(span, error || "tool call failed");
      }
    } finally {
      try { span.end(end); } catch { /* nothing left to do */ }
    }
  } catch {
    /* telemetry must never cost the caller anything */
  }
}

/**
 * Emit one `invoke_agent {agent}` span carrying one whole TURN.
 *
 * THE CAPTURE SURFACE. SFT wants the messages; OPSD wants them plus a
 * privileged reference; RAFT wants them plus a reward and a proven success;
 * DPO wants two of them to pair. None reads a sampled logprob, which is why a
 * span suffices here.
 *
 * Content, all optional, in the convention's shapes:
 *
 *   systemInstructions  `[{type:"text", content}]`
 *   inputMessages       the history the agent was given, in order
 *   outputMessages      what it returned, one message per choice; a
 *                       `finish_reason` on each is also collected into
 *                       `gen_ai.response.finish_reasons`
 *   inputText/outputText  a bare string for either side, when that is all the
 *                       caller has; messages win when both are given
 *
 * `error` marks a turn the host reported as failed: `error.type` `_OTHER` and
 * ERROR status, since a failed invocation left UNSET claims it ran cleanly.
 *
 * With no content at all nothing is emitted: an empty turn span would assert
 * a turn happened and carried nothing, which is a different claim from not
 * having been given it.
 */
export function recordTurnSpan(opts = {}) {
  const {
    systemInstructions = null,
    inputMessages = null,
    outputMessages = null,
    inputText = null,
    outputText = null,
    turnId = null,
    conversationId = null,
    taskId = null,
    agentName = null,
    model = null,
    rolloutId = null,
    executionSha256 = null,
    startTimeMs = null,
    endTimeMs = null,
    error = null,
  } = opts;
  const input = genaiMessages(inputMessages)
    ?? (inputText ? [textMessage("user", inputText)] : null);
  const output = genaiMessages(outputMessages)
    ?? (outputText ? [textMessage("assistant", outputText)] : null);
  const system = Array.isArray(systemInstructions) && systemInstructions.length
    ? systemInstructions : null;
  if (!input?.length && !output?.length && !system) return;
  const t = tracer();
  if (t === null) return;
  try {
    const end = finite(endTimeMs) ?? Date.now();
    const begun = finite(startTimeMs);
    const start = begun !== null && begun <= end ? begun : end;
    const attributes = { "gen_ai.operation.name": "invoke_agent" };
    if (agentName) attributes["gen_ai.agent.name"] = String(agentName);
    const span = t.startSpan(
      agentName ? `invoke_agent ${agentName}` : "invoke_agent",
      { kind: _api?.SpanKind?.INTERNAL ?? 0, attributes, startTime: start },
    );
    try {
      if (typeof span.isRecording === "function" && !span.isRecording()) return;
      setIf(span, "gen_ai.request.model", model && String(model));
      if (system) setIf(span, "gen_ai.system_instructions", genaiJson(system));
      if (input?.length) setIf(span, "gen_ai.input.messages", genaiJson(input));
      if (output?.length) {
        setIf(span, "gen_ai.output.messages", genaiJson(output));
        // One reason per returned message, and only when every message has
        // one: a partial list would misalign reasons with messages.
        const reasons = output.map((m) => m?.finish_reason);
        if (reasons.every((r) => typeof r === "string" && r)) {
          span.setAttribute("gen_ai.response.finish_reasons", reasons);
        }
      }
      setCorrelation(span, {
        rolloutId, turnId, conversationId, taskId, executionSha256,
      });
      if (error) {
        span.setAttribute("error.type", "_OTHER");
        markError(span, error);
      }
    } finally {
      try { span.end(end); } catch { /* nothing left to do */ }
    }
  } catch {
    /* telemetry must never cost the caller anything */
  }
}

/** Test seam: forget the resolved tracer so a suite can install a fake. */
export function __resetTracerForTests(fake = undefined, api = undefined) {
  _tracer = fake ?? null;
  _api = api ?? null;
  _resolved = fake !== undefined;
}
