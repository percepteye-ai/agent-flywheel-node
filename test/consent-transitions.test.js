/**
 * Consent transitions the uploader must get right (ND-C6, and the startup
 * race of ND-H15): an ANSWERED no stops the very flush that read it; a blip
 * never revokes; a not-yet-registered agent's "no" at startup is not taken
 * as the operator's; and a verdict read overtaken by a 403 does not undo it.
 */
import "./support/home.js";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  announce, createTurnCapture, createTurnUploader, registerTurnCapture,
} from "../src/capture.js";
import { TransportError } from "../src/errors.js";

const tmp = () => mkdtempSync(join(tmpdir(), "pe-consent-"));
const HOST = { agentId: "main" };

function answeredTurn(root, runId = "r1") {
  const cap = createTurnCapture({ root });
  cap.onMessageReceived({ runId, content: "where is my order?", sessionKey: "c" }, HOST);
  cap.onAgentEnd({ runId, messages: [{ role: "assistant", content: "tomorrow" }] }, HOST);
}

describe("an answered no", () => {
  it("stops the flush that read it before any turn leaves", async () => {
    // Mutation: back to recheck setting consentRefused alone -> mayUpload is
    // still true and the flush POSTs the end user's turn, red.
    const root = tmp();
    answeredTurn(root);
    const posted = [];
    const u = createTurnUploader({
      agentId: "a1", root,
      transport: {
        async captureCurrent() {
          return { capture: { turns: false, reason: "capture was switched off." } };
        },
        async reportTurns(_a, turns) { posted.push(...turns); return {}; },
        async reportOutcomes(_a, o) { posted.push(...o); return {}; },
      },
    });
    // Turns granted, model content not: so the flush re-reads the verdict.
    u.setVerdict({ mayUpload: true, mayCaptureModelContent: false });
    await u.flush({ includeUnanswered: true });
    assert.deepEqual(posted, []);
    assert.equal(u.mayUpload, false);
    assert.equal(u.mayCaptureModelContent, false);
    assert.equal(u.refusal, "capture was switched off.");
    assert.equal(u.reportOutcome("resolved", { turnId: "r1" }), null,
      "an outcome is sent on a turn's terms");
  });

  it("is never read into a blip", async () => {
    const root = tmp();
    const u = createTurnUploader({
      agentId: "a1", root,
      transport: {
        async captureCurrent() { throw new TransportError("connection reset"); },
        async reportTurns() { return {}; },
      },
    });
    u.setVerdict({ mayUpload: true, mayCaptureModelContent: false });
    await u.flush();
    assert.equal(u.mayUpload, true);
  });
});

describe("the startup chain", () => {
  it("does not take a not-yet-registered agent's verdict as the operator's no", async () => {
    // Mutation: drop awaitAnnouncedVerdict -> the outcome's flush reads "not
    // registered" before the registration lands, and every later outcome is
    // a no-op for the life of the process, red.
    const root = tmp();
    let registered = false;
    let land;
    const landed = new Promise((resolve) => { land = resolve; });
    const reads = [];
    const sent = [];
    const tr = {
      async register() { await landed; registered = true; return {}; },
      async captureCurrent() {
        reads.push(registered);
        return { capture: registered ? { turns: true, model_content: true }
          : { turns: false, reason: "this agent is not registered" } };
      },
      async reportTurns() { return { turns: [] }; },
      async reportOutcomes(_a, outcomes) {
        sent.push(...outcomes.map((o) => o.outcome_id));
        return { outcomes: outcomes.map((o) => ({ outcome_id: o.outcome_id, accepted: true })) };
      },
      async declareRulebook() { return {}; },
    };
    const hooks = [];
    const out = registerTurnCapture({ on: (n, f) => hooks.push([n, f]), config: {} }, {
      config: { apiKey: "k", agentId: "a1" }, turns: createTurnCapture({ root }),
      pluginId: "p", env: { PERCEPTEYE_CAPTURE_DIR: root }, makeTransport: () => tr,
    });
    assert.equal(out.reportOutcome("resolved", { turnId: "t1", outcomeId: "o1" }), "o1");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(out.reportOutcome("resolved", { turnId: "t2", outcomeId: "o2" }), "o2",
      "a flush before registration made the agent read as refused");
    assert.deepEqual(reads, [], "no verdict read before the registration");
    land();
    await out.started;
    assert.equal(out.uploader.mayUpload, true);
    await out.uploader.flush();
    assert.deepEqual(sent.sort(), ["o1", "o2"]);
  });

  it("never lets a verdict read overwrite a 403 that arrived meanwhile", async () => {
    // Mutation: drop the `since` guard -> the late "yes" re-enables upload
    // the intake just refused, red.
    const root = tmp();
    answeredTurn(root);
    let answer;
    const slow = new Promise((resolve) => { answer = resolve; });
    const tr = {
      captureCurrent: () => slow,
      async reportTurns() {
        throw new TransportError("POST /turns -> HTTP 403: capture is off",
          { statusCode: 403 });
      },
    };
    const u = createTurnUploader({ agentId: "a1", root, transport: tr });
    u.setVerdict({ mayUpload: true, mayCaptureModelContent: true });
    const reading = announce({ transport: tr, uploader: u, config: { agentId: "a1" },
      pluginId: "p", logger: null });
    await u.flush({ includeUnanswered: true });
    assert.equal(u.mayUpload, false);
    answer({ capture: { turns: true, model_content: true } });
    await reading;
    assert.equal(u.mayUpload, false, "the stale yes overwrote the 403");
    assert.equal(u.refusal, "capture is off");
  });
});
