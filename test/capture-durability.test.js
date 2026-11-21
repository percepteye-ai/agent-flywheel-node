/**
 * What a flush and retention must not lose or leak (ND-H15): a turn batch
 * refused for a record is bisected, a transport failure stops the flush, a
 * lone record refused for no reason of its own is kept, an outcome queue is
 * bounded while uploads are failing, retention never deletes a turn still
 * running, and nothing reached through a symlink is uploaded or pruned.
 */
import "./support/home.js";
import { strict as assert } from "node:assert";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  BATCH_SIZE, OUTCOME_FILE_PREFIX, createTurnCapture, createTurnUploader,
  pruneTurns, registerTurnCapture,
} from "../src/capture.js";
import { TransportError } from "../src/errors.js";
import { turnDir } from "../src/turns.js";

const tmp = () => mkdtempSync(join(tmpdir(), "pe-durable-"));
const HOST = { agentId: "main" };

function answered(root, runId) {
  const cap = createTurnCapture({ root });
  cap.onMessageReceived({ runId, content: "hi", sessionKey: "c" }, HOST);
  cap.onAgentEnd({ runId, messages: [{ role: "assistant", content: "ok" }] }, HOST);
  return turnDir(root, runId);
}

/** A turn route answering each batch by `answer(ids)`: null acknowledges,
 *  `[status, detail]` throws as http.js does, anything else is thrown. */
function turnRoute(answer) {
  const tried = [];
  const sent = [];
  return {
    tried, sent,
    async captureCurrent() { return { capture: { turns: true, model_content: true } }; },
    async reportTurns(_a, turns) {
      const ids = turns.map((t) => t.turn_id);
      tried.push(ids);
      const refused = answer(ids);
      if (refused instanceof Error) throw refused;
      if (refused) {
        const [status, detail] = refused;
        throw new TransportError(`POST /turns -> HTTP ${status}: ${detail}`,
          { statusCode: status });
      }
      sent.push(...ids);
      return { turns: ids.map((turn_id) => ({ turn_id, accepted: true })) };
    },
  };
}

function uploader(root, transport, extra = {}) {
  const warnings = [];
  const u = createTurnUploader({
    transport, agentId: "a1", root, logger: { warn: (m) => warnings.push(m) }, ...extra,
  });
  u.setVerdict({ mayUpload: true, mayCaptureModelContent: true });
  return { u, warnings };
}

describe("a turn batch the intake refuses", () => {
  it("is bisected: the good turns are sent and the bad one is dropped by name", async () => {
    // Mutation: back to the one-chunk-at-a-time loop -> one turn's 413
    // keeps all of its batch on disk, every flush, forever, red.
    const root = tmp();
    const ids = Array.from({ length: 9 }, (_, n) => `t${n}`);
    for (const id of ids) answered(root, id);
    const tr = turnRoute((batch) => (batch.includes("t5") ? [413, "too large"] : null));
    const { u, warnings } = uploader(root, tr);
    const counts = await u.flush();
    assert.deepEqual(tr.sent.sort(), ids.filter((id) => id !== "t5").sort());
    assert.equal(counts.sent, 8);
    assert.equal(counts.dropped, 1);
    assert.ok(warnings.some((w) => w.includes("HTTP 413")));
    // Marked uploaded, never deleted: the directory is the customer's copy.
    assert.ok(existsSync(turnDir(root, "t5")));
    assert.ok(u.uploadedIds().has("t5"));
    const tried = tr.tried.length;
    await u.flush();
    assert.equal(tr.tried.length, tried, "the dropped turn is not sent again");
  });

  it("drops a turn refused for its own content, marked uploaded and counted", async () => {
    // A 422 about one record, isolated by the split: its other half was
    // taken, so the refusal is the record's own.
    const root = tmp();
    for (const id of ["a", "b", "c", "d"]) answered(root, id);
    const tr = turnRoute((batch) => (batch.includes("c") ? [422, "bad turn"] : null));
    const { u } = uploader(root, tr);
    const counts = await u.flush();
    assert.deepEqual([counts.sent, counts.dropped, counts.failed ?? 0], [3, 1, 0]);
    assert.ok(existsSync(turnDir(root, "c")) && u.uploadedIds().has("c"));
  });

  it("says a whole-batch refusal of turns without the outcomes' week", async () => {
    // Turns are the customer's copy and never expire. Mutation: the
    // outcomes' wording for every kind -> "week", red.
    const root = tmp();
    for (let n = 0; n < 6; n += 1) answered(root, `t${n}`);
    const tr = turnRoute(() => [422, "unknown field"]);
    const { u, warnings } = uploader(root, tr);
    const counts = await u.flush();
    assert.deepEqual([counts.sent, counts.failed, counts.dropped ?? 0], [0, 6, 0]);
    const said = warnings.filter((w) => w.includes("whole batches"));
    assert.equal(said.length, 1);
    assert.ok(!said[0].includes("week"), said[0]);
    assert.equal(u.uploadedIds().size, 0, "nothing marked uploaded");
  });

  it("counts what it held back and what it could not read", async () => {
    // The Python SDK's flush counts: an unanswered turn held back is
    // `skipped`, a turn that cannot be rendered is `failed` -- even when
    // nothing else was pending. Mutation: drop either count -> red.
    const root = tmp();
    const cap = createTurnCapture({ root });
    cap.onMessageReceived({ runId: "waiting", content: "hi", sessionKey: "c" }, HOST);
    // A directory whose name is no turn id (leading whitespace, which every
    // platform's file system keeps) cannot be rendered on the wire.
    const broken = join(root, " not-an-id");
    mkdirSync(broken);
    writeFileSync(join(broken, "turns.jsonl"), '{"kind":"task","text":"x"}\n');
    const tr = turnRoute(() => null);
    const { u } = uploader(root, tr);
    const counts = await u.flush();
    assert.deepEqual([counts.sent, counts.skipped, counts.failed], [0, 1, 1]);
  });

  it("stops the flush on a transport failure instead of trying every chunk", async () => {
    // Mutation: `continue` past a failed chunk -> every chunk is tried, red.
    const root = tmp();
    for (let n = 0; n < BATCH_SIZE * 3; n += 1) answered(root, `t${n}`);
    const tr = turnRoute(() => new TransportError("connection reset"));
    const { u } = uploader(root, tr);
    const counts = await u.flush();
    assert.equal(tr.tried.length, 1);
    assert.equal(counts.sent, 0);
    assert.equal(counts.failed, BATCH_SIZE * 3);
  });

  it("counts a turn the intake did not record as dropped, never as sent", async () => {
    const root = tmp();
    answered(root, "good");
    answered(root, "bad");
    const tr = turnRoute(() => null);
    tr.reportTurns = async (_a, turns) => ({ turns: turns.map((t) => ({
      turn_id: t.turn_id, accepted: t.turn_id !== "bad", error: "turn_conflict" })) });
    const { u } = uploader(root, tr);
    const counts = await u.flush();
    assert.deepEqual([counts.sent, counts.dropped], [1, 1]);
  });
});

describe("a lone record refused for what is not its own", () => {
  it("keeps it on disk: a batch of one cannot tell the batch from the record", async () => {
    // Mutation: drop the batch-of-one rule -> the outcome is deleted on a
    // contract-mismatch 422 that every batch would draw, red.
    const root = tmp();
    const tr = turnRoute(() => null);
    tr.reportOutcomes = async () => {
      throw new TransportError("POST /outcomes -> HTTP 422: unknown field",
        { statusCode: 422 });
    };
    const { u, warnings } = uploader(root, tr);
    u.reportOutcome("resolved", { turnId: "t1", outcomeId: "o1" });
    const counts = await u.flush();
    assert.equal(readdirSync(root).filter((n) => n.startsWith(OUTCOME_FILE_PREFIX)).length, 1);
    assert.deepEqual([counts.outcomesFailed ?? 0, counts.outcomesDropped ?? 0], [1, 0]);
    // Said as what it is: a batch of one, not "whole batches" (changed).
    assert.ok(warnings.some((w) => w.includes("batch of one")));
    tr.reportOutcomes = async (_a, outcomes) => ({ outcomes: outcomes.map((o) => ({
      outcome_id: o.outcome_id, accepted: true })) });
    assert.equal((await u.flush()).outcomesSent, 1, "it goes with the next");
  });

  it("keeps a lone turn the same way", async () => {
    // Mutation: drop the batch-of-one rule -> the turn is marked uploaded on
    // a 422 every batch would draw, and never sent, red.
    const root = tmp();
    answered(root, "only");
    let refuse = true;
    const tr = turnRoute(() => (refuse ? [422, "unknown field"] : null));
    const { u, warnings } = uploader(root, tr);
    const counts = await u.flush();
    assert.deepEqual([counts.sent, counts.failed, counts.dropped ?? 0], [0, 1, 0]);
    assert.equal(u.uploadedIds().has("only"), false);
    assert.ok(warnings.some((w) => w.includes("batch of one")));
    refuse = false;
    assert.equal((await u.flush()).sent, 1);
  });

  it("keeps a lone per-turn feedback report the same way", async () => {
    const root = tmp();
    const tr = turnRoute(() => null);
    let refuse = true;
    const sent = [];
    tr.reportTurnFeedback = async (_a, feedback) => {
      if (refuse) {
        throw new TransportError("POST /turn-feedback -> HTTP 422: unknown field",
          { statusCode: 422 });
      }
      sent.push(...feedback.map((f) => f.feedback_id));
      return { feedback: feedback.map((f) => ({ feedback_id: f.feedback_id, accepted: true })) };
    };
    const { u } = uploader(root, tr);
    const id = u.reportTurnFeedback("accepted", { episodeId: "rl_ep1", turnIndex: 0 });
    assert.ok(id);
    const counts = await u.flush();
    assert.deepEqual([counts.feedbackFailed, counts.feedbackDropped], [1, 0]);
    assert.equal(readdirSync(root).filter((n) => n.startsWith(".feedback.")).length, 1);
    refuse = false;
    await u.flush();
    assert.deepEqual(sent, [id]);
  });
});

describe("the outcome queue while uploads are failing", () => {
  it("is bounded even though consent is granted", async () => {
    // Mutation: cap only while consent is unknown -> an outage grows the
    // queue without bound, red.
    const root = tmp();
    const tr = turnRoute(() => null);
    tr.reportOutcomes = async () => { throw new TransportError("down"); };
    const { u, warnings } = uploader(root, tr, { maxOutcomesWhileUnknown: 3 });
    for (let n = 0; n < 6; n += 1) u.reportOutcome("resolved", { turnId: "t", outcomeId: `o${n}` });
    assert.equal(readdirSync(root).filter((n) => n.startsWith(OUTCOME_FILE_PREFIX)).length, 3);
    assert.ok(warnings.some((w) => w.includes("could not be delivered")));
    await u.flush();
  });
});

describe("retention", () => {
  it("never deletes a turn that is still running, even at retentionTurns 0", async () => {
    // Mutation: drop the active-turn guard -> the turn whose message just
    // arrived is deleted before its tool calls land, red.
    const root = tmp();
    const hooks = new Map();
    const out = registerTurnCapture({ on: (n, f) => hooks.set(n, f), config: {} }, {
      config: { retentionTurns: 0 }, turns: createTurnCapture({ root }),
      pluginId: "p", env: { PERCEPTEYE_CAPTURE_DIR: root },
    });
    answered(root, "done");
    hooks.get("message_received")({ runId: "live", content: "hi", sessionKey: "c" }, HOST);
    assert.equal(out.prune({ keepLast: 0 }), 1);
    assert.ok(existsSync(turnDir(root, "live")), "the running turn was deleted");
    assert.ok(!existsSync(turnDir(root, "done")));
  });

  it("deletes nothing for a keepLast that is not a number of turns", () => {
    // Mutation: drop the guard -> NaN slices from 0 and deletes every turn, red.
    const root = tmp();
    answered(root, "a");
    for (const keepLast of [NaN, false, -1, 1.5]) {
      assert.equal(pruneTurns({ root, keepLast }), 0);
    }
    assert.ok(existsSync(turnDir(root, "a")));
  });
});

describe("a symlink in the capture root", () => {
  it("is neither uploaded nor pruned", async () => {
    // Mutation: back to statSync -> the link's target is read as a turn and
    // uploaded, red.
    const root = tmp();
    const elsewhere = tmp();
    mkdirSync(join(elsewhere, "secret"));
    writeFileSync(join(elsewhere, "secret", "turns.jsonl"),
      `${JSON.stringify({ kind: "task", text: "not a turn of ours" })}\n`);
    symlinkSync(join(elsewhere, "secret"), join(root, "linked"));
    const tr = turnRoute(() => null);
    const { u } = uploader(root, tr);
    await u.flush({ includeUnanswered: true });
    assert.deepEqual(tr.sent, []);
    assert.equal(pruneTurns({ root, keepLast: 0 }), 0);
    assert.ok(existsSync(join(elsewhere, "secret", "turns.jsonl")));
  });
});
