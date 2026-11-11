/**
 * A customer can say how a turn or a conversation actually turned out.
 *
 * The mirror of the Python package's `tests/test_report_outcome.py`, test for
 * test: `reportOutcome` is validated where it is called (a named error,
 * capture on or off), is a no-op without consent, and retries like a turn --
 * it waits on disk until the control plane acknowledges it, survives a
 * restart, stops on a 403, and is resent with the same idempotency key.
 */
import "./support/home.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createTurnUploader, OUTCOME_MAX_AGE_MS, pruneTurns, registerTurnCapture,
  createTurnCapture,
} from "../src/capture.js";
import { TransportError } from "../src/errors.js";
import * as plugin from "../src/index.js";
import { AttachTransport } from "../src/transport.js";
import { recordTurnText, turnDir } from "../src/turns.js";
import {
  ContractError, InvalidOutcome, PRODUCTION_OUTCOME_BATCH_MAX_ITEMS,
  PRODUCTION_OUTCOME_NOTE_MAX_CHARS, PRODUCTION_OUTCOMES, productionOutcome,
  RFC3339_PATTERN,
} from "../src/wire.js";

const SCHEMA = JSON.parse(
  readFileSync(new URL("../schema/flywheel-1.json", import.meta.url), "utf8"),
);

const tmp = () => mkdtempSync(join(tmpdir(), "percepteye-outcome-"));
const pending = (root) =>
  readdirSync(root).filter((n) => n.startsWith(".outcome.")).sort();

function fakeTransport({ outcomesRaise = null, refuse = [] } = {}) {
  const batches = [];
  const turnBatches = [];
  return {
    batches,
    turnBatches,
    outcomesRaise,
    async captureCurrent() { return {}; },
    async reportTurns(_agent, turns) { turnBatches.push(turns); return {}; },
    async reportOutcomes(agentId, outcomes) {
      if (this.outcomesRaise) throw this.outcomesRaise;
      batches.push(outcomes.map((o) => ({ ...o })));
      return {
        agent_id: agentId,
        outcomes: outcomes.map((o) => refuse.includes(o.outcome_id)
          ? { outcome_id: o.outcome_id, accepted: false, error: "outcome_conflict" }
          : { outcome_id: o.outcome_id, accepted: true, duplicate: false }),
      };
    },
    get outcomes() { return batches.flat(); },
  };
}

function uploaderFor(root, transport, { mayUpload = true, warnings = [] } = {}) {
  const u = createTurnUploader({
    transport, agentId: "a1", root,
    logger: { warn: (m) => warnings.push(m) },
  });
  u.setVerdict({ mayUpload, reason: mayUpload ? null : "opt-in per agent" });
  return u;
}

/** Queue without the kicked flush racing the test's own. */
async function settle(u) {
  // `reportOutcome` kicks a flush it does not await; let it finish.
  for (let i = 0; i < 50; i += 1) {
    const r = await u.flush();
    if (!r.skipped) return r;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the kicked flush never finished");
}

describe("reportOutcome: the happy path", () => {
  it("queues the outcome and uploads it off the caller's path", async () => {
    const root = tmp();
    const tr = fakeTransport();
    const u = uploaderFor(root, tr);
    const id = u.reportOutcome("resolved", {
      turnId: "run-1", value: 129.5, note: "confirmed by mail",
      occurredAt: new Date("2026-11-10T10:00:00+01:00"),
    });
    assert.match(id, /^o_[0-9a-f]{32}$/);
    await settle(u);
    assert.deepEqual(tr.outcomes, [{
      outcome_id: id, outcome: "resolved", turn_id: "run-1",
      value: 129.5, note: "confirmed by mail",
      // UTC, milliseconds, Z: byte for byte what the Python SDK writes.
      occurred_at: "2026-11-10T09:00:00.000Z",
    }]);
    assert.deepEqual(pending(root), [], "an acknowledged outcome is not resent");
  });

  it("starts the upload itself: nobody has to call flush", async () => {
    const tr = fakeTransport();
    const u = uploaderFor(tmp(), tr);
    const id = u.reportOutcome("resolved", { turnId: "run-1" });
    for (let i = 0; i < 200 && !tr.outcomes.length; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(tr.outcomes.map((o) => o.outcome_id), [id]);
  });

  it("accepts every word of the vocabulary", async () => {
    const root = tmp();
    const tr = fakeTransport();
    const u = uploaderFor(root, tr);
    for (const word of PRODUCTION_OUTCOMES) {
      assert.ok(u.reportOutcome(word, { conversationId: "c1" }));
    }
    await settle(u);
    assert.deepEqual(tr.outcomes.map((o) => o.outcome).sort(), [
      "abandoned", "escalated", "reopened", "resolved",
      "thumbs_down", "thumbs_up",
    ]);
    assert.ok(tr.outcomes.every((o) => !("turn_id" in o)));
    assert.ok(tr.outcomes.every((o) => o.occurred_at.endsWith("Z")));
  });

  it("sends each of several outcomes of one conversation", async () => {
    const root = tmp();
    const tr = fakeTransport();
    const u = uploaderFor(root, tr);
    const first = u.reportOutcome("resolved", { conversationId: "c1" });
    const second = u.reportOutcome("reopened", { conversationId: "c1" });
    await settle(u);
    assert.notEqual(first, second);
    assert.deepEqual(
      Object.fromEntries(tr.outcomes.map((o) => [o.outcome_id, o.outcome])),
      { [first]: "resolved", [second]: "reopened" });
  });

  it("uses a caller's own outcomeId as the idempotency key", async () => {
    const root = tmp();
    const tr = fakeTransport({ outcomesRaise: new TransportError("down") });
    const u = uploaderFor(root, tr);
    assert.equal(
      u.reportOutcome("thumbs_up", { turnId: "t1", outcomeId: "ticket-9-closed" }),
      "ticket-9-closed");
    u.reportOutcome("thumbs_up", { turnId: "t1", outcomeId: "ticket-9-closed" });
    await settle(u);
    assert.equal(pending(root).length, 1, "the same report is the same file");
    tr.outcomesRaise = null;
    await settle(u);
    assert.deepEqual(tr.outcomes.map((o) => o.outcome_id), ["ticket-9-closed"]);
  });
});

describe("reportOutcome: validated where it is called", () => {
  it("names a word outside the vocabulary", () => {
    const root = tmp();
    const u = uploaderFor(root, fakeTransport());
    assert.throws(
      () => u.reportOutcome("delighted", { turnId: "t1" }),
      (err) => err instanceof InvalidOutcome && err instanceof ContractError
        && err.name === "InvalidOutcome"
        && err.message.includes("thumbs_down")
        && err.message.includes('"delighted"'));
    assert.deepEqual(pending(root), []);
    assert.equal(plugin.InvalidOutcome, InvalidOutcome);
    assert.equal(plugin.PRODUCTION_OUTCOMES, PRODUCTION_OUTCOMES);
  });

  it("validates even while capture is off", () => {
    const u = uploaderFor(tmp(), fakeTransport(), { mayUpload: false });
    assert.throws(
      () => u.reportOutcome("delighted", { turnId: "t1" }), InvalidOutcome);
  });

  const refused = [
    [{}, "turn_id or the conversation_id"],
    [{ turnId: "../escape" }, "turn_id"],
    [{ turnId: 7 }, "turn_id"],
    [{ conversationId: " padded" }, "conversation_id"],
    [{ conversationId: "c".repeat(256) }, "conversation_id"],
    [{ turnId: "t1", value: Number.NaN }, "finite number"],
    [{ turnId: "t1", value: Number.POSITIVE_INFINITY }, "finite number"],
    [{ turnId: "t1", value: true }, "finite number"],
    [{ turnId: "t1", value: "12" }, "finite number"],
    [{ turnId: "t1", note: "" }, "note"],
    [{ turnId: "t1", note: 5 }, "note"],
    [{ turnId: "t1", note: "x".repeat(PRODUCTION_OUTCOME_NOTE_MAX_CHARS + 1) }, "1000"],
    [{ turnId: "t1", occurredAt: new Date("not a date") }, "valid Date"],
    [{ turnId: "t1", occurredAt: "yesterday" }, "RFC 3339"],
    [{ turnId: "t1", occurredAt: "2026-11-10T09:00:00" }, "RFC 3339"],
    // The shape of a time is not a time: each of these used to pass.
    [{ turnId: "t1", occurredAt: "2026-02-30T09:00:00Z" }, "RFC 3339"],
    [{ turnId: "t1", occurredAt: "2025-02-29T09:00:00Z" }, "RFC 3339"],
    [{ turnId: "t1", occurredAt: "2026-11-10T24:00:00Z" }, "RFC 3339"],
    [{ turnId: "t1", occurredAt: "2026-11-10T09:60:00Z" }, "RFC 3339"],
    [{ turnId: "t1", occurredAt: "2026-11-10T23:59:60Z" }, "RFC 3339"],
    [{ turnId: "t1", occurredAt: "2026-13-10T09:00:00Z" }, "RFC 3339"],
    [{ turnId: "t1", occurredAt: "0000-11-10T09:00:00Z" }, "RFC 3339"],
    [{ turnId: "t1", occurredAt: "2026-11-10T09:00:00+24:00" }, "RFC 3339"],
    [{ turnId: "t1", occurredAt: "\u0662026-11-10T09:00:00Z" }, "RFC 3339"],
    [{ turnId: "t1", occurredAt: "\uFF12\uFF10\uFF12\uFF16-11-10T09:00:00Z" }, "RFC 3339"],
    [{ turnId: "t1", outcomeId: "a/b" }, "outcome_id"],
    [{ turnId: "t1", outcomeId: "" }, "outcome_id"],
  ];
  for (const [options, problem] of refused) {
    it(`refuses ${JSON.stringify(options).slice(0, 60)} by name`, async () => {
      const root = tmp();
      const tr = fakeTransport();
      const u = uploaderFor(root, tr);
      assert.throws(
        () => u.reportOutcome("resolved", options),
        (err) => err instanceof InvalidOutcome && err.message.includes(problem));
      assert.deepEqual(pending(root), []);
      await settle(u);
      assert.deepEqual(tr.outcomes, []);
    });
  }

  it("carries a note of exactly the limit and an RFC 3339 string", async () => {
    const root = tmp();
    const tr = fakeTransport();
    const u = uploaderFor(root, tr);
    // Code points, as the schema counts: an astral character is ONE.
    const note = "\u{1F4E6}".repeat(PRODUCTION_OUTCOME_NOTE_MAX_CHARS);
    u.reportOutcome("abandoned", {
      turnId: "t1", note, value: 3, occurredAt: "2026-11-10T09:00:00+01:00",
    });
    await settle(u);
    const [sent] = tr.outcomes;
    assert.equal(sent.note, note);
    assert.equal(sent.value, 3);
    assert.equal(sent.occurred_at, "2026-11-10T09:00:00+01:00");
  });
});

describe("reportOutcome: a no-op without consent", () => {
  it("queues nothing until production capture is enabled", async () => {
    const root = tmp();
    const tr = fakeTransport();
    const u = uploaderFor(root, tr, { mayUpload: false });
    assert.equal(u.reportOutcome("resolved", { turnId: "t1", note: "hi" }), null);
    assert.deepEqual(pending(root), []);
    await settle(u);
    assert.deepEqual(tr.outcomes, []);
  });

  it("is a validated no-op on a plugin with no key", () => {
    const hooks = {};
    const root = tmp();
    const capture = registerTurnCapture(
      { on: (name, fn) => { hooks[name] = fn; } },
      {
        config: { agentId: "a1", apiKey: null },
        turns: createTurnCapture({ root }),
        pluginId: "agent-flywheel",
        env: { PERCEPTEYE_CAPTURE_DIR: root },
      });
    assert.equal(capture.uploader, null);
    assert.equal(capture.reportOutcome("resolved", { turnId: "t1" }), null);
    assert.throws(
      () => capture.reportOutcome("delighted", { turnId: "t1" }), InvalidOutcome);
    assert.deepEqual(pending(root), []);
  });

  it("sends nothing waiting once consent is withdrawn", async () => {
    const root = tmp();
    const tr = fakeTransport({ outcomesRaise: new TransportError("down") });
    const u = uploaderFor(root, tr);
    u.reportOutcome("resolved", { turnId: "t1" });
    await settle(u);
    tr.outcomesRaise = null;
    u.setVerdict({ mayUpload: false, reason: "withdrawn" });
    const counts = await settle(u);
    assert.equal("outcomesSent" in counts, false);
    assert.deepEqual(tr.outcomes, []);
    assert.equal(pending(root).length, 1);
  });
});

describe("reportOutcome: the plugin's capture handle", () => {
  it("exposes reportOutcome beside prune, wired to the uploader", async () => {
    const root = tmp();
    const tr = fakeTransport();
    tr.register = async () => ({ capture: { turns: true } });
    tr.captureCurrent = async () => ({ capture: { turns: true } });
    const capture = registerTurnCapture(
      { on: () => {} },
      {
        config: { agentId: "a1", apiKey: "pefw_x", mode: "production" },
        turns: createTurnCapture({ root }),
        pluginId: "agent-flywheel",
        env: { PERCEPTEYE_CAPTURE_DIR: root },
        makeTransport: () => tr,
      });
    await capture.started;
    assert.equal(capture.uploader.mayUpload, true);
    const id = capture.reportOutcome("escalated", { turnId: "run-1" });
    assert.ok(id);
    await settle(capture.uploader);
    assert.deepEqual(tr.outcomes.map((o) => o.outcome_id), [id]);
  });
});

describe("reportOutcome: the turns' retry and offline behaviour", () => {
  it("keeps the outcome while the control plane is unreachable and resends the same id", async () => {
    const root = tmp();
    const tr = fakeTransport({ outcomesRaise: new TransportError("connection reset") });
    const u = uploaderFor(root, tr);
    const id = u.reportOutcome("escalated", { turnId: "t1" });
    const counts = await settle(u);
    assert.equal(counts.outcomesSent, 0);
    assert.equal(counts.outcomesFailed, 1);
    assert.equal(pending(root).length, 1);
    assert.equal(u.mayUpload, true, "a blip is not a refusal");

    tr.outcomesRaise = null;
    assert.equal((await settle(u)).outcomesSent, 1);
    assert.deepEqual(tr.outcomes.map((o) => o.outcome_id), [id]);
    assert.deepEqual(pending(root), []);
  });

  it("survives a restart", async () => {
    const root = tmp();
    const down = fakeTransport({ outcomesRaise: new TransportError("timed out") });
    const before = uploaderFor(root, down);
    const id = before.reportOutcome("thumbs_down", { conversationId: "c1" });
    await settle(before);
    assert.equal(pending(root).length, 1);

    const up = fakeTransport();
    await settle(uploaderFor(root, up));
    assert.deepEqual(up.outcomes.map((o) => o.outcome_id), [id]);
  });

  it("stops on a 403 and keeps the outcome", async () => {
    const root = tmp();
    const warnings = [];
    const tr = fakeTransport({ outcomesRaise: new TransportError(
      "POST /outcomes -> HTTP 403: production capture is opt-in per agent",
      { statusCode: 403 }) });
    const u = uploaderFor(root, tr, { warnings });
    u.reportOutcome("resolved", { turnId: "t1" });
    await settle(u);
    assert.equal(u.mayUpload, false);
    assert.match(u.refusal, /opt-in per agent/);
    assert.ok(warnings.some((w) => w.includes("refused")));
    assert.equal(pending(root).length, 1);
    // ...and from here it is the no-op again.
    assert.equal(u.reportOutcome("reopened", { turnId: "t1" }), null);
  });

  it("drops an outcome undelivered for a week, out loud", async () => {
    const root = tmp();
    const warnings = [];
    const tr = fakeTransport({ outcomesRaise: new TransportError("down") });
    const u = uploaderFor(root, tr, { warnings });
    u.reportOutcome("resolved", { turnId: "old" });
    await settle(u);
    const [stale] = pending(root);
    const longAgo = new Date(Date.now() - OUTCOME_MAX_AGE_MS - 60_000);
    utimesSync(join(root, stale), longAgo, longAgo);
    tr.outcomesRaise = null;
    const fresh = u.reportOutcome("resolved", { turnId: "fresh" });
    await settle(u);
    assert.deepEqual(tr.outcomes.map((o) => o.outcome_id), [fresh]);
    assert.ok(warnings.some((w) => w.includes("for a week")));
    assert.deepEqual(pending(root), []);
  });

  it("does not resend an outcome the control plane refuses by name", async () => {
    const root = tmp();
    const warnings = [];
    const tr = fakeTransport({ refuse: ["dup"] });
    const u = uploaderFor(root, tr, { warnings });
    u.reportOutcome("resolved", { turnId: "t1", outcomeId: "dup" });
    await settle(u);
    assert.ok(warnings.some((w) => w.includes("outcome_conflict")));
    assert.deepEqual(pending(root), []);
    await settle(u);
    assert.equal(tr.batches.length, 1);
  });

  it("sends more than a batch in batches", async () => {
    const root = tmp();
    const tr = fakeTransport({ outcomesRaise: new TransportError("down") });
    const u = uploaderFor(root, tr);
    const total = PRODUCTION_OUTCOME_BATCH_MAX_ITEMS + 3;
    for (let i = 0; i < total; i += 1) {
      u.reportOutcome("resolved", { turnId: `t${i}` });
    }
    await settle(u);
    tr.outcomesRaise = null;
    assert.equal((await settle(u)).outcomesSent, total);
    assert.deepEqual(
      tr.batches.map((b) => b.length), [PRODUCTION_OUTCOME_BATCH_MAX_ITEMS, 3]);
  });

  it("never reads a waiting outcome as a turn", async () => {
    const root = tmp();
    const tr = fakeTransport({ outcomesRaise: new TransportError("down") });
    const u = uploaderFor(root, tr);
    recordTurnText(turnDir(root, "t1"), "task", "hi", { turn_id: "t1" });
    recordTurnText(turnDir(root, "t1"), "answer", "there", { turn_id: "t1" });
    u.reportOutcome("resolved", { turnId: "t1" });
    const counts = await settle(u);
    assert.deepEqual(tr.turnBatches.flat().map((t) => t.turn_id), ["t1"]);
    assert.equal(counts.outcomesFailed, 1);
    pruneTurns({ root, keepLast: 0 });
    assert.equal(pending(root).length, 1);
  });

  it("reads only a finished outcome file as an outcome", async () => {
    const root = tmp();
    const tr = fakeTransport();
    const u = uploaderFor(root, tr);
    const record = JSON.stringify({
      outcome_id: "o1", outcome: "resolved", turn_id: "t1",
      occurred_at: "2026-11-10T09:00:00Z",
    });
    // A write still in progress, and a customer's own JSON in their directory.
    writeFileSync(join(root, ".outcome.0123.json.tmp"), record);
    writeFileSync(join(root, "notes.json"), record);
    assert.equal("outcomesSent" in (await u.flush()), false);
    assert.deepEqual(tr.outcomes, []);
    assert.deepEqual(readdirSync(root).sort(), [".outcome.0123.json.tmp", "notes.json"]);
  });

  it("reports only the turn counts when no outcome is waiting", async () => {
    const root = tmp();
    const tr = fakeTransport();
    const u = uploaderFor(root, tr);
    recordTurnText(turnDir(root, "t1"), "task", "hi", { turn_id: "t1" });
    recordTurnText(turnDir(root, "t1"), "answer", "there", { turn_id: "t1" });
    assert.deepEqual(await u.flush(), { sent: 1 });
    assert.deepEqual(tr.batches, []);
  });
});

describe("reportOutcome: one refused outcome never holds back the good ones", () => {
  /** The outcome route answering by status: `answer(ids)` is null
   * (acknowledged) or the `[status, detail]` it answers that batch with. */
  function refusing(answer) {
    const tr = fakeTransport();
    const ok = tr.reportOutcomes.bind(tr);
    tr.tried = [];
    tr.reportOutcomes = async (agentId, outcomes) => {
      const ids = outcomes.map((o) => o.outcome_id);
      tr.tried.push(ids);
      const refused = answer(ids);
      if (refused) {
        const [status, detail] = refused;
        throw new TransportError(`POST /outcomes -> HTTP ${status}: ${detail}`,
                                 { statusCode: status });
      }
      return ok(agentId, outcomes);
    };
    return tr;
  }
  const report = (u, ids) => {
    for (const outcomeId of ids) u.reportOutcome("resolved", { turnId: "t1", outcomeId });
  };
  /** Outcomes already waiting on disk, as a previous process left them. */
  const seed = (root, ids) => {
    for (const outcomeId of ids) {
      writeFileSync(join(root, `.outcome.${outcomeId}.json`), JSON.stringify({
        outcome_id: outcomeId, outcome: "resolved", turn_id: "t1",
        occurred_at: "2026-11-10T09:00:00Z" }));
    }
  };

  it("isolates the refused record, sends the rest, and drops it by name", async () => {
    const root = tmp();
    const warnings = [];
    const ids = Array.from({ length: 9 }, (_, n) => `o${n}`);
    const tr = refusing((batch) => (batch.includes("o5")
      ? [422, "value: Input should be a finite number"] : null));
    const u = uploaderFor(root, tr, { warnings });
    report(u, ids);
    await settle(u);
    assert.deepEqual(pending(root), [], "nothing is left to retry forever");
    assert.deepEqual(
      tr.outcomes.map((o) => o.outcome_id).sort(),
      ids.filter((id) => id !== "o5").sort());
    assert.ok(tr.tried.some((b) => b.length === 1 && b[0] === "o5"),
              "the refused record was isolated, not guessed");
    assert.ok(warnings.some((w) => w.includes("HTTP 422")
                                && w.includes("finite number")));
    const tried = tr.tried.length;
    await settle(u);
    assert.equal(tr.tried.length, tried, "a refused record is not sent again");
  });

  it("counts a bisected flush: sent, none failed, one dropped", async () => {
    const root = tmp();
    const ids = Array.from({ length: 9 }, (_, n) => `o${n}`);
    const tr = refusing((batch) => (batch.includes("o5") ? [422, "bad"] : null));
    seed(root, ids);
    const counts = await settle(uploaderFor(root, tr));
    assert.deepEqual(
      [counts.outcomesSent, counts.outcomesFailed, counts.outcomesDropped],
      [8, 0, 1]);
  });

  it("drops each record of a batch refused whole and sends nothing", async () => {
    const root = tmp();
    const tr = refusing(() => [400, "bad body"]);
    seed(root, ["a", "b", "c"]);
    const counts = await settle(uploaderFor(root, tr));
    assert.deepEqual(
      [counts.outcomesSent, counts.outcomesFailed, counts.outcomesDropped],
      [0, 0, 3]);
    assert.deepEqual(pending(root), []);
    assert.deepEqual(tr.outcomes, []);
  });

  for (const status of [401, 404, 405, 410]) {
    it(`drops nothing on a ${status}: the route, not the records`, async () => {
      const root = tmp();
      const warnings = [];
      const tr = refusing(() => [status, "Not Found"]);
      seed(root, ["a", "b", "c"]);
      const u = uploaderFor(root, tr, { warnings });
      const counts = await settle(u);
      assert.equal(pending(root).length, 3);
      assert.deepEqual(
        [counts.outcomesSent, counts.outcomesFailed, counts.outcomesDropped],
        [0, 3, 0]);
      assert.deepEqual(tr.tried, [["a", "b", "c"]], "one try, not a bisection");
      assert.ok(warnings.some((w) => w.includes(`HTTP ${status}`)));
      assert.equal(u.mayUpload, true, "not a consent refusal");
    });
  }

  it("counts each unsent outcome once after a blip and then a 403", async () => {
    const root = tmp();
    const total = PRODUCTION_OUTCOME_BATCH_MAX_ITEMS + 3;
    seed(root, Array.from({ length: total }, (_, n) => `o${n}`));
    const calls = [];
    const tr = fakeTransport();
    tr.reportOutcomes = async (_agent, outcomes) => {
      calls.push(outcomes.length);
      if (calls.length === 1) throw new TransportError("connection reset");
      throw new TransportError("POST /outcomes -> HTTP 403: capture is off",
                               { statusCode: 403 });
    };
    const u = uploaderFor(root, tr);
    const counts = await settle(u);
    assert.deepEqual(calls, [PRODUCTION_OUTCOME_BATCH_MAX_ITEMS, 3]);
    assert.deepEqual([counts.outcomesSent, counts.outcomesFailed], [0, total]);
    assert.equal(pending(root).length, total);
  });
});

describe("the outcome wire: the transport", () => {
  const GOOD = [
    { outcome_id: "o1", outcome: "resolved", turn_id: "t1",
      occurred_at: "2026-11-10T09:00:00Z" },
    { outcome_id: "o2", outcome: "thumbs_down", conversation_id: "c é",
      value: 12, note: "mañana \u{1F4E6}",
      occurred_at: "2026-11-10T09:00:00.250+05:30" },
  ];
  const sent = (agentId = "agent-1", outcomes = GOOD) => {
    const calls = [];
    new AttachTransport(
      { request: (method, path, options) => { calls.push({ method, path, ...options }); } },
      { agentId },
    ).reportOutcomes(agentId, outcomes);
    return calls[0];
  };

  it("posts the batch to /outcomes with a batch idempotency key", () => {
    const call = sent();
    assert.equal(call.method, "POST");
    assert.equal(call.path, "/outcomes");
    assert.deepEqual(call.jsonBody, { agent_id: "agent-1", outcomes: GOOD });
    assert.match(call.idempotencyKey, /^outcomes-agent-1-[0-9a-f]{32}$/);
    assert.equal(sent().idempotencyKey, call.idempotencyKey);
    assert.notEqual(
      sent("agent-1", [{ ...GOOD[0], outcome: "reopened" }]).idempotencyKey,
      call.idempotencyKey);
    assert.notEqual(call.retryIfAmbiguous, false);
  });

  it("refuses what the published schema forbids before anything is sent", () => {
    for (const [agentId, outcomes, problem] of [
      ["customer/team", GOOD, "agent_id"],
      ["agent-1", [], "between 1 and 64"],
      ["agent-1", Array(65).fill(GOOD[0]), "between 1 and 64"],
      ["agent-1", [{ ...GOOD[0], outcome: "delighted" }], "outcome must be one of"],
      ["agent-1", [{ ...GOOD[0], extra: 1 }], "no field"],
    ]) {
      assert.throws(
        () => sent(agentId, outcomes),
        (err) => err instanceof ContractError && err.message.includes(problem));
    }
  });
});

describe("the outcome wire: the schema and the code are one vocabulary", () => {
  it("agrees with schema/flywheel-1.json", () => {
    const outcome = SCHEMA.$defs.ProductionOutcome;
    const batch = SCHEMA.$defs.ProductionOutcomeBatch;
    assert.deepEqual(outcome.properties.outcome.enum, [...PRODUCTION_OUTCOMES]);
    assert.equal(
      outcome.properties.note.maxLength, PRODUCTION_OUTCOME_NOTE_MAX_CHARS);
    assert.equal(outcome.properties.occurred_at.pattern, RFC3339_PATTERN);
    assert.equal(
      batch.properties.outcomes.maxItems, PRODUCTION_OUTCOME_BATCH_MAX_ITEMS);
    assert.deepEqual(
      Object.keys(outcome.properties).sort(),
      ["conversation_id", "note", "occurred_at", "outcome", "outcome_id",
       "turn_id", "value"]);
    assert.throws(
      () => productionOutcome({ outcome_id: "o1", outcome: "resolved",
                                turn_id: "t1", occurred_at: "2026-11-10T09:00:00Z",
                                extra: 1 }),
      InvalidOutcome);
  });
});
