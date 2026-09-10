/**
 * Independent model-call accounting for one bounded rollout lifecycle.
 *
 * The control plane observes requests that reach its gateway. This counter is
 * deliberately the other witness: a host adapter feeds provider-call start
 * and terminal events, identified by the host's own run and call ids. It
 * never reads a gateway count and never derives a count from transcript
 * messages. Missing, duplicate, cross-session, or unterminated evidence
 * yields no count rather than a guess.
 */

const MAX_PENDING_RUNS = 1024;

const nonempty = (value) => (
  typeof value === "string" && value.trim() ? value.trim() : null
);

const runIdOf = (event, ctx) => nonempty(event?.runId) ?? nonempty(ctx?.runId);
const callIdOf = (event) => nonempty(event?.callId);
const sessionKeyOf = (event, ctx) => (
  nonempty(event?.sessionKey) ?? nonempty(event?.sessionId)
  ?? nonempty(ctx?.sessionKey) ?? nonempty(ctx?.sessionId)
);

function newRun(sessionKey) {
  return {
    sessionKey,
    started: new Set(),
    ended: new Map(),
    invalid: null,
  };
}

/**
 * Create a framework-neutral counter. An adapter owns the event mapping; core
 * owns lifecycle binding and refuses evidence that cannot name one exact run.
 */
export function createModelCallCounter() {
  /** session key -> active rollout lifecycle */
  const active = new Map();
  /** host run id -> independently observed provider calls */
  const runs = new Map();

  function cleanupSession(sessionKey) {
    for (const [runId, record] of runs) {
      if (record.sessionKey === sessionKey) runs.delete(runId);
    }
  }

  function begin(sessionKey) {
    const key = nonempty(sessionKey);
    if (key === null || active.has(key)) return false;
    active.set(key, { uncertain: null });
    return true;
  }

  function abandon(sessionKey) {
    const key = nonempty(sessionKey);
    if (key === null) return false;
    const removed = active.delete(key);
    cleanupSession(key);
    return removed;
  }

  function markEveryActive(reason) {
    for (const state of active.values()) state.uncertain ??= reason;
  }

  function recordFor(event, ctx, phase) {
    if (active.size === 0) return null;
    const sessionKey = sessionKeyOf(event, ctx);
    if (sessionKey === null) {
      // With concurrent rollouts there is no principled target. Poison every
      // candidate rather than attaching an out-of-band call to whichever run
      // happens to finish next.
      markEveryActive(`${phase} carried no session identity`);
      return null;
    }
    const lifecycle = active.get(sessionKey);
    // Provider events for ordinary, non-rollout sessions are out of scope and
    // must not contaminate a concurrently claimed rollout.
    if (lifecycle === undefined) return null;
    const runId = runIdOf(event, ctx);
    if (runId === null) {
      lifecycle.uncertain ??= `${phase} carried no run id`;
      return null;
    }
    let record = runs.get(runId);
    if (record === undefined) {
      record = newRun(sessionKey);
      runs.set(runId, record);
      while (runs.size > MAX_PENDING_RUNS) {
        const evictedRunId = runs.keys().next().value;
        const evicted = runs.get(evictedRunId);
        runs.delete(evictedRunId);
        const owner = active.get(evicted?.sessionKey);
        if (owner !== undefined) {
          owner.uncertain ??= "model-call evidence exceeded the pending-run limit";
        }
      }
    } else if (record.sessionKey !== sessionKey) {
      record.invalid ??= "one run carried conflicting session identities";
      lifecycle.uncertain ??= record.invalid;
      const owner = active.get(record.sessionKey);
      if (owner !== undefined) {
        owner.uncertain ??= record.invalid;
      }
      return null;
    }
    return record;
  }

  function observeStarted(event, ctx = {}) {
    const record = recordFor(event, ctx, "model-call start");
    if (record === null) return false;
    const callId = callIdOf(event);
    if (callId === null) {
      record.invalid ??= "a model-call start carried no call id";
      return false;
    }
    if (record.started.has(callId)) {
      record.invalid ??= `model-call start ${JSON.stringify(callId)} was duplicated`;
      return false;
    }
    record.started.add(callId);
    return true;
  }

  function observeEnded(event, ctx = {}) {
    const record = recordFor(event, ctx, "model-call end");
    if (record === null) return false;
    const callId = callIdOf(event);
    if (callId === null) {
      record.invalid ??= "a model-call end carried no call id";
      return false;
    }
    if (!record.started.has(callId)) {
      record.invalid ??= `model-call end ${JSON.stringify(callId)} had no observed start`;
      return false;
    }
    if (record.ended.has(callId)) {
      record.invalid ??= `model-call end ${JSON.stringify(callId)} was duplicated`;
      return false;
    }
    if (event?.outcome !== "completed" && event?.outcome !== "error") {
      record.invalid ??= `model-call end ${JSON.stringify(callId)} had no terminal outcome`;
      return false;
    }
    record.ended.set(callId, event.outcome);
    return true;
  }

  /** Consume the measurement exactly once when the matching agent run ends. */
  function finish(sessionKey, event, ctx = {}) {
    const key = nonempty(sessionKey);
    if (key === null) {
      return { count: null, reason: "the rollout had no session identity" };
    }
    const lifecycle = active.get(key);
    active.delete(key);
    const runId = runIdOf(event, ctx);
    const record = runId === null ? undefined : runs.get(runId);
    // Consume every observation owned by this lifecycle. A host may emit
    // retries under several run ids; retaining the non-terminal records would
    // let a later lifecycle inherit stale evidence if an id is reused.
    cleanupSession(key);
    if (lifecycle === undefined) {
      return { count: null, reason: "no model-call observation lifecycle was active" };
    }
    if (lifecycle.uncertain !== null) {
      return { count: null, reason: lifecycle.uncertain };
    }
    if (runId === null) {
      return { count: null, reason: "agent_end carried no run id" };
    }
    if (record === undefined || record.started.size === 0) {
      return {
        count: null,
        reason: "no provider-call start was observed for this run",
      };
    }
    if (record.invalid !== null) return { count: null, reason: record.invalid };
    if (record.sessionKey !== key) {
      return {
        count: null,
        reason: "model-call evidence belonged to a different session",
      };
    }
    if (record.ended.size !== record.started.size) {
      return {
        count: null,
        reason: "one or more model calls had no observed terminal event",
      };
    }
    for (const outcome of record.ended.values()) {
      if (outcome !== "completed") {
        return {
          count: null,
          reason: "one or more model calls ended in error",
        };
      }
    }
    return { count: record.started.size, reason: null };
  }

  return {
    begin,
    abandon,
    observeStarted,
    observeEnded,
    finish,
    get activeCount() { return active.size; },
  };
}
