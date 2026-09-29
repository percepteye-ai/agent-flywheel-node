/**
 * Every control-plane call this package makes, and the one that must never be
 * replayed.
 *
 * NO COUNT IN THAT SENTENCE, deliberately. It used to open "the nine
 * control-plane calls" and went stale the moment `captureCurrent` was added --
 * a reviewer counting the header against the served-route list would have been
 * counting nine of ten. What keeps this file's surface honest is not a number
 * in a comment but `test/config-gate.test.js`, which parses every
 * `request("METHOD", "<path>")` out of THIS SOURCE and asserts the control
 * plane serves it. A count restates that check without performing it.
 *
 * A port of `agent_flywheel/transport.py`. Everything here is
 * OUTBOUND-ONLY: there is no listening socket anywhere in this package, and a
 * customer's agent opens every connection.
 */
import { createHash } from "node:crypto";

import { isLowerSha256 } from "./execution-identity.js";
import {
  ContractError, PRODUCTION_TURN_BATCH_MAX_ITEMS, productionAgentIdentifier,
  productionIdentifier, productionTurnIdentifier, rolloutOutputToWire,
  rolloutRequestFromWire, rulebookReceiptFromWire, rulebookRequestToWire,
} from "./wire.js";

/**
 * `json.dumps(value, sort_keys=True)`, in JavaScript -- for STRINGS, BOOLEANS,
 * NULLS AND INTEGERS. Numbers that are not integers are the one gap, and it is
 * named below rather than left to be found by a digest that does not match.
 *
 * THE IDEMPOTENCY KEY IS A CROSS-SDK CONTRACT, and this function is the whole
 * of it. Both packages hash a batch of turns -- and a rulebook declaration,
 * through the same `bodyDigest` -- and send the digest as that body's
 * `Idempotency-Key`; a customer who migrates harnesses with turns still on
 * disk gets each SDK defeating the other's de-duplication if the two hash the
 * same payload differently.
 *
 * `JSON.stringify` differs from Python's default in three ways that ARE
 * handled here, and this shipped claiming a parity it did not have until a
 * test in the Python package (`test_report_turns_wire.py`) hashed one real
 * batch through both ends and compared the digests:
 *
 *   1. KEY ORDER  -- Python sorts; JS preserves insertion order.
 *   2. SEPARATORS -- Python's defaults are ", " and ": ", WITH the spaces.
 *   3. NON-ASCII  -- Python's `ensure_ascii=True` escapes every non-ASCII
 *      codepoint; JS emits it literally. This is the one that bites in
 *      practice, because what is being hashed is end users' own messages.
 *
 * NUMBERS ARE A FOURTH WAY, AND THIS SIDE ALONE CANNOT CLOSE IT. Python
 * renders a float with `repr`, JS with `Number.prototype.toString`, and they
 * disagree on more than spacing (each verified by running both):
 *
 *     12.0  ->  Python `12.0`   Node `12`
 *     1e-7  ->  Python `1e-07`  Node `1e-7`
 *     1e16  ->  Python `1e+16`  Node `10000000000000000`
 *    -0.0   ->  Python `-0.0`   Node `0`
 *
 * The first row is the one that matters and is also the reason a JS-side
 * float formatter would be a pretence rather than a fix:
 * `JSON.parse('{"latency_ms": 12.0}')` yields the number 12 with int-vs-float
 * ALREADY ERASED, so nothing here can know which of the two forms Python would
 * have emitted for the same file. This is reachable, not theoretical -- a tool
 * call's `arguments` and `latency_ms` are the customer's own JSON, read back
 * off disk.
 *
 * Closing it needs ONE canonicaliser applied on BOTH sides before hashing, so
 * it is a change to the Python package too; a second number formatter here
 * would fix the two rare rows and leave the common one broken while looking
 * settled. Until then the guarantee is exactly: a batch of strings, booleans,
 * nulls and integers hashes identically on both sides, and a batch carrying a
 * non-integral or very large number may not -- in which case the replay is
 * caught by the server's per-turn (org, agent, turn_id) rule, which this key
 * sits in front of rather than replaces. `test/transport.test.js` pins the gap
 * so it stays visible instead of being certified away by an integers-only
 * fixture.
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

/**
 * The digest an idempotency key carries for a request body: a sha256 over
 * `stableStringify`, first 32 hex characters. ONE DERIVATION for every keyed
 * body -- the turn batch and the rulebook -- as the Python SDK's
 * `_body_digest` is one, so the same body gets the same key from either
 * package.
 */
function bodyDigest(value) {
  return createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")
    .slice(0, 32);
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

/**
 * `urllib.parse.quote(value, safe="-._~")`, for cross-SDK keys.
 *
 * TWO CONSUMERS, which is why it is exported. `outbox.js` turns the same
 * opaque rollout id into a FILENAME, and an id that percent-encodes one way
 * for the URL and is filtered another way for the file would let two ids that
 * differ only in stripped characters share one spool path -- losing the second
 * result exactly as the outbox exists to prevent.
 */
export function quoteIdentifier(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** One opaque, control-plane-authored rollout id as a safe URL segment. */
function rolloutPath(rollout, suffix) {
  const rolloutId = rollout?.rolloutId;
  if (typeof rolloutId !== "string" || !rolloutId) {
    throw new ContractError("rollout_id must be a non-empty string");
  }
  try {
    return `/rollouts/${quoteIdentifier(rolloutId)}/${suffix}`;
  } catch {
    throw new ContractError("rollout_id contains invalid Unicode");
  }
}

/**
 * Why a rulebook declaration registered nothing, as one sentence.
 *
 * ONE builder, for the transport's own failures and for a caller holding a
 * transport that threw instead: both lanes report what happened to the rules
 * the same way. The error's message is kept whole because it carries the
 * cause -- `http.js` puts the control plane's refusal (`rulebook_invalid`
 * with the rule's cause and index, `rulebook_unattributed` with the binding
 * status) or the transport failure after the status.
 */
export function rulebookRefusal(err) {
  return (
    `this agent's rules were not registered: ${err?.message ?? err}. The ` +
    "rulebook in force, if any, is unchanged."
  );
}

/**
 * Why the configured `rules` were never SENT, as one sentence, for a lane that
 * cannot reach `declareRulebook` at all -- or `null` when no rules are
 * configured, since then nothing was owed.
 *
 * `cause` names what stopped the lane (no API key or a client that would not
 * build, in production; a training install that claims no rollouts, and so
 * never registers). ONE sentence for both lanes, as `declareRulebook` is one
 * step. A value that is no list of strings is named INSTEAD, by the same
 * reader `registerRulebook` refuses it with: it would be refused once the
 * cause is fixed too, and the Python SDK refuses it at startup before asking
 * about credentials at all.
 */
export function rulesNeverSent(rules, cause) {
  if (rules === null || rules === undefined) return null;
  try {
    rulebookRequestToWire(rules);
  } catch (err) {
    return rulebookRefusal(err);
  }
  return `${cause}, so the configured rules were never sent to the control plane.`;
}

/**
 * Declare the operator's `rules` once, after this agent's registration, and
 * say what happened. Resolves to the refusal sentence, or `null` when the
 * control plane registered them (or answered that they are already in force).
 *
 * THE ONE STEP BOTH LANES TAKE -- `registerTurnCapture` in production (after
 * the verdict read), `registerRolloutDriver` in training (after the
 * registration) -- so the two cannot send, log or record a declaration
 * differently. Neither lane puts it on a chain another call waits on.
 *
 * `null` RULES SEND NOTHING, which is not `[]`: an install that configures no
 * rules must not retract the rulebook another surface registered.
 *
 * NEVER REJECTS, and never throws into its caller, whatever the transport
 * does: a refused or undeliverable declaration costs the rules, never the
 * registration, the verdict read, the policy read or local capture.
 */
export async function declareRulebook({
  transport, rules, pluginId, logger = null,
}) {
  if (rules === null || rules === undefined) return null;
  let outcome;
  try {
    outcome = await transport.registerRulebook(rules);
  } catch (err) {
    outcome = { receipt: null, refusal: rulebookRefusal(err) };
  }
  if (outcome?.refusal) {
    logger?.warn?.(`[${pluginId}] ${outcome.refusal}`);
    return outcome.refusal;
  }
  const receipt = outcome?.receipt ?? {};
  logger?.info?.(
    `[${pluginId}] declared this agent's workflow rules for its Product: ` +
    `${receipt.status ?? "accepted"}` +
    (receipt.version != null
      ? ` (version ${receipt.version}, ${receipt.rule_count} rule(s))`
      : "") + ".",
  );
  return null;
}

/** Bounded, header-safe idempotency identity for an opaque rollout id. */
function rolloutOperationKey(operation, rollout) {
  const rolloutId = rollout?.rolloutId;
  if (typeof rolloutId !== "string" || !rolloutId) {
    throw new ContractError("rollout_id must be a non-empty string");
  }
  const digest = createHash("sha256").update(rolloutId, "utf8").digest("hex");
  return `${operation}-${digest}`;
}

export class AttachTransport {
  /**
   * @param {import("./http.js").ControlPlaneClient} client
   * @param {{agentId: string, waitMs?: number, leaseMs?: number}} opts
   */
  constructor(client, { agentId, waitMs = 5000, leaseMs = 1_800_000 } = {}) {
    if (!agentId) throw new Error("agentId is required");
    this._c = client;
    this.agentId = agentId;
    this.waitMs = clampInt(waitMs, 0, 25_000);
    this.leaseMs = clampInt(leaseMs, 1_000, 1_800_000);
    // Activated only after an authenticated registration succeeds. A failed
    // or legacy registration cannot make this worker claim an exact identity.
    this.agentExecutionSha256 = null;
  }

  health() {
    return this._c.request("GET", "/health");
  }

  /**
   * Create or update this agent's row. THE ONLY PRODUCER of one -- no other
   * route in the control plane creates a `FlywheelAgent`, so an agent that
   * never registers cannot be consented to, graded or described. Replayable:
   * the route is an upsert and the key collapses a network-level resend.
   *
   * The payload is built by its caller, `capture.js:enrol`, which is where
   * the three-state `discovered_agent` decision is made and explained.
   */
  async register(spec) {
    const response = await this._c.request("POST", "/agents", {
      jsonBody: spec,
      idempotencyKey: `reg-${quoteIdentifier(this.agentId)}`,
    });
    const executionSha = spec?.agent_execution_sha256;
    this.agentExecutionSha256 = isLowerSha256(executionSha)
      ? executionSha
      : null;
    return response;
  }

  /**
   * Declare the workflow rules this agent follows as its Product's rulebook
   * (`$defs.RulebookRequest`). `[]` retracts the rulebook in force. Resolves
   * to `{receipt, refusal}`, exactly one of them non-null.
   *
   * THE PRODUCT IS NOT SENT. The control plane writes to the one Product whose
   * Flywheel spec declares this agent; an agent declared by none, or by more
   * than one, is refused (409 `rulebook_unattributed`) and nothing is written.
   *
   * ITS OWN ROUTE, not the registration body and not `describe`: the
   * registration is persisted whole on every restart, and a declaration
   * withholds this agent's execution identity. Rules have neither cost here.
   *
   * FAILS OPEN, like `policyCurrent`: rules the control plane refuses, or a
   * control plane that cannot answer, must not stop the agent, its capture or
   * its policy read -- the rulebook in force is simply unchanged. Nothing the
   * control plane does or fails to do rejects from here; `refusal` is the
   * sentence saying why there is no receipt, carrying the control plane's own
   * cause (the rule it refused and its index, or the binding that attributes
   * the agent to no single Product) rather than one message for every cause.
   * Only `rules` that are not a list of strings reject, with a
   * `ContractError`, before anything is sent: that is a caller's mistake, not
   * the control plane's answer. The Python SDK's
   * `AttachTransport.register_rulebook`, refusal for refusal.
   *
   * REPLAYABLE. The same rules answer `unchanged` and register nothing, so an
   * ambiguous retry is harmless and the client's retries stay ON. The key is
   * `bodyDigest` over the body, so both SDKs send one key for one
   * declaration, non-ASCII rules included (strings are the one wire type, so
   * the float gap `stableStringify` names cannot reach it).
   */
  async registerRulebook(rules) {
    const jsonBody = rulebookRequestToWire(rules);
    const agent = quoteIdentifier(this.agentId);
    let reply;
    try {
      reply = await this._c.request("POST", `/agents/${agent}/rulebook`, {
        jsonBody,
        idempotencyKey: `rulebook-${agent}-${bodyDigest(jsonBody)}`,
      });
    } catch (err) {
      return { receipt: null, refusal: rulebookRefusal(err) };
    }
    try {
      return { receipt: rulebookReceiptFromWire(reply), refusal: null };
    } catch (err) {
      // The control plane ANSWERED 2xx, so "not registered" would be a guess.
      // A receipt outside the published contract is named as what it is.
      return {
        receipt: null,
        refusal:
          "the control plane answered this agent's rules with a receipt " +
          `this SDK cannot read (${err.message}), so whether they are in ` +
          "force is unknown.",
      };
    }
  }

  /**
   * What policy this agent should be running, per the control plane.
   *
   * FAILS OPEN, deliberately. A control plane that cannot answer must not stop
   * an agent from running, so an empty answer means "keep doing what you were
   * doing" -- exactly the behaviour before this endpoint existed.
   *
   * ⚠ `policy.prompt` IS NOT PROMPT TEXT. It is the control plane's own
   * prompt-PIN identity snapshot (`{pins, digest, captured_at}`), unrelated to
   * the customer's optimized prompt; the text comes from `promptCurrent`
   * below. CONSUMER: `policy.js`, which reads `endpoint`, `arm` and
   * `serving_generation` and reports what it cannot apply.
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
   * cannot answer must never BLANK a running agent's instructions. `{}` means
   * KEEP THE PROMPT YOU HAVE; it never means "use no prompt".
   *
   * CONSUMER: `policy.js:createPolicySource.resolve`, which decides whether
   * the answer may be applied and returns it to the host from
   * `before_prompt_build`. Both this method and `policyCurrent` above shipped
   * with NO consumer at all -- two reads whose answers were thrown away, which
   * is the same defect as a route nobody serves, pointed the other way.
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
    const jsonBody = {
      agent_id: this.agentId,
      max: clampInt(maxRollouts, 1, 16),
      wait_ms: this.waitMs,
      lease_ms: this.leaseMs,
    };
    if (this.agentExecutionSha256 !== null) {
      jsonBody.agent_execution_sha256 = this.agentExecutionSha256;
    }
    const body = await this._c.request("POST", "/rollouts/claim", {
      jsonBody,
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
   * May this key upload this agent's production turns, right now?
   *
   * A READ, and that is the point. The verdict used to be reachable only
   * through `POST /agents` -- an upsert -- so re-asking cost a write, and a
   * registration that omits `discovered_agent` is recorded as introspection
   * `disabled`, which stops that agent's description driving workflow
   * generation.
   *
   * `register` above is still called, ONCE, at startup: it is the only
   * producer of the agent row this verdict is computed from, and without it
   * the answer is permanently "not registered". Re-asking is what this route
   * made free, not registering. See `capture.js:enrol`.
   *
   * FAILS CLOSED. An unreachable control plane resolves to `{}`, which the
   * caller reads as "no". The opposite of `policyCurrent`, which fails OPEN
   * because keeping the current policy is the safe answer there -- the two
   * look alike and their safe directions are opposite, which is why this one
   * says so.
   */
  async captureCurrent(agentId) {
    if (productionAgentIdentifier(agentId) === null) return {};
    try {
      return (await this._c.request(
        "GET", `/agents/${encodeURIComponent(agentId)}/capture`)) || {};
    } catch {
      return {};
    }
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
   * `agent_flywheel.transport.report_turns`, so a network-level
   * replay of the same bytes is collapsed before the per-turn rule is reached.
   * Both ends derive it the same way -- a sha256 over the turns, first 32 hex
   * characters -- because two SDKs deriving one key differently would defeat
   * the collapse for whichever customer happened to switch harnesses.
   */
  reportTurns(agentId, turns) {
    if (productionAgentIdentifier(agentId) === null) {
      throw new ContractError(
        "production turn agent_id does not match the published production agent identifier grammar",
      );
    }
    if (
      !Array.isArray(turns)
      || turns.length < 1
      || turns.length > PRODUCTION_TURN_BATCH_MAX_ITEMS
    ) {
      throw new ContractError(
        `production turn batches must contain between 1 and ${PRODUCTION_TURN_BATCH_MAX_ITEMS} turns`,
      );
    }
    turns.forEach((turn, index) => {
      if (!turn || typeof turn !== "object" || Array.isArray(turn)) {
        throw new ContractError(`production turn ${index} must be an object`);
      }
      if (productionTurnIdentifier(turn.turn_id) === null) {
        throw new ContractError(`production turn ${index} has an invalid turn_id`);
      }
      if (
        Object.hasOwn(turn, "conversation_id")
        && productionIdentifier(turn.conversation_id) === null
      ) {
        throw new ContractError(
          `production turn ${index} has an invalid conversation_id`,
        );
      }
      if (
        Object.hasOwn(turn, "task_id")
        && productionIdentifier(turn.task_id) === null
      ) {
        throw new ContractError(`production turn ${index} has an invalid task_id`);
      }
    });
    return this._c.request("POST", "/turns", {
      jsonBody: { agent_id: agentId, turns },
      idempotencyKey: `turns-${quoteIdentifier(agentId)}-${bodyDigest(turns)}`,
    });
  }

  /**
   * Renew the lease on a rollout that is STILL RUNNING.
   *
   * A REQUIREMENT ON WHOEVER HOLDS THE ROLLOUT, not an optional ping. The
   * control plane reaps a lease that stops being renewed and requeues the work
   * while attempts remain, so a rollout that outlives `leaseMs` -- 30 minutes by
   * default, routine for a multi-tool task -- is handed to somebody else while
   * this process is still working on it. The result then lands against a lease
   * this process no longer owns: `report` is answered for an attempt that was
   * superseded, and `heartbeat` itself raises `LeaseLost` (HTTP 410), which is
   * the signal to stop working and report nothing rather than to retry.
   *
   * So a caller that keeps a rollout across an await must beat it at roughly
   * `leaseMs / 3` until it reports or gives it back. The Python end does this
   * from `RolloutRunner`, pinned by
   * `tests/test_lease_and_concurrency.py::test_a_long_rollout_heartbeats_its_lease`.
   */
  heartbeat(rollout, { progress } = {}) {
    const payload = {
      lease_token: rollout.leaseToken,
      extend_ms: Math.min(this.leaseMs, 600_000),
    };
    if (progress) payload.progress = progress;
    return this._c.request(
      "POST", rolloutPath(rollout, "heartbeat"), { jsonBody: payload },
    );
  }

  /**
   * Report the result. REPLAYABLE: the server keys on (rollout_id, attempt),
   * so an identical replay is acknowledged as a duplicate rather than
   * double-counted -- which is why this one keeps ambiguous retries ON.
   */
  report(rollout, output) {
    return this._c.request("POST", rolloutPath(rollout, "result"), {
      jsonBody: rolloutOutputToWire(output),
      idempotencyKey: rolloutOperationKey("result", rollout),
      headers: rollout.leaseToken
        ? { "X-Percepteye-Lease-Token": rollout.leaseToken }
        : null,
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
    return this._c.request("POST", rolloutPath(rollout, "abandon"), {
      jsonBody: { lease_token: rollout.leaseToken, reason, detail },
      idempotencyKey: rolloutOperationKey("abandon", rollout),
    });
  }

}
