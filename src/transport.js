/**
 * The nine control-plane calls, and the one that must never be replayed.
 *
 * A port of `percepteye_agent_flywheel/transport.py`. Everything here is
 * OUTBOUND-ONLY: there is no listening socket anywhere in this package, and a
 * customer's agent opens every connection.
 */
import { createHash } from "node:crypto";

import { rolloutOutputToWire, rolloutRequestFromWire } from "./wire.js";

/**
 * `json.dumps(value, sort_keys=True)`, in JavaScript.
 *
 * THE IDEMPOTENCY KEY IS A CROSS-SDK CONTRACT, and this function is the whole
 * of it. Both packages hash a batch of turns and send the digest as that
 * batch's `Idempotency-Key`; a customer who migrates harnesses with turns
 * still on disk gets each SDK defeating the other's de-duplication if the two
 * hash the same payload differently.
 *
 * `JSON.stringify` differs from Python's default in THREE ways, and this
 * shipped claiming a parity it did not have until a test in the Python package
 * (`test_report_turns_wire.py`) hashed one real batch through both ends and
 * compared the digests:
 *
 *   1. KEY ORDER  -- Python sorts; JS preserves insertion order.
 *   2. SEPARATORS -- Python's defaults are ", " and ": ", WITH the spaces.
 *   3. NON-ASCII  -- Python's `ensure_ascii=True` escapes every non-ASCII
 *      codepoint; JS emits it literally. This is the one that bites in
 *      practice, because what is being hashed is end users' own messages.
 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(", ")}]`;
  if (value && typeof value === "object") {
    const body = Object.keys(value).sort()
      .map((k) => `${pyStr(k)}: ${stableStringify(value[k])}`)
      .join(", ");
    return `{${body}}`;
  }
  if (typeof value === "string") return pyStr(value);
  if (value === undefined) return "null";
  return JSON.stringify(value);
}

/** Everything `ensure_ascii=True` escapes and `JSON.stringify` does not. */
const NON_ASCII = new RegExp("[\\u007f-\\uffff]", "g");

/** One string, escaped the way `json.dumps(ensure_ascii=True)` escapes it. */
function pyStr(s) {
  // JSON.stringify already escapes quotes, backslashes and control characters
  // exactly as Python does; only the non-ASCII codepoints must be folded down.
  return JSON.stringify(s).replace(
    NON_ASCII,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || lo));

export class AttachTransport {
  /**
   * @param {import("./http.js").ControlPlaneClient} client
   * @param {{agentId: string, waitMs?: number, leaseMs?: number}} opts
   */
  constructor(client, { agentId, waitMs = 5000, leaseMs = 300_000 } = {}) {
    if (!agentId) throw new Error("agentId is required");
    this._c = client;
    this.agentId = agentId;
    this.waitMs = waitMs;
    this.leaseMs = leaseMs;
  }

  health() {
    return this._c.request("GET", "/health");
  }

  register(spec) {
    return this._c.request("POST", "/agents", {
      jsonBody: spec,
      idempotencyKey: `reg-${this.agentId}`,
    });
  }

  /**
   * What policy this agent should be running, per the control plane.
   *
   * FAILS OPEN, deliberately. A control plane that cannot answer must not stop
   * an agent from running, so an empty answer means "keep doing what you were
   * doing" -- exactly the behaviour before this endpoint existed.
   */
  async policyCurrent() {
    try {
      return (await this._c.request("GET", "/policy/current")) || {};
    } catch {
      return {};
    }
  }

  /**
   * The approved optimized system prompt, or `{}`.
   *
   * Same fail-open contract, and for a sharper reason: a control plane that
   * cannot answer must never BLANK a running agent's instructions.
   */
  async promptCurrent() {
    try {
      return (await this._c.request("GET", "/prompt/current")) || {};
    } catch {
      return {};
    }
  }

  /**
   * Claim up to `maxRollouts` rollouts. Returns `{rollouts, pollAfterMs}`.
   *
   * CLAIMING IS NOT REPLAYABLE, and this is the one call in the package that
   * turns ambiguous retries OFF. The control plane does not honour
   * Idempotency-Key on this route, so resending a claim that MAY already have
   * been processed leases a SECOND batch while the first is held by nobody --
   * those rollouts then sit untouched until their leases lapse. Only a failure
   * that provably never reached the server is retried.
   */
  async claim(maxRollouts) {
    const body = await this._c.request("POST", "/rollouts/claim", {
      jsonBody: {
        agent_id: this.agentId,
        max: clampInt(maxRollouts, 1, 16),
        wait_ms: this.waitMs,
        lease_ms: this.leaseMs,
      },
      idempotencyKey: crypto.randomUUID(),
      timeoutMs: this.waitMs + 10_000,
      retryIfAmbiguous: false,
    });
    const raw = body.rollouts || [];
    return {
      rollouts: raw.map(rolloutRequestFromWire),
      pollAfterMs: Number(body.poll_after_ms) || 1000,
    };
  }

  /**
   * Upload a batch of captured PRODUCTION turns.
   *
   * REPLAYABLE, unlike `claim`. The server keys each turn on
   * (org, agent, turn_id) and answers an identical resubmission as a
   * duplicate, so an ambiguous retry costs nothing -- whereas a replayed claim
   * would lease a second piece of work. This therefore leaves the client's
   * default retry behaviour ON.
   *
   * The idempotency key covers the BATCH, matching
   * `percepteye_agent_flywheel.transport.report_turns`, so a network-level
   * replay of the same bytes is collapsed before the per-turn rule is reached.
   * Both ends derive it the same way -- a sha256 over the turns, first 32 hex
   * characters -- because two SDKs deriving one key differently would defeat
   * the collapse for whichever customer happened to switch harnesses.
   */
  reportTurns(agentId, turns) {
    const digest = createHash("sha256")
      .update(stableStringify(turns))
      .digest("hex")
      .slice(0, 32);
    return this._c.request("POST", "/turns", {
      jsonBody: { agent_id: agentId, turns },
      idempotencyKey: `turns-${agentId}-${digest}`,
    });
  }

  heartbeat(rollout, { progress } = {}) {
    const payload = {
      lease_token: rollout.leaseToken,
      extend_ms: Math.min(this.leaseMs, 600_000),
    };
    if (progress) payload.progress = progress;
    return this._c.request(
      "POST", `/rollouts/${rollout.rolloutId}/heartbeat`, { jsonBody: payload },
    );
  }

  /**
   * Report the result. REPLAYABLE: the server keys on (rollout_id, attempt),
   * so an identical replay is acknowledged as a duplicate rather than
   * double-counted -- which is why this one keeps ambiguous retries ON.
   */
  report(rollout, output) {
    return this._c.request("POST", `/rollouts/${rollout.rolloutId}/result`, {
      jsonBody: rolloutOutputToWire(output),
      idempotencyKey: `result-${rollout.rolloutId}`,
    });
  }

  /**
   * Give the work back, TYPED.
   *
   * This is not a low reward. It is "do not train on this" -- a substrate
   * fault, an expired credential, a crash. Reporting a crashed rollout as a
   * zero-scoring one teaches the policy that its own behaviour caused an
   * outcome it had nothing to do with.
   */
  abandon(rollout, { reason, detail = "" }) {
    if (!reason) throw new Error("abandon requires a typed reason");
    return this._c.request("POST", `/rollouts/${rollout.rolloutId}/abandon`, {
      jsonBody: { lease_token: rollout.leaseToken, reason, detail },
      idempotencyKey: `abandon-${rollout.rolloutId}`,
    });
  }

}
