/**
 * One `after_tool_call` event becomes one trajectory record.
 *
 * There is no correlation state here, and that is the point of choosing this
 * hook: the event already carries the arguments, the result, the error, the
 * duration and the call id together. The alternative surface
 * (`registerAgentEventSubscription`) splits the same facts across a
 * `phase:"start"` event and a `phase:"result"` event, which forces a pending
 * map keyed by `toolCallId` -- an unbounded one leaks inside a long-lived
 * Gateway, and a bounded one silently drops calls under load. Neither failure
 * exists on this path.
 */
import { classify } from "./classify.js";
import { conversationIdOf, taskIdOf } from "./host.js";
import { resolveMode, TRAINING } from "./mode.js";
import { recordToolCallSpan } from "./tracing.js";
import { extractEntityIds } from "./evidence.js";
import { toWire } from "./trajectory.js";

/**
 * @param {object} deps
 * @param {{write: Function}} deps.writer
 * @param {string|null} [deps.mode] the PLUGIN-CONFIG mode (`config.mode`).
 *   Resolved through `mode.js`, the one seam that knows the precedence --
 *   config, then `PERCEPTEYE_AGENT_MODE`, then training. Reading the
 *   environment alone here once stamped every production tool span with a
 *   rollout id whenever the mode came from the plugin config, and a consumer
 *   that drops self-emitted spans dropped all of them.
 * @param {(ctx: object) => ({rolloutId?: string}|null)} [deps.rolloutFor]
 *   the rollout the rollout driver claimed for this call's session, or null.
 *   Training mode only: it is the CONTROL PLANE's rollout id that says "this
 *   is our own work", never the host's run id.
 * @param {{fingerprintFor?: Function}} [deps.executionIdentity] the exact
 *   execution identity tracker, read per run.
 */
export function createRecorder({
  writer, mode = null, rolloutFor = null, executionIdentity = null,
}) {
  let written = 0;
  // Resolved ONCE, from the same inputs `config.js` resolved it from. The
  // mode is a property of the process, not of a call.
  const training = resolveMode(mode) === TRAINING;

  return {
    get written() {
      return written;
    },
    /**
     * @param {{toolName?:string, params?:object, toolCallId?:string,
     *          result?:unknown, error?:string, durationMs?:number}} event
     * @param {{agentId?:string, runId?:string, sessionKey?:string}} [ctx]
     * @returns {boolean} whether a record was written
     */
    handle(event, ctx = {}) {
      if (!event || typeof event !== "object") return false;
      const name = typeof event.toolName === "string" ? event.toolName : null;
      // A record with no tool name is unattributable, and the contract rejects
      // an empty name outright. Nothing useful can be said about it.
      if (!name) return false;

      const verdict = classify(name, event.error, event.result);
      // Resolve the identity out of the result and let the result itself go.
      // The record carries who was written, never what the response said.
      const entity_ids = extractEntityIds(event.result);
      // Which TURN this call belongs to. The host puts `runId` on both the
      // event and the context, so a missing one here means the host gave us
      // neither -- and an unattributable call must not land in some other
      // turn's directory.
      const runId = (typeof event.runId === "string" && event.runId)
        || (typeof ctx.runId === "string" && ctx.runId)
        || null;
      const ok = writer.write(toWire({
        name,
        // The host passes the arguments the tool ACTUALLY ran with -- it
        // resolves any `before_tool_call` adjustment before dispatching here.
        // Recording the pre-adjustment arguments would describe a call that
        // never happened.
        args: event.params,
        outcome: verdict.outcome,
        status_code: null,
        error: verdict.error,
        error_class: verdict.error_class,
        // Host-measured, so it includes queueing and approval waits that a
        // timer started inside this plugin would miss.
        latency_ms: typeof event.durationMs === "number"
          ? event.durationMs
          : undefined,
        // Which agent made the call. Absent means unattributed, which is the
        // honest answer for a single agent -- never a claim that one agent
        // made everything.
        agent_name: typeof ctx.agentId === "string" ? ctx.agentId : undefined,
        // The id the model assigned. It is the join key that says which
        // completion this call followed, without clocks and without breaking
        // under concurrent tools.
        tool_call_id: typeof event.toolCallId === "string"
          ? event.toolCallId
          : undefined,
        entity_ids,
      }), {
        // The WHOLE host context, with the run id resolved. Ignored by the
        // default writer (a rollout has one directory); used by production
        // capture, which routes the record to its turn by `runId` and also
        // records the conversation and task the context names. Handing it
        // only `{runId}` left that half reading fields that were never there.
        ...ctx,
        runId,
      });
      if (ok) written += 1;

      // THE OTel PROJECTION RIDES THE SAME CALL THAT WRITES THE RECORD, for
      // the reason the Python SDK states at its own call site: two call sites
      // for one fact drift, and a tool call that reached the trajectory but
      // not the customer's traces is the drift nobody notices until they are
      // comparing the two.
      //
      // WHICH ID IS STAMPED. A call is a ROLLOUT's only when the rollout
      // driver claimed one for this session, and then it carries the control
      // plane's rollout id -- as the Python SDK's tool span does. Anything
      // else -- every production call, and a training install's ordinary
      // sessions -- is the customer's own turn, named by the host's run id.
      // Stamping the run id as a rollout id made a customer's own telemetry
      // unable to answer "how much of my traffic was training".
      const rolloutId = training
        ? (rolloutFor?.(ctx)?.rolloutId ?? null)
        : null;
      // A production turn's correlation, read by the same helpers turn capture
      // uses, so the tool span and the turn it belongs to name the same
      // conversation. A rollout carries none of it, as in Python's `serve()`.
      const production = !training;
      recordToolCallSpan(name, event.params, {
        outcome: verdict.outcome,
        error: verdict.error,
        latencyMs: typeof event.durationMs === "number"
          ? event.durationMs : null,
        agentName: typeof ctx.agentId === "string" ? ctx.agentId : null,
        rolloutId,
        turnId: rolloutId ? null : runId,
        conversationId: production ? conversationIdOf(event, ctx) : null,
        taskId: production ? taskIdOf(event, ctx) : null,
        executionSha256: production
          ? (executionIdentity?.fingerprintFor?.(event, ctx)?.execution_sha256
            ?? null)
          : null,
        toolCallId: typeof event.toolCallId === "string"
          ? event.toolCallId : null,
      });
      return ok;
    },
  };
}
