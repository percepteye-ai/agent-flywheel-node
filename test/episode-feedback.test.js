/**
 * An outcome can name the episode it is the outcome of, and one turn of an
 * episode can be given feedback.
 *
 * The mirror of the Python package's
 * `tests/test_episode_outcomes_and_turn_feedback.py`: `episodeId` on
 * `reportOutcome` and `reportTurnFeedback` carry the published wire, neither
 * waits for production-capture consent (a turn's outcome still does), and a
 * control plane that predates either never reaches the caller -- it is said
 * once and the process stops sending.
 */
import "./support/home.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, readFileSync, readdirSync, utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  createTurnCapture, createTurnUploader, feedbackFile, OUTCOME_MAX_AGE_MS,
  registerTurnCapture,
} from "../src/capture.js";
import { TransportError } from "../src/errors.js";
import { ControlPlaneClient } from "../src/http.js";
import * as plugin from "../src/index.js";
import { AttachTransport } from "../src/transport.js";
import {
  ContractError, InvalidFeedback, InvalidOutcome, namesOnlyAnEpisode,
  productionOutcome, TURN_FEEDBACK_BATCH_MAX_ITEMS, TURN_FEEDBACK_SIGNALS,
  TURN_FEEDBACK_TURN_INDEX_MAX, turnFeedback,
} from "../src/wire.js";

const SCHEMA = JSON.parse(
  readFileSync(new URL("../schema/flywheel-1.json", import.meta.url), "utf8"),
);

const EPISODE = "run-7:rollout-0003";
const AT = "2026-11-17T09:00:00Z";

const tmp = () => mkdtempSync(join(tmpdir(), "percepteye-feedback-"));
const named = (prefix) => (root) =>
  readdirSync(root).filter((n) => n.startsWith(prefix)).sort();
const pending = named(".outcome.");
const waiting = named(".feedback.");

function fakeTransport({ outcomesRaise = null, feedbackRaise = null } = {}) {
  const batches = [];
  const feedbackBatches = [];
  return {
    outcomesRaise,
    feedbackRaise,
    feedbackBatches,
    feedbackTried: 0,
    async captureCurrent() { return {}; },
    async reportTurns() { return {}; },
    async reportOutcomes(agentId, outcomes) {
      if (this.outcomesRaise) throw this.outcomesRaise;
      batches.push(outcomes.map((o) => ({ ...o })));
      return {
        agent_id: agentId,
        outcomes: outcomes.map((o) => (
          { outcome_id: o.outcome_id, accepted: true, duplicate: false })),
      };
    },
    async reportTurnFeedback(agentId, feedback) {
      this.feedbackTried += 1;
      if (this.feedbackRaise) throw this.feedbackRaise;
      feedbackBatches.push(feedback.map((f) => ({ ...f })));
      return {
        agent_id: agentId,
        feedback: feedback.map((f) => (
          { feedback_id: f.feedback_id, accepted: true, duplicate: false })),
      };
    },
    get outcomes() { return batches.flat(); },
    get feedback() { return feedbackBatches.flat(); },
  };
}

function uploaderFor(root, transport, {
  mayUpload = true, answered = true, warnings = [],
} = {}) {
  const u = createTurnUploader({
    transport, agentId: "a1", root,
    logger: { warn: (m) => warnings.push(m) },
  });
  u.setVerdict({
    mayUpload, reason: mayUpload ? null : "opt-in per agent", answered,
  });
  return u;
}

/** The real client and transport, answered in-process (`outcomes.test.js`). */
function overHttp(routes) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const key = `${init.method} ${new URL(url).pathname}`;
    seen.push(key);
    // The verdict read answers the grant these uploaders were given: an
    // empty 200 there is an ANSWERED no (transport.js), and an answered no
    // now stops uploading (ND-C6) -- which these tests do not test.
    const route = routes[key] ?? (key === "GET /agents/a1/capture"
      ? [200, { capture: { turns: true, model_content: true } }] : [200, {}]);
    const [status, body, headers = {}] = typeof route === "function"
      ? route(JSON.parse(init.body)) : route;
    return new Response(JSON.stringify(body), {
      status, headers: { "content-type": "application/json", ...headers } });
  };
  const client = new ControlPlaneClient("https://cp.invalid", "pefw_x", { fetchImpl });
  return { transport: new AttachTransport(client, { agentId: "a1" }), seen };
}

/** Let the flush a report kicks finish, then flush once more and return it. */
async function settle(u) {
  // `reportOutcome` kicks a flush it does not await. A flush asked for while
  // one runs is that one's coalesced rerun, so awaiting this one waits the
  // kicked one out. (It used to answer `{skipped: true}` and be polled;
  // `skipped` is now the count of unanswered turns held back.)
  return u.flush();
}

/** Wait out the kicked flush: one asked for meanwhile is its coalesced
 *  rerun, after a beat for the kicked one to start. */
async function idle(u) {
  await new Promise((resolve) => setTimeout(resolve, 2));
  return u.flush();
}

const said = (warnings, ...words) =>
  warnings.filter((w) => words.every((word) => w.includes(word)));

describe("reportOutcome: joined to an episode", () => {
  it("carries the episode it is the outcome of", async () => {
    const root = tmp();
    const tr = fakeTransport();
    const u = uploaderFor(root, tr);
    const id = u.reportOutcome(
      "resolved", { episodeId: EPISODE, turnId: "t1", occurredAt: AT });
    await settle(u);
    assert.deepEqual(tr.outcomes, [{
      outcome_id: id, outcome: "resolved", turn_id: "t1",
      episode_id: EPISODE, occurred_at: AT,
    }]);
  });

  it("without an episode is the wire it always was", async () => {
    const tr = fakeTransport();
    const u = uploaderFor(tmp(), tr);
    u.reportOutcome("resolved", { turnId: "t1", occurredAt: AT });
    await settle(u);
    assert.deepEqual(
      Object.keys(tr.outcomes[0]).sort(),
      ["occurred_at", "outcome", "outcome_id", "turn_id"]);
  });

  for (const episodeId of [" padded", "e".repeat(256), 7, ""]) {
    it(`refuses the episode id ${JSON.stringify(episodeId).slice(0, 20)} by name`, () => {
      const root = tmp();
      const u = uploaderFor(root, fakeTransport());
      assert.throws(
        () => u.reportOutcome("resolved", { episodeId }),
        (err) => err instanceof InvalidOutcome && /episode_id/.test(err.message));
      assert.deepEqual(pending(root), []);
    });
  }

  it("names all three joins when none is given", () => {
    const u = uploaderFor(tmp(), fakeTransport());
    assert.throws(() => u.reportOutcome("resolved", {}), {
      message: "an outcome names the turn_id, the conversation_id or the "
        + "episode_id it is the outcome of",
    });
  });

  it("of an episode alone needs no capture consent; a turn's still does", async () => {
    const root = tmp();
    const tr = fakeTransport();
    const u = uploaderFor(root, tr, { mayUpload: false });
    assert.equal(u.reportOutcome("resolved", { turnId: "t1" }), null);
    assert.equal(
      u.reportOutcome("resolved", { turnId: "t1", episodeId: EPISODE }), null,
      "an outcome that also names a turn is about that turn");
    const id = u.reportOutcome("resolved", { episodeId: EPISODE });
    assert.ok(id);
    await settle(u);
    assert.deepEqual(tr.outcomes.map((o) => o.outcome_id), [id]);
    assert.deepEqual(pending(root), []);
    assert.equal(u.mayUpload, false, "sending it grants nothing");
  });

  it("sends only the episode's outcomes while consent is unknown", async () => {
    const root = tmp();
    const tr = fakeTransport();
    const u = uploaderFor(root, tr, { mayUpload: false, answered: false });
    const kept = u.reportOutcome("resolved", { turnId: "t1" });
    const sent = u.reportOutcome("escalated", { episodeId: EPISODE });
    assert.ok(kept && sent);
    await settle(u);
    assert.deepEqual(tr.outcomes.map((o) => o.outcome_id), [sent]);
    const [still] = pending(root);
    assert.equal(
      JSON.parse(readFileSync(join(root, still), "utf8")).outcome_id, kept);
  });

  it("says a control plane that predates the join once, and keeps the outcome", async () => {
    const root = tmp();
    const warnings = [];
    const tr = fakeTransport({ outcomesRaise: new TransportError(
      "POST /outcomes -> HTTP 403: production capture is opt-in per agent",
      { statusCode: 403 }) });
    const u = uploaderFor(root, tr, { mayUpload: false, warnings });
    assert.ok(u.reportOutcome("resolved", { episodeId: EPISODE }));
    await settle(u);
    await settle(u);
    assert.equal(said(warnings, "for an episode", "predate").length, 1);
    assert.equal(u.refusal, "opt-in per agent", "the turns' refusal is untouched");
    assert.equal(pending(root).length, 1);
    assert.equal(u.reportOutcome("reopened", { episodeId: EPISODE }), null);
    assert.equal(pending(root).length, 1);
    tr.outcomesRaise = null;
    await settle(u);
    assert.deepEqual(tr.outcomes, [], "nothing is sent on those terms again");
  });

  it("namesOnlyAnEpisode is about the two other joins", () => {
    const base = { outcome_id: "o1", outcome: "resolved", occurred_at: AT };
    assert.equal(namesOnlyAnEpisode({ ...base, episode_id: EPISODE }), true);
    assert.equal(namesOnlyAnEpisode(
      { ...base, episode_id: EPISODE, turn_id: "t1" }), false);
    assert.equal(namesOnlyAnEpisode(
      { ...base, episode_id: EPISODE, conversation_id: "c1" }), false);
    assert.equal(namesOnlyAnEpisode({ ...base, turn_id: "t1" }), false);
  });
});

describe("reportTurnFeedback", () => {
  it("is sent joined to the episode and the turn", async () => {
    const root = tmp();
    const tr = fakeTransport();
    const u = uploaderFor(root, tr);
    const id = u.reportTurnFeedback("corrected", {
      episodeId: EPISODE, turnIndex: 3,
      occurredAt: new Date("2026-11-17T10:00:00+01:00"),
    });
    assert.match(id, /^f_[0-9a-f]{32}$/);
    await idle(u);
    assert.deepEqual(tr.feedback, [{
      feedback_id: id, episode_id: EPISODE, turn_index: 3,
      signal: "corrected", occurred_at: "2026-11-17T09:00:00.000Z",
    }]);
    assert.deepEqual(waiting(root), [], "acknowledged feedback is not resent");
    assert.deepEqual(tr.outcomes, [], "feedback is not an outcome");
  });

  it("reports what it sent", async () => {
    const tr = fakeTransport({ feedbackRaise: new TransportError("down") });
    const u = uploaderFor(tmp(), tr);
    u.reportTurnFeedback("accepted", { episodeId: EPISODE, turnIndex: 0 });
    const failed = await settle(u);
    assert.deepEqual(
      [failed.feedbackSent, failed.feedbackFailed, failed.feedbackDropped],
      [0, 1, 0]);
    tr.feedbackRaise = null;
    const sent = await settle(u);
    assert.deepEqual(
      [sent.feedbackSent, sent.feedbackFailed, sent.feedbackDropped], [1, 0, 0]);
    const none = await settle(u);
    assert.deepEqual(
      Object.keys(none).filter((k) => k.startsWith("feedback")), []);
  });

  it("accepts every word of the vocabulary", async () => {
    const tr = fakeTransport();
    const u = uploaderFor(tmp(), tr);
    TURN_FEEDBACK_SIGNALS.forEach((word, turnIndex) => {
      assert.ok(u.reportTurnFeedback(word, { episodeId: EPISODE, turnIndex }));
    });
    await settle(u);
    assert.deepEqual(
      tr.feedback.map((f) => f.signal).sort(),
      ["abandoned", "accepted", "corrected", "escalated", "repeated"]);
  });

  it("names the allowed words when given another", () => {
    const root = tmp();
    const u = uploaderFor(root, fakeTransport());
    assert.throws(
      () => u.reportTurnFeedback("liked", { episodeId: EPISODE, turnIndex: 0 }),
      (err) => {
        assert.ok(err instanceof InvalidFeedback);
        assert.ok(err instanceof ContractError);
        assert.ok(!(err instanceof InvalidOutcome));
        assert.equal(err.message,
          "signal must be one of accepted, corrected, repeated, escalated, "
          + 'abandoned; got "liked"');
        return true;
      });
    assert.deepEqual(waiting(root), []);
    assert.equal(plugin.InvalidFeedback, InvalidFeedback);
    assert.equal(plugin.TURN_FEEDBACK_SIGNALS, TURN_FEEDBACK_SIGNALS);
  });

  const refused = [
    [{ turnIndex: 0 }, "episode_id"],
    [{ episodeId: " padded", turnIndex: 0 }, "episode_id"],
    [{ episodeId: EPISODE, turnIndex: -1 }, "whole number from 0"],
    [{ episodeId: EPISODE, turnIndex: 1.5 }, "whole number from 0"],
    [{ episodeId: EPISODE, turnIndex: true }, "whole number from 0"],
    [{ episodeId: EPISODE, turnIndex: "3" }, "whole number from 0"],
    [{ episodeId: EPISODE }, "whole number from 0"],
    [{ episodeId: EPISODE, turnIndex: TURN_FEEDBACK_TURN_INDEX_MAX + 1 }, "100000"],
    [{ episodeId: EPISODE, turnIndex: 0, feedbackId: "a/b" }, "feedback_id"],
    [{ episodeId: EPISODE, turnIndex: 0, occurredAt: new Date("no") }, "valid Date"],
    [{ episodeId: EPISODE, turnIndex: 0, occurredAt: "yesterday" }, "RFC 3339"],
  ];
  for (const [options, problem] of refused) {
    it(`refuses ${JSON.stringify(options).slice(0, 60)} by name`, async () => {
      const root = tmp();
      const tr = fakeTransport();
      const u = uploaderFor(root, tr);
      assert.throws(
        () => u.reportTurnFeedback("accepted", options),
        (err) => err instanceof InvalidFeedback && err.message.includes(problem));
      assert.deepEqual(waiting(root), []);
      await settle(u);
      assert.deepEqual(tr.feedback, []);
    });
  }

  it("is a validated no-op on a plugin with no key", () => {
    const root = tmp();
    const capture = registerTurnCapture(
      { on: () => {} },
      {
        config: { agentId: "a1", apiKey: null },
        turns: createTurnCapture({ root }),
        pluginId: "agent-flywheel",
        env: { PERCEPTEYE_CAPTURE_DIR: root },
      });
    assert.equal(capture.uploader, null);
    assert.equal(capture.reportTurnFeedback(
      "accepted", { episodeId: EPISODE, turnIndex: 0 }), null);
    assert.throws(
      () => capture.reportTurnFeedback(
        "liked", { episodeId: EPISODE, turnIndex: 0 }), InvalidFeedback);
    assert.deepEqual(waiting(root), []);
  });

  it("needs no capture consent", async () => {
    const tr = fakeTransport();
    const u = uploaderFor(tmp(), tr, { mayUpload: false });
    const id = u.reportTurnFeedback(
      "accepted", { episodeId: EPISODE, turnIndex: 0 });
    await settle(u);
    assert.deepEqual(tr.feedback.map((f) => f.feedback_id), [id]);
    assert.equal(u.mayUpload, false);
  });

  it("resends the caller's own id unchanged after a blip", async () => {
    const root = tmp();
    const warnings = [];
    const tr = fakeTransport({ feedbackRaise: new TransportError("connection reset") });
    const u = uploaderFor(root, tr, { warnings });
    assert.equal(u.reportTurnFeedback("repeated", {
      episodeId: EPISODE, turnIndex: 2, feedbackId: "fb-1" }), "fb-1");
    await settle(u);
    assert.equal(waiting(root).length, 1, "a blip keeps it");
    assert.deepEqual(said(warnings, "per-turn feedback"), [], "a blip is not a no");
    tr.feedbackRaise = null;
    await settle(u);
    assert.deepEqual(tr.feedback.map((f) => f.feedback_id), ["fb-1"]);
  });

  for (const status of [408, 429, 500, 503]) {
    it(`keeps the feedback on a ${status}`, async () => {
      const root = tmp();
      const tr = fakeTransport({ feedbackRaise: new TransportError(
        `POST /turn-feedback -> HTTP ${status}: later`, { statusCode: status }) });
      const u = uploaderFor(root, tr);
      u.reportTurnFeedback("accepted", { episodeId: EPISODE, turnIndex: 0 });
      await settle(u);
      assert.equal(waiting(root).length, 1);
      assert.notEqual(u.reportTurnFeedback(
        "accepted", { episodeId: EPISODE, turnIndex: 1 }), null);
      await settle(u);
    });
  }

  it("keeps every report for later when the intake is switched off (503)", async () => {
    // A control plane whose episode intake is switched off answers 503 with a
    // Retry-After: not a missing route (which drops what is waiting), not a
    // refusal of the key (which stops sending). THROUGH THE REAL HTTP CLIENT:
    // retried as the header says, both kinds kept, nothing said as a no, and
    // sent once it is on.
    const root = tmp();
    const warnings = [];
    const off = [503, { detail: "episode reports are switched off" },
      { "retry-after": "0" }];
    const routes = { "POST /turn-feedback": off, "POST /outcomes": off };
    const { transport, seen } = overHttp(routes);
    const u = uploaderFor(root, transport, { warnings });
    u.reportTurnFeedback("accepted", { episodeId: EPISODE, turnIndex: 0 });
    u.reportOutcome("resolved", { episodeId: EPISODE });
    await idle(u);
    const before = seen.length;
    await u.flush();
    const one = seen.slice(before);
    assert.equal(waiting(root).length, 1, "the feedback is kept");
    assert.equal(pending(root).length, 1, "the outcome is kept");
    // More than one request IN ONE FLUSH: the client retried the 503 itself.
    assert.ok(one.filter((k) => k === "POST /turn-feedback").length > 1,
      "retried as told");
    assert.ok(one.filter((k) => k === "POST /outcomes").length > 1,
      "retried as told");
    assert.deepEqual(said(warnings, "predate"), [], "not a missing route");
    assert.deepEqual(said(warnings, "refused"), [], "not a refusal");
    assert.notEqual(u.reportTurnFeedback(
      "accepted", { episodeId: EPISODE, turnIndex: 1 }), null);
    await settle(u);
    routes["POST /turn-feedback"] = [200, {}];
    routes["POST /outcomes"] = [200, {}];
    await settle(u);
    assert.deepEqual([...waiting(root), ...pending(root)], []);
  });

  for (const status of [404, 405]) {
    it(`a control plane with no feedback route (${status}) never reaches the caller`, async () => {
      // THROUGH THE REAL HTTP CLIENT: one that predates the route answers 404.
      const root = tmp();
      const warnings = [];
      const { transport, seen } = overHttp({
        "POST /turn-feedback": [status, { detail: "Not Found" }] });
      const u = uploaderFor(root, transport, { warnings });
      const total = TURN_FEEDBACK_BATCH_MAX_ITEMS + 3;
      for (let turnIndex = 0; turnIndex < total; turnIndex += 1) {
        // The first call's kicked flush may already have been refused.
        u.reportTurnFeedback("accepted", { episodeId: EPISODE, turnIndex });
      }
      await settle(u);
      const tries = () => seen.filter((k) => k === "POST /turn-feedback").length;
      assert.equal(tries(), 1, "one try, then it stops");
      assert.equal(u.reportTurnFeedback(
        "accepted", { episodeId: EPISODE, turnIndex: 0 }), null);
      await settle(u);
      assert.deepEqual(waiting(root), [], "what was waiting is dropped");
      assert.equal(tries(), 1);
      assert.equal(said(warnings, "per-turn feedback", "predate").length, 1);
      assert.throws(
        () => u.reportTurnFeedback("liked", { episodeId: EPISODE, turnIndex: 0 }),
        InvalidFeedback);
      assert.equal(u.mayUpload, true, "not a consent refusal");
    });
  }

  /** Queue `total` reports with the route down, so no kicked flush sends any. */
  async function queued(root, routes, total, warnings) {
    const { transport, seen } = overHttp(routes);
    const down = new TransportError("down");
    const real = transport.reportTurnFeedback.bind(transport);
    let up = false;
    transport.reportTurnFeedback = async (...args) => {
      if (!up) throw down;
      return real(...args);
    };
    const u = uploaderFor(root, transport, { warnings });
    for (let turnIndex = 0; turnIndex < total; turnIndex += 1) {
      u.reportTurnFeedback("accepted", {
        episodeId: EPISODE, turnIndex, feedbackId: `fb${turnIndex}` });
    }
    await settle(u);
    up = true;
    const tries = () => seen.filter((k) => k === "POST /turn-feedback").length;
    return { u, tries };
  }

  it("a 403 keeps the feedback and stops sending", async () => {
    // The control plane's decision about THIS KEY, not a missing route. It
    // was read as "the route is not there" and the queue was deleted for it.
    const root = tmp();
    const warnings = [];
    const total = TURN_FEEDBACK_BATCH_MAX_ITEMS + 3;
    const { u, tries } = await queued(root, { "POST /turn-feedback": [
      403, { detail: "this key lacks the turn.report scope" }] }, total, warnings);
    const counts = await settle(u);
    assert.deepEqual(
      [counts.feedbackSent, counts.feedbackFailed, counts.feedbackDropped],
      [0, total, 0]);
    assert.equal(waiting(root).length, total, "a 403 deletes nothing");
    assert.equal(tries(), 1, "one try, then it stops");
    assert.equal(u.reportTurnFeedback(
      "accepted", { episodeId: EPISODE, turnIndex: 0 }), null);
    await settle(u);
    assert.equal(tries(), 1);
    assert.equal(waiting(root).length, total);
    const refusal = said(warnings, "refused per-turn feedback");
    assert.equal(refusal.length, 1);
    assert.ok(refusal[0].includes("turn.report scope"));
    assert.deepEqual(said(warnings, "predate"), [], "not the absent route's words");
    assert.equal(u.mayUpload, true, "feedback is not the consent question");
  });

  for (const status of [401, 410]) {
    it(`a ${status} keeps the feedback for a later flush`, async () => {
      const root = tmp();
      const warnings = [];
      const total = TURN_FEEDBACK_BATCH_MAX_ITEMS + 3;
      const { u, tries } = await queued(
        root, { "POST /turn-feedback": [status, { detail: "no" }] },
        total, warnings);
      const counts = await settle(u);
      assert.deepEqual(
        [counts.feedbackSent, counts.feedbackFailed, counts.feedbackDropped],
        [0, total, 0]);
      assert.equal(waiting(root).length, total);
      assert.equal(tries(), 1, "not batch after batch");
      assert.equal(said(warnings, `HTTP ${status}`, "did not take").length, 1);
      await settle(u);
      assert.equal(tries(), 2, "asked again later");
    });
  }

  for (const status of [400, 409, 413, 422]) {
    it(`one report refused with a ${status} never holds back the rest`, async () => {
      // It used to delete every report waiting and switch feedback off.
      const root = tmp();
      const warnings = [];
      const sent = [];
      const route = (body) => {
        const got = body.feedback.map((f) => f.feedback_id);
        if (got.includes("fb5")) return [status, { detail: "turn_index: not this one" }];
        sent.push(...got);
        return [200, { agent_id: "a1", feedback: got.map((id) => (
          { feedback_id: id, accepted: true, duplicate: false })) }];
      };
      const { u } = await queued(root, { "POST /turn-feedback": route }, 9, warnings);
      const counts = await settle(u);
      assert.deepEqual(
        [counts.feedbackSent, counts.feedbackFailed, counts.feedbackDropped],
        [8, 0, 1]);
      assert.deepEqual(waiting(root), []);
      assert.equal(said(
        warnings, `HTTP ${status}`, "per-turn feedback report(s)").length, 1);
      assert.deepEqual(
        [...sent].sort(), [0, 1, 2, 3, 4, 6, 7, 8].map((n) => `fb${n}`));
      assert.notEqual(u.reportTurnFeedback(
        "accepted", { episodeId: EPISODE, turnIndex: 0 }), null,
      "one bad report does not switch feedback off");
      await settle(u);
    });
  }

  it("says a report refused by name by its id and does not resend it", async () => {
    // A 200 can still refuse a report (`accepted: false` and why). The reply
    // was never read: the report counted as sent and nothing said otherwise.
    const root = tmp();
    const warnings = [];
    const route = (body) => [200, { agent_id: "a1", feedback: body.feedback.map(
      (f) => (f.feedback_id === "fb1"
        ? { feedback_id: "fb1", accepted: false, duplicate: false,
          error: "episode_not_found", detail: "no such episode" }
        : { feedback_id: f.feedback_id, accepted: true, duplicate: false })) }];
    const { u, tries } = await queued(
      root, { "POST /turn-feedback": route }, 2, warnings);
    const counts = await settle(u);
    assert.deepEqual(
      [counts.feedbackSent, counts.feedbackFailed, counts.feedbackDropped],
      [1, 0, 1]);
    const refusal = said(warnings, "did not record");
    assert.equal(refusal.length, 1, "said once");
    assert.ok(refusal[0].includes("fb1 (episode_not_found)"));
    assert.ok(!refusal[0].includes("fb0"));
    assert.deepEqual(waiting(root), []);
    await settle(u);
    assert.equal(tries(), 1, "not sent again");
  });

  it("drops feedback undelivered for a week", async () => {
    const root = tmp();
    const tr = fakeTransport({ feedbackRaise: new TransportError("down") });
    const u = uploaderFor(root, tr);
    u.reportTurnFeedback("accepted", { episodeId: EPISODE, turnIndex: 0 });
    await settle(u);
    const tried = tr.feedbackTried;
    const [name] = waiting(root);
    const old = new Date(Date.now() - OUTCOME_MAX_AGE_MS - 60_000);
    utimesSync(join(root, name), old, old);
    const counts = await settle(u);
    assert.equal(counts.feedbackDropped, 1);
    assert.deepEqual(waiting(root), []);
    assert.equal(tr.feedbackTried, tried);
  });

  it("sends more than a batch in batches", async () => {
    const tr = fakeTransport({ feedbackRaise: new TransportError("down") });
    const u = uploaderFor(tmp(), tr);
    const total = TURN_FEEDBACK_BATCH_MAX_ITEMS + 3;
    for (let turnIndex = 0; turnIndex < total; turnIndex += 1) {
      u.reportTurnFeedback("accepted", { episodeId: EPISODE, turnIndex });
    }
    await settle(u);
    tr.feedbackRaise = null;
    assert.equal((await settle(u)).feedbackSent, total);
    assert.deepEqual(
      tr.feedbackBatches.map((b) => b.length).sort((a, b) => a - b),
      [3, TURN_FEEDBACK_BATCH_MAX_ITEMS]);
  });
});

const FEEDBACK = {
  feedback_id: "f1", episode_id: EPISODE, turn_index: 2,
  signal: "accepted", occurred_at: AT,
};
const without = (wire, key) =>
  Object.fromEntries(Object.entries(wire).filter(([k]) => k !== key));

describe("the feedback wire", () => {
  it("is one vocabulary in the schema and the code", () => {
    const feedback = SCHEMA.$defs.TurnFeedback;
    const batch = SCHEMA.$defs.TurnFeedbackBatch;
    const outcome = SCHEMA.$defs.ProductionOutcome;
    assert.deepEqual(feedback.properties.signal.enum, [...TURN_FEEDBACK_SIGNALS]);
    assert.deepEqual([...TURN_FEEDBACK_SIGNALS],
      ["accepted", "corrected", "repeated", "escalated", "abandoned"]);
    assert.equal(
      feedback.properties.turn_index.maximum, TURN_FEEDBACK_TURN_INDEX_MAX);
    assert.equal(
      batch.properties.feedback.maxItems, TURN_FEEDBACK_BATCH_MAX_ITEMS);
    assert.equal(feedback.additionalProperties, false);
    // Every field is required but the TURN, which is named exactly one way
    // (design 2026-11-21, contract A): an episode's, or a production turn's.
    const joins = new Set(["episode_id", "turn_index", "turn_id"]);
    assert.deepEqual([...feedback.required].sort(),
      Object.keys(feedback.properties).filter((k) => !joins.has(k)).sort());
    assert.deepEqual(feedback.oneOf, [
      { required: ["episode_id", "turn_index"], not: { required: ["turn_id"] } },
      { required: ["turn_id"], not: { anyOf: [
        { required: ["episode_id"] }, { required: ["turn_index"] }] } },
    ]);
    for (const name of ["pattern", "minLength", "maxLength", "type"]) {
      assert.equal(feedback.properties.episode_id[name],
        outcome.properties.episode_id[name]);
      assert.equal(feedback.properties.turn_id[name],
        outcome.properties.turn_id[name]);
    }
    assert.ok(outcome.anyOf.some(
      (branch) => JSON.stringify(branch) === '{"required":["episode_id"]}'));
  });

  const accepted = [
    FEEDBACK,
    { ...FEEDBACK, turn_index: 0, signal: "abandoned",
      occurred_at: "2026-11-17T09:00:00.250+05:30" },
    { ...FEEDBACK, turn_index: TURN_FEEDBACK_TURN_INDEX_MAX },
  ];
  for (const wire of accepted) {
    it(`accepts ${JSON.stringify(wire).slice(0, 70)}`, () => {
      assert.deepEqual(turnFeedback(wire), wire);
    });
  }

  const refused = [
    [{ ...FEEDBACK, signal: "liked" }, "signal must be one of"],
    [{ ...FEEDBACK, signal: "resolved" }, "signal must be one of"],
    [{ ...FEEDBACK, signal: 7 }, "signal must be one of"],
    [without(FEEDBACK, "signal"), "signal must be one of"],
    [without(FEEDBACK, "episode_id"), "episode_id"],
    [without(FEEDBACK, "turn_index"), "turn_index"],
    [without(FEEDBACK, "feedback_id"), "feedback_id"],
    [without(FEEDBACK, "occurred_at"), "occurred_at"],
    [{ ...FEEDBACK, turn_index: "2" }, "turn_index"],
    [{ ...FEEDBACK, occurred_at: "2026-11-17T09:00:00" }, "occurred_at"],
    [{ ...FEEDBACK, extra: 1 }, 'feedback has no field "extra"'],
    [["not", "an", "object"], "must be an object"],
    [null, "must be an object"],
  ];
  for (const [wire, problem] of refused) {
    it(`refuses ${JSON.stringify(wire).slice(0, 70)}`, () => {
      assert.throws(() => turnFeedback(wire),
        (err) => err instanceof InvalidFeedback && err.message.includes(problem));
    });
  }

  it("accepts an episode-only outcome and refuses a bad episode id", () => {
    const wire = { outcome_id: "o1", outcome: "resolved",
      episode_id: EPISODE, occurred_at: AT };
    assert.deepEqual(productionOutcome(wire), wire);
    assert.throws(
      () => productionOutcome({ ...wire, episode_id: " e" }), InvalidOutcome);
  });
});

describe("AttachTransport.reportTurnFeedback", () => {
  const BATCH = [FEEDBACK, { ...FEEDBACK, feedback_id: "f2", signal: "repeated" }];
  const sent = (agentId = "agent-1", feedback = BATCH) => {
    const calls = [];
    const tx = new AttachTransport(
      { request: async (method, path, options) => {
        calls.push({ method, path, ...options });
        return {};
      } }, { agentId });
    return tx.reportTurnFeedback(agentId, feedback).then(() => calls[0]);
  };

  it("posts the batch to the route the intake serves", async () => {
    const call = await sent();
    assert.equal(call.method, "POST");
    assert.equal(call.path, "/turn-feedback");
    assert.deepEqual(call.jsonBody, { agent_id: "agent-1", feedback: BATCH });
  });

  it("carries a stable idempotency key", async () => {
    const { idempotencyKey } = await sent();
    assert.match(idempotencyKey, /^turn-feedback-agent-1-[0-9a-f]{32}$/);
    assert.equal((await sent()).idempotencyKey, idempotencyKey);
    assert.notEqual(
      (await sent("agent-1", [FEEDBACK])).idempotencyKey, idempotencyKey);
  });

  const refused = [
    ["customer/team", BATCH, "agent_id"],
    ["agent-1", [], "between 1 and 64"],
    ["agent-1", Array(65).fill(FEEDBACK), "between 1 and 64"],
    ["agent-1", [{ ...FEEDBACK, signal: "liked" }], "signal must be one of"],
  ];
  for (const [agentId, feedback, problem] of refused) {
    it(`refuses a batch the schema forbids (${problem})`, async () => {
      const calls = [];
      const tx = new AttachTransport(
        { request: async (...a) => { calls.push(a); return {}; } }, { agentId });
      await assert.rejects(
        async () => tx.reportTurnFeedback(agentId, feedback),
        (err) => err instanceof ContractError && err.message.includes(problem));
      assert.deepEqual(calls, []);
    });
  }

  it("names the file feedback waits in after its id", () => {
    assert.match(
      basename(feedbackFile("/r", "f1")), /^\.feedback\.[0-9a-f]+\.json$/);
    assert.notEqual(feedbackFile("/r", "f1"), feedbackFile("/r", "f2"));
  });
});
