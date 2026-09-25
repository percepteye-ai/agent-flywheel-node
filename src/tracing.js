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
 * So ``recordTurnSpan`` is OPT-IN and is only ever called with text the
 * customer handed over deliberately — nothing in this package can see a prompt
 * on its own.
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

/** Attribute payload cap. Attributes are telemetry, not payloads. */
export const MAX_ATTRIBUTE_CHARS = 2000;

/**
 * Turn content is bounded before it leaves. A pasted stack trace or a long
 * answer must not make one span dominate the customer's export, and an
 * exporter that silently drops an oversized span costs us the whole turn
 * rather than its tail.
 */
export const MAX_TURN_CHARS = 20000;

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

/** Stringify and truncate. A large tool argument must not bloat every span. */
function short(value, limit = MAX_ATTRIBUTE_CHARS) {
  let out;
  try {
    out = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    out = String(value);
  }
  if (out === undefined) out = String(value);
  return out.length <= limit ? out : out.slice(0, limit) + "...[truncated]";
}

function markError(span, message) {
  try {
    // SpanStatusCode.ERROR === 2. Read from the API when present so a future
    // renumbering cannot silently invert the verdict.
    const code = _api?.SpanStatusCode?.ERROR ?? 2;
    span.setStatus({ code, message: String(message).slice(0, 500) });
  } catch {
    // Older/partial API surfaces: the attribute still carries the verdict.
  }
}

function setIf(span, key, value) {
  if (value === undefined || value === null || value === "") return;
  span.setAttribute(key, value);
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
        span.setAttribute("gen_ai.tool.name", String(name));
        // The convention DOES name this one: the model-assigned call id, the
        // same value that reappears on the role="tool" message of the next
        // request. It is what lets a consumer join a tool span to the
        // completion that requested it.
        setIf(span, "gen_ai.tool.call.id", toolCallId && String(toolCallId));
        if (args !== undefined && args !== null) {
          span.setAttribute("gen_ai.tool.call.arguments", short(args));
        }

        // percepteye.* where it does not.
        span.setAttribute("percepteye.tool.outcome", String(outcome));
        if (statusCode !== null && statusCode !== undefined) {
          span.setAttribute("percepteye.tool.status_code", Number(statusCode));
        }
        setIf(span, "percepteye.rollout.id", rolloutId && String(rolloutId));
        // A production turn is NOT a rollout. Stamping its id under
        // `percepteye.rollout.id` made a customer's own telemetry unable to
        // answer "how much of my traffic was training" — every served turn
        // looked like contributed work.
        setIf(span, "percepteye.turn.id", turnId && String(turnId));
        // ON THE TOOL SPAN TOO, not only on the turn span: a consumer grouping
        // an export into conversations must put a call in the same bucket as
        // the turn that made it, and an export sliced by time or sampled by
        // the collector may not carry that turn's chat span at all.
        setIf(span, "percepteye.conversation.id",
              conversationId && String(conversationId));
        // Caller-authored correlation evidence only. Asserts no success, no
        // policy identity and no training eligibility.
        setIf(span, "percepteye.task.id", taskId && String(taskId));
        setIf(span, "percepteye.agent.execution_sha256",
              executionSha256 && String(executionSha256));
        setIf(span, "gen_ai.agent.name", agentName && String(agentName));
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
  if (!inputText && !outputText) return;
  const t = tracer();
  if (t === null) return;
  try {
    t.startActiveSpan("chat", (span) => {
      try {
        if (typeof span.isRecording === "function" && !span.isRecording()) return;
        span.setAttribute("gen_ai.operation.name", "chat");
        setIf(span, "gen_ai.request.model", model && String(model));
        setIf(span, "gen_ai.agent.name", agentName && String(agentName));
        // The convention's names for turn content. Carried as ATTRIBUTES
        // rather than events because the ingest side normalises attributes
        // into `raw_attributes` verbatim, and an event body does not survive
        // that path.
        if (inputText) {
          span.setAttribute("gen_ai.input.messages",
                            String(inputText).slice(0, MAX_TURN_CHARS));
        }
        if (outputText) {
          span.setAttribute("gen_ai.output.messages",
                            String(outputText).slice(0, MAX_TURN_CHARS));
        }
        setIf(span, "percepteye.rollout.id", rolloutId && String(rolloutId));
        setIf(span, "percepteye.turn.id", turnId && String(turnId));
        setIf(span, "percepteye.conversation.id",
              conversationId && String(conversationId));
        setIf(span, "percepteye.task.id", taskId && String(taskId));
        setIf(span, "percepteye.agent.execution_sha256",
              executionSha256 && String(executionSha256));
      } finally {
        try { span.end(); } catch { /* nothing left to do */ }
      }
    });
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
