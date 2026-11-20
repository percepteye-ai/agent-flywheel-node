/**
 * OpenTelemetry egress: a projection out, never a source in.
 *
 * PARITY WITH THE PYTHON SDK'S ``agent_flywheel/tracing.py``. A customer
 * deploys this package or the pip one, never both, and the promise is that
 * they behave identically — so the span names, the attribute keys and the
 * truncation limits here are the same values, asserted by the test suite
 * rather than kept in step by a comment. Python had this module and Node had
 * nothing, which meant a Node customer's agent emitted no ``gen_ai.*``
 * telemetry at all: the trace ingest's agent lane selects INTERNAL/CLIENT spans
 * carrying a ``gen_ai.*`` attribute, so their traces produced zero agent
 * records, no conversation, and therefore no next-state signal for the
 * per-step reward model to vote on.
 *
 * Tool outcomes already land in the append-only trajectory, which is what the
 * control plane grades. This emits them as spans additionally, so they show up
 * in whatever the customer already runs — Datadog, Phoenix, Grafana —
 * alongside the rest of their agent's telemetry.
 *
 * **Tool spans are egress only. THE TURN SPAN IS NOT.** A tool name and an
 * outcome are telemetry; a prompt and a completion are the user's own words.
 * So ``recordTurnSpan`` is only ever called with the turn text the host handed
 * the plugin (the user's message, the answer), and it reaches nothing unless
 * the customer installed the OTel API and registered a provider of their own:
 * it is the documented capture surface for the trace-ingestion lane, and the
 * customer's exporter is where it goes. Every text attribute either span
 * carries has the Flywheel keys in it redacted first (``redactKeys``), the
 * rule every body this package sends follows. What production
 * capture observes at the model boundary under the model-content consent tier
 * never reaches the customer's TracerProvider: it goes to the control plane as
 * the turn's ``genai_trace`` (see ``genai-otlp.js``).
 *
 * **We never install a TracerProvider.** Registering one is once-only: the
 * second caller gets a log line, not an exception. So calling it would either
 * lose all our spans (if the customer configured theirs first) or silently
 * kill the customer's entire GenAI telemetry (if we won). We take whatever
 * provider is already registered and emit into it. With none configured, the
 * API's no-op tracer swallows everything, which is the correct outcome for a
 * library.
 *
 * Attributes follow ``gen_ai.*`` where the convention has a name for
 * something, and ``percepteye.*`` where it does not — which notably includes
 * the tri-state outcome. The convention has no way to say "this tool call's
 * result was never observed", so the projection is documented as lossy rather
 * than bent into a standard attribute that means something else to every other
 * consumer.
 */
import { createRequire } from "node:module";

import { redactKeys } from "./http.js";

/** Attribute payload cap. Attributes are telemetry, not payloads. */
export const MAX_ATTRIBUTE_CHARS = 2000;

/**
 * Turn content is bounded before it leaves. A pasted stack trace or a long
 * answer must not make one span dominate the customer's export, and an
 * exporter that silently drops an oversized span costs us the whole turn
 * rather than its tail.
 */
export const MAX_TURN_CHARS = 20000;

/**
 * PER-TURN FEEDBACK ON A TURN'S TRACE. What a user did with a production turn
 * is an EVENT on that turn: the event Mission Control's OTLP intake reads,
 * with the signal (one of `TURN_FEEDBACK_SIGNALS`) and the report's own id.
 * The Python SDK's `tracing.TURN_FEEDBACK_*`.
 */
export const TURN_FEEDBACK_EVENT = "percepteye.turn.feedback";
export const TURN_FEEDBACK_SIGNAL_ATTRIBUTE = "percepteye.turn.feedback.signal";
export const TURN_FEEDBACK_ID_ATTRIBUTE = "percepteye.turn.feedback.id";

/**
 * The span contexts of the production turns this process recorded, so
 * feedback reported after them LINKS to them (`recordTurnFeedbackSpan`).
 * Bounded: the oldest turns are forgotten first (a Map iterates in insertion
 * order), and feedback on one of them still names its turn by
 * `percepteye.turn.id`.
 */
const turnSpans = new Map();
const TURN_SPANS_MAX = 1024;
/** Spans one turn records (its question and its answer, each its own span). */
const TURN_SPANS_PER_TURN = 8;

function rememberTurnSpan(turnId, span) {
  try {
    const context = span.spanContext();
    const kept = [...(turnSpans.get(turnId) ?? []), context].slice(-TURN_SPANS_PER_TURN);
    turnSpans.delete(turnId);
    turnSpans.set(turnId, kept);
    while (turnSpans.size > TURN_SPANS_MAX) {
      turnSpans.delete(turnSpans.keys().next().value);
    }
  } catch {
    /* the link is lost, never the turn */
  }
}

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
 * The first `limit` CODE POINTS of `text`, well-formed and with its Flywheel
 * keys redacted -- the one funnel every text attribute goes through. Python
 * counts characters as code points, and a `slice` on UTF-16 units both cut at
 * the wrong place and could split a surrogate pair, leaving a lone surrogate
 * no exporter can encode as UTF-8. Walks only as far as the limit, never
 * spreading a huge string into an array.
 */
function cut(text, limit) {
  let out = redactKeys(String(text)).toWellFormed();
  if (out.length > limit) {
    let end = 0;
    let points = 0;
    for (const ch of out) {
      if (points === limit) break;
      end += ch.length;
      points += 1;
    }
    out = out.slice(0, end);
  }
  return out;
}

/** Stringify and truncate. A large tool argument must not bloat every span. */
function short(value, limit = MAX_ATTRIBUTE_CHARS) {
  let out;
  try {
    out = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    out = String(value);
  }
  if (out === undefined) out = String(value);
  const kept = cut(out, limit);
  return kept.length < redactKeys(out).toWellFormed().length
    ? kept + "...[truncated]" : kept;
}

function markError(span, message) {
  try {
    // SpanStatusCode.ERROR === 2. Read from the API when present so a future
    // renumbering cannot silently invert the verdict.
    const code = _api?.SpanStatusCode?.ERROR ?? 2;
    span.setStatus({ code, message: cut(message, 500) });
  } catch {
    // Older/partial API surfaces: the attribute still carries the verdict.
  }
}

/**
 * Set a text attribute when there is a value: any value but null, undefined
 * or "", stringified -- `0` is an id like any other, and the `value &&
 * String(value)` this replaced dropped it -- through `cut`.
 */
function setText(span, key, value, limit = MAX_ATTRIBUTE_CHARS) {
  if (value === undefined || value === null || value === "") return;
  span.setAttribute(key, cut(value, limit));
}

/**
 * Project one recorded tool call into the customer's traces.
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
    latencyMs = null,
    agentName = null,
    rolloutId = null,
    turnId = null,
    conversationId = null,
    taskId = null,
    toolCallId = null,
    executionSha256 = null,
  } = opts;
  try {
    t.startActiveSpan(`execute_tool ${name}`, (span) => {
      try {
        if (typeof span.isRecording === "function" && !span.isRecording()) return;
        // gen_ai.* where the convention names it.
        span.setAttribute("gen_ai.operation.name", "execute_tool");
        span.setAttribute("gen_ai.tool.name", cut(name, MAX_ATTRIBUTE_CHARS));
        // The convention DOES name this one: the model-assigned call id, the
        // same value that reappears on the role="tool" message of the next
        // request. It is what lets a consumer join a tool span to the
        // completion that requested it.
        setText(span, "gen_ai.tool.call.id", toolCallId);
        if (args !== undefined && args !== null) {
          span.setAttribute("gen_ai.tool.call.arguments", short(args));
        }

        // percepteye.* where it does not.
        span.setAttribute("percepteye.tool.outcome", String(outcome));
        if (statusCode !== null && statusCode !== undefined) {
          span.setAttribute("percepteye.tool.status_code", Number(statusCode));
        }
        setText(span, "percepteye.rollout.id", rolloutId);
        // A production turn is NOT a rollout. Stamping its id under
        // `percepteye.rollout.id` made a customer's own telemetry unable to
        // answer "how much of my traffic was training" — every served turn
        // looked like contributed work.
        setText(span, "percepteye.turn.id", turnId);
        // ON THE TOOL SPAN TOO, not only on the turn span: a consumer grouping
        // an export into conversations must put a call in the same bucket as
        // the turn that made it, and an export sliced by time or sampled by
        // the collector may not carry that turn's chat span at all.
        setText(span, "percepteye.conversation.id", conversationId);
        // Caller-authored correlation evidence only. Asserts no success, no
        // policy identity and no training eligibility.
        setText(span, "percepteye.task.id", taskId);
        setText(span, "percepteye.agent.execution_sha256", executionSha256);
        setText(span, "gen_ai.agent.name", agentName);
        if (latencyMs !== null && latencyMs !== undefined) {
          span.setAttribute("percepteye.tool.latency_ms", Number(latencyMs));
        }

        // Only a REPORTED failure sets the span to error. An `unknown` outcome
        // leaves the status unset: marking it OK would assert a success nobody
        // observed, and ERROR a failure nobody observed.
        if (outcome === "failed") markError(span, error || "tool call failed");
      } finally {
        try { span.end(); } catch { /* nothing left to do */ }
      }
    });
  } catch {
    /* telemetry must never cost the caller anything */
  }
}

/**
 * Emit one span carrying what the agent was ASKED and what it ANSWERED.
 *
 * THE CAPTURE SURFACE. SFT wants the messages; OPSD wants them plus a
 * privileged reference; RAFT wants them plus a reward and a proven success;
 * DPO wants two of them to pair. None reads a sampled logprob, which is why a
 * span suffices here.
 *
 * It is also what makes a NEXT-STATE signal possible from a customer's own
 * traces: the ingest reads these chat spans into an ordered conversation, and
 * the turn after each answer is the observed consequence the per-step reward
 * model votes on.
 *
 * ``rolloutId`` is stamped when the turn IS a rollout — the marker the ingest
 * side reads to keep our own training traffic out of the customer's
 * observed-traffic accounting. A production turn carries ``percepteye.turn.id``
 * instead and no rollout id, so it is counted as the customer's own.
 */
export function recordTurnSpan(opts = {}) {
  const {
    inputText = null,
    outputText = null,
    turnId = null,
    conversationId = null,
    taskId = null,
    agentName = null,
    model = null,
    rolloutId = null,
    executionSha256 = null,
  } = opts;
  // Nothing to say. An empty turn span would assert a turn happened and
  // carried no content, which is a different claim from not being given it.
  const given = (v) => v !== undefined && v !== null && v !== "";
  if (!given(inputText) && !given(outputText)) return;
  const t = tracer();
  if (t === null) return;
  try {
    t.startActiveSpan("chat", (span) => {
      try {
        if (typeof span.isRecording === "function" && !span.isRecording()) return;
        span.setAttribute("gen_ai.operation.name", "chat");
        setText(span, "gen_ai.request.model", model);
        setText(span, "gen_ai.agent.name", agentName);
        // The convention's names for turn content. Carried as ATTRIBUTES
        // rather than events because the ingest side normalises attributes
        // into `raw_attributes` verbatim, and an event body does not survive
        // that path.
        //
        // PLAIN TEXT, NOT THE CONVENTION'S MESSAGE ARRAYS, deliberately, as
        // the Python SDK's `record_turn_span` writes it. Each turn is two
        // HALF-spans -- the question when the turn opens, the answer when it
        // arrives -- and the control plane's trace reader reads this SDK's
        // plain text as exactly that: the answer's prompt is the transcript
        // before it, so a conversation is rebuilt across its turns. The same
        // half-spans as spec arrays are read as ordinary model calls instead:
        // the answer half is refused for recording no prompt
        // (`content_capture_off`), and each turn becomes its own conversation
        // segment. Verified against that reader; the arrays wait for a reader
        // that knows they are half-spans.
        //
        // `cut` redacts every Flywheel key first, then truncates by code point.
        if (given(inputText)) {
          span.setAttribute("gen_ai.input.messages", cut(inputText, MAX_TURN_CHARS));
        }
        if (given(outputText)) {
          span.setAttribute("gen_ai.output.messages", cut(outputText, MAX_TURN_CHARS));
        }
        setText(span, "percepteye.rollout.id", rolloutId);
        setText(span, "percepteye.turn.id", turnId);
        setText(span, "percepteye.conversation.id", conversationId);
        setText(span, "percepteye.task.id", taskId);
        setText(span, "percepteye.agent.execution_sha256", executionSha256);
        // A production turn: what its user does next may be reported after
        // this span has ended (recordTurnFeedbackSpan).
        if (given(turnId) && !given(rolloutId)) rememberTurnSpan(String(turnId), span);
      } finally {
        try { span.end(); } catch { /* nothing left to do */ }
      }
    });
  } catch {
    /* telemetry must never cost the caller anything */
  }
}

/**
 * Put what a user did with a production turn on that turn's trace. Returns
 * whether a span was recorded. Never throws.
 *
 * THE TURN'S SPAN HAS ENDED by the time its user acts -- `recordTurnSpan` ends
 * it at once -- and an ended span takes no event. So the event rides a span
 * of its own, `percepteye.turn.feedback`, LINKED to the span(s) of the turn
 * this process recorded: a link is OpenTelemetry's relation between spans
 * that are causally related but not parent and child, as a later reaction is
 * to the answer it reacts to. The span also carries the turn's
 * `percepteye.turn.id`, so it names its turn after this process forgot the
 * turn's spans, or never recorded them. It starts a trace of its own (the
 * root context), never a child of whatever span is active where the caller
 * reports it.
 *
 * The event: `percepteye.turn.feedback` at `occurredAtUnixNano` (a BigInt:
 * when the user acted), with `percepteye.turn.feedback.signal` and, when
 * given, `percepteye.turn.feedback.id`. The Python SDK's
 * `record_turn_feedback_span`.
 */
export function recordTurnFeedbackSpan({
  turnId, signal, occurredAtUnixNano, feedbackId = null,
} = {}) {
  const t = tracer();
  if (t === null) return false;
  try {
    const links = (turnSpans.get(String(turnId)) ?? []).map((context) => ({ context }));
    const root = _api?.ROOT_CONTEXT;
    const span = t.startSpan(TURN_FEEDBACK_EVENT, { links }, root);
    try {
      if (typeof span.isRecording === "function" && !span.isRecording()) return false;
      span.setAttribute("percepteye.turn.id", String(turnId));
      const attributes = { [TURN_FEEDBACK_SIGNAL_ATTRIBUTE]: String(signal) };
      if (feedbackId) attributes[TURN_FEEDBACK_ID_ATTRIBUTE] = String(feedbackId);
      // HrTime, [seconds, nanoseconds]: a number of milliseconds would lose
      // the nanoseconds the report states.
      const nanos = BigInt(occurredAtUnixNano);
      const second = 1_000_000_000n;
      const whole = nanos >= 0n ? nanos / second : -((-nanos + second - 1n) / second);
      span.addEvent(TURN_FEEDBACK_EVENT, attributes,
        [Number(whole), Number(nanos - whole * second)]);
      return true;
    } finally {
      try { span.end(); } catch { /* nothing left to do */ }
    }
  } catch {
    return false;
  }
}

/** Test seam: forget the resolved tracer so a suite can install a fake. */
export function __resetTracerForTests(fake = undefined, api = undefined) {
  _tracer = fake ?? null;
  _api = api ?? null;
  _resolved = fake !== undefined;
  turnSpans.clear();
}
