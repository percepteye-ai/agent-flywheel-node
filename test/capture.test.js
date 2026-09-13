/**
 * Production turn capture, and the format it shares with the Python SDK.
 *
 * The first suite is the one that keeps the two packages honest. A customer
 * deploys this or the pip package, never both, and the promise is that they
 * behave identically. The mechanism for that is the ON-DISK FORMAT: a turn is
 * a directory named for the turn id, holding `turns.jsonl`, `conversation_id`
 * and `tool_calls.jsonl`. These assert the exact filenames, the exact record
 * keys and the exact wire keys, because "keep these in sync" written in a
 * comment is not a mechanism and both sides have drifted before.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BATCH_SIZE, FLUSH_EVERY, UNANSWERED_SETTLE_MS, UPLOADED_INDEX, announce,
  captureRoot, captureVerdict, createTurnCapture, createTurnUploader,
  lastAssistantText, registerTurnCapture,
} from "../src/capture.js";
import { SDK_UA } from "../src/http.js";
import { CONTRACT_VERSION } from "../src/wire.js";
import {
  CONVERSATION_ID_FILENAME, MAX_TEXT_CHARS, TASK_ID_CONFLICT_FILENAME,
  TASK_ID_FILENAME, TURNS_FILENAME, readTaskId, readTurnText, recordTaskId,
  recordTurnText,
  turnDir, turnIndexOf, turnWire,
} from "../src/turns.js";
import { register, PLUGIN_ID } from "../src/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "percepteye-cap-"));

/** Build a turn on disk the way the hooks would. */
function makeTurn(root, runId, { task, answer, calls, conversation, taskId } = {}) {
  const cap = createTurnCapture({ root });
  if (task !== undefined) {
    cap.onMessageReceived({
      runId, content: task, sessionKey: conversation, taskId,
    });
  }
  if (calls) {
    const dir = turnDir(root, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tool_calls.jsonl"),
                  calls.map((c) => JSON.stringify(c)).join("\n") + (calls.length ? "\n" : ""),
                  "utf8");
  }
  if (answer !== undefined) {
    cap.onAgentEnd({
      runId, taskId, messages: [{ role: "assistant", content: answer }],
    });
  }
  return turnDir(root, runId);
}

const OK_CALL = { name: "lookup", arguments: { id: "1" }, outcome: "ok", status_code: 200 };

describe("the on-disk format is the Python SDK's", () => {
  it("names the files exactly as the other end reads them", () => {
    // `percepteye_agent_flywheel.outcomes` opens these literal names.
    assert.equal(TURNS_FILENAME, "turns.jsonl");
    assert.equal(CONVERSATION_ID_FILENAME, "conversation_id");
    assert.equal(TASK_ID_FILENAME, "task_id");
    assert.equal(MAX_TEXT_CHARS, 20_000);
  });

  it("writes a turn record with the keys the Python reader expects", () => {
    const root = tmp();
    const dir = makeTurn(root, "run-1", { task: "hello", conversation: "sess-a" });
    const lines = readFileSync(join(dir, TURNS_FILENAME), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines[0].kind, "task");
    assert.equal(lines[0].text, "hello");
    assert.equal(lines[0].turn_id, "run-1");
    assert.equal(lines[0].conversation_id, "sess-a");
    assert.equal(readFileSync(join(dir, CONVERSATION_ID_FILENAME), "utf8"), "sess-a");
  });

  it("lets the LAST record of each kind win", () => {
    // A turn answered twice -- a retry, a correction -- ends with the answer
    // that was actually returned.
    const root = tmp();
    const cap = createTurnCapture({ root });
    cap.onAgentEnd({ runId: "r", messages: [{ role: "assistant", content: "first" }] });
    cap.onAgentEnd({ runId: "r", messages: [{ role: "assistant", content: "final" }] });
    assert.equal(readTurnText(turnDir(root, "r")).answer, "final");
  });

  it("writes NOTHING for empty text rather than an empty record", () => {
    // "answered with silence" and "we were not given the answer" are different
    // claims, and only the second is true here.
    const root = tmp();
    const cap = createTurnCapture({ root });
    assert.equal(cap.onMessageReceived({ runId: "r", content: "   " }), false);
    assert.equal(readTurnText(turnDir(root, "r")), null);
  });

  it("truncates at the same point as the other end", () => {
    const root = tmp();
    const cap = createTurnCapture({ root });
    cap.onMessageReceived({ runId: "r", content: "x".repeat(MAX_TEXT_CHARS + 500) });
    assert.equal(readTurnText(turnDir(root, "r")).task.length, MAX_TEXT_CHARS);
  });

  it("preserves valid opaque ids and gives invalid host ids fresh safe ids", () => {
    // A PROPERTY OF THE FUNCTION, not a filesystem probe. This first asserted
    // that `<root>/../../escape` did not exist -- which a mutation then
    // CREATED, outside any temp directory, where it survived the restore and
    // failed the test forever after. A test that can pollute the machine it
    // runs on is a test that stops meaning anything.
    const root = tmp();
    for (const hostile of ["../../escape", "/etc/passwd", "a/b", "..", ""]) {
      assert.throws(() => turnDir(root, hostile), /production identifier/);
    }
    const cap = createTurnCapture({ root });
    cap.onMessageReceived({ runId: "../../escape", content: "hi" });
    cap.onAgentEnd({
      runId: "../../escape",
      messages: [{ role: "assistant", content: "done" }],
    });
    const names = readdirSync(root);
    assert.equal(names.length, 1, "one invalid host run split across two ids");
    assert.match(names[0], /^t_[0-9a-f]{16}$/);
    assert.equal(turnWire(join(root, names[0])).final_text, "done");

    const opaque = "顧客 run #1";
    cap.onMessageReceived({ runId: opaque, content: "hello" });
    assert.equal(turnWire(turnDir(root, opaque)).turn_id, opaque);
  });

  it("refuses to record empty text at the writer, not only at the caller", () => {
    // `createTurnCapture` guards this too, so a mutation removing the guard
    // HERE survived: the outer one caught it. Both are real -- `recordTurnText`
    // is exported and the on-disk format is shared with the Python SDK -- so
    // each is asserted where it lives.
    const root = tmp();
    const dir = turnDir(root, "r");
    assert.equal(recordTurnText(dir, "task", "   "), false);
    assert.equal(recordTurnText(dir, "task", ""), false);
    assert.equal(recordTurnText(dir, "task", null), false);
    assert.equal(readTurnText(dir), null, "an empty record was written");
    assert.equal(recordTurnText(dir, "task", " real "), true);
    assert.equal(readTurnText(dir).task, "real", "text must be trimmed");
  });

  it("refuses a kind that is not one of the two halves", () => {
    assert.throws(() => recordTurnText(tmp(), "notes", "x"), /turn kind/);
  });
});

describe("the wire shape", () => {
  it("carries the intake's exact keys", () => {
    const root = tmp();
    const dir = makeTurn(root, "r1",
      { task: "ask", answer: "reply", calls: [OK_CALL], conversation: "c1" });
    const w = turnWire(dir, { turnIndex: 3 });
    assert.deepEqual(Object.keys(w).sort(), [
      "conversation_id", "final_text", "input_text", "tool_calls",
      "tool_calls_omitted_count", "turn_id", "turn_index",
    ]);
    assert.equal(w.turn_id, "r1");
    assert.equal(w.input_text, "ask");
    assert.equal(w.final_text, "reply");
    assert.equal(w.turn_index, 3);
  });

  it("asks the FILE for the tool-call tri-state, not our configuration", () => {
    // The Python end had a bug here worth not repeating: it answered
    // `[] if adapters_bound else None`, which reports on whether capture was
    // configured and says nothing about whether THIS turn recorded anything --
    // so a turn whose trajectory was never written went up asserting the agent
    // made zero calls. An observation nobody made.
    const root = tmp();

    const withCalls = makeTurn(root, "a", { task: "t", calls: [OK_CALL] });
    assert.deepEqual(turnWire(withCalls).tool_calls, [OK_CALL]);

    const emptyFile = makeTurn(root, "b", { task: "t", calls: [] });
    assert.deepEqual(turnWire(emptyFile).tool_calls, [],
      "a present-but-empty trajectory means it ran and called nothing");

    const noFile = makeTurn(root, "c", { task: "t" });
    assert.equal(turnWire(noFile).tool_calls, null,
      "an absent trajectory means nothing was recorded, not zero calls");
  });

  it("counts unreadable rows instead of dropping or throwing on them", () => {
    const root = tmp();
    const dir = turnDir(root, "r");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tool_calls.jsonl"),
                  JSON.stringify(OK_CALL) + "\n{ truncated\n", "utf8");
    const w = turnWire(dir);
    assert.equal(w.tool_calls.length, 1);
    assert.equal(w.tool_calls_omitted_count, 1);
  });

  it("returns null for a turn that recorded nothing", () => {
    const root = tmp();
    mkdirSync(turnDir(root, "empty"), { recursive: true });
    assert.equal(turnWire(turnDir(root, "empty")), null);
  });

  it("omits conversation_id and turn_index when the turn declared none", () => {
    // A turn that never said which conversation it belonged to cannot be
    // ordered against another, and guessing is misattribution.
    const root = tmp();
    const dir = makeTurn(root, "r", { task: "t" });
    const w = turnWire(dir);
    assert.ok(!("conversation_id" in w));
    assert.ok(!("turn_index" in w));
  });

  it("carries an exact caller task id as neutral correlation evidence", () => {
    const root = tmp();
    const dir = makeTurn(root, "r-task", {
      task: "investigate", answer: "resolved", taskId: "INC-123",
    });
    assert.equal(readFileSync(join(dir, TASK_ID_FILENAME), "utf8"), "INC-123");
    assert.equal(turnWire(dir).task_id, "INC-123");
  });

  it("uploads a valid task-id-only turn without inventing content", () => {
    const root = tmp();
    const cap = createTurnCapture({ root });
    assert.equal(cap.onMessageReceived({
      runId: "r-task-only", content: "", task_id: "CASE-9",
    }), true);
    assert.deepEqual(turnWire(turnDir(root, "r-task-only")), {
      turn_id: "r-task-only",
      input_text: null,
      final_text: null,
      tool_calls: null,
      tool_calls_omitted_count: 0,
      task_id: "CASE-9",
    });
  });

  it("omits invalid or conflicting task bindings rather than rewriting them", () => {
    const root = tmp();
    const invalid = makeTurn(root, "invalid-task", {
      task: "hi", taskId: " CASE-9 ",
    });
    assert.equal(readTaskId(invalid), null);
    assert.ok(!("task_id" in turnWire(invalid)));

    const dir = turnDir(root, "conflict");
    assert.equal(recordTaskId(dir, "CASE-1"), true);
    assert.equal(recordTaskId(dir, "CASE-1"), true);
    assert.equal(readTaskId(dir), "CASE-1");
    assert.equal(recordTaskId(dir, "CASE-2"), false);
    assert.equal(existsSync(join(dir, TASK_ID_CONFLICT_FILENAME)), true);
    assert.equal(readTaskId(dir), null);
  });

  it("omits an invalid conversation id without changing it", () => {
    const root = tmp();
    const dir = makeTurn(root, "r-cid", {
      task: "hi", conversation: " conversation ",
    });
    const wire = turnWire(dir);
    assert.ok(!("conversation_id" in wire));
    assert.equal(existsSync(join(dir, CONVERSATION_ID_FILENAME)), false);
  });

  it("orders a conversation by mtime, so turns are not all index 0", () => {
    const root = tmp();
    const a = makeTurn(root, "first", { task: "1", conversation: "c" });
    const b = makeTurn(root, "second", { task: "2", conversation: "c" });
    utimesSync(a, new Date(1000), new Date(1000));
    utimesSync(b, new Date(2000), new Date(2000));
    assert.equal(turnIndexOf(root, "first", "c"), 0);
    assert.equal(turnIndexOf(root, "second", "c"), 1);
  });
});

describe("consent", () => {
  it("treats absence as NO", () => {
    assert.equal(captureVerdict(null).mayUpload, false);
    assert.equal(captureVerdict({}).mayUpload, false);
    assert.equal(captureVerdict({ capture: {} }).mayUpload, false);
  });

  it("does not accept a truthy non-true", () => {
    assert.equal(captureVerdict({ capture: { turns: "false" } }).mayUpload, false);
    assert.equal(captureVerdict({ capture: { turns: 1 } }).mayUpload, false);
    assert.equal(captureVerdict({ capture: { turns: true } }).mayUpload, true);
  });

  it("passes the server's own refusal through", () => {
    const v = captureVerdict({ capture: { turns: false, reason: "an operator enables it." } });
    assert.equal(v.reason, "an operator enables it.");
  });
});

function fakeTransport({ turns = true, reason = null, registerFails = null } = {}) {
  const batches = [];
  return {
    batches,
    registered: [],
    verdictReads: [],
    /** Every control-plane method called, in order. The ORDER is asserted. */
    calls: [],
    register(spec) {
      this.calls.push("register");
      this.registered.push(spec);
      if (registerFails) throw new Error(registerFails);
      return { capture: { turns } };
    },
    async captureCurrent(agentId) {
      this.calls.push("captureCurrent");
      this.verdictReads.push(agentId);
      return { agent_id: agentId,
               capture: reason ? { turns, reason } : { turns } };
    },
    async reportTurns(agentId, ts) { batches.push(ts); return {}; },
    get sent() { return batches.flat(); },
  };
}

describe("uploading", () => {
  const uploaderFor = (root, transport, extra = {}) => {
    const u = createTurnUploader({
      transport, agentId: "a1", root, flushEvery: FLUSH_EVERY, ...extra,
    });
    u.setVerdict({ mayUpload: true });
    return u;
  };

  it("sends nothing until the control plane says yes", async () => {
    const root = tmp();
    makeTurn(root, "r", { task: "t", answer: "a" });
    const tr = fakeTransport();
    const u = createTurnUploader({ transport: tr, agentId: "a1", root });
    assert.deepEqual(await u.flush(), { sent: 0, notPermitted: true });
    assert.deepEqual(tr.sent, []);
  });

  it("uploads answered turns", async () => {
    const root = tmp();
    makeTurn(root, "r1", { task: "t", answer: "a", conversation: "c" });
    const tr = fakeTransport();
    assert.equal((await uploaderFor(root, tr).flush()).sent, 1);
    assert.equal(tr.sent[0].turn_id, "r1");
  });

  it("holds back an unanswered turn, and sends it at shutdown", async () => {
    const root = tmp();
    makeTurn(root, "r1", { task: "t", calls: [OK_CALL] });
    const tr = fakeTransport();
    const u = uploaderFor(root, tr);
    assert.equal((await u.flush()).sent, 0, "an answer may still be coming");
    assert.equal((await u.flush({ includeUnanswered: true })).sent, 1);
    assert.equal(tr.sent[0].final_text, null);
  });

  it("does not send the same turn twice", async () => {
    const root = tmp();
    makeTurn(root, "r1", { task: "t", answer: "a" });
    const tr = fakeTransport();
    const u = uploaderFor(root, tr);
    await u.flush();
    await u.flush();
    assert.equal(tr.sent.length, 1);
  });

  it("keeps the uploaded marker OUT of the turn directories", async () => {
    // Writing a marker inside a turn's directory bumps its MTIME, and mtime is
    // the ordering key for turn_index. Uploading would silently reorder every
    // conversation it touched.
    const root = tmp();
    const dir = makeTurn(root, "r1", { task: "t", answer: "a", conversation: "c" });
    const before = statSync(dir).mtimeMs;
    await uploaderFor(root, fakeTransport()).flush();
    assert.equal(statSync(dir).mtimeMs, before,
      "uploading changed a turn directory's mtime; conversation order is now wrong");
    assert.ok(existsSync(join(root, UPLOADED_INDEX)));
  });

  it("batches at the intake's cap", async () => {
    const root = tmp();
    for (let i = 0; i < BATCH_SIZE + 5; i += 1) {
      makeTurn(root, `r${String(i).padStart(3, "0")}`, { task: "t", answer: "a" });
    }
    const tr = fakeTransport();
    await uploaderFor(root, tr).flush();
    assert.equal(tr.batches.length, 2);
    assert.equal(tr.batches[0].length, BATCH_SIZE);
  });

  it("retries a failed batch rather than marking it sent", async () => {
    const root = tmp();
    makeTurn(root, "r1", { task: "t", answer: "a" });
    let fail = true;
    const tr = {
      sentIds: [],
      async reportTurns(_a, turns) {
        if (fail) { fail = false; throw new Error("502"); }
        this.sentIds.push(...turns.map((t) => t.turn_id));
      },
    };
    const u = uploaderFor(root, tr);
    assert.equal((await u.flush()).sent, 0);
    assert.equal((await u.flush()).sent, 1, "a failed batch must be retried");
    assert.deepEqual(tr.sentIds, ["r1"]);
  });

  it("never rejects when the control plane is down", async () => {
    const root = tmp();
    makeTurn(root, "r1", { task: "t", answer: "a" });
    const u = uploaderFor(root, {
      reportTurns: async () => { throw new Error("unreachable"); },
    });
    await assert.doesNotReject(async () => { await u.flush(); });
  });

  it("flushes on the cadence, not on every turn", async () => {
    const root = tmp();
    makeTurn(root, "r1", { task: "t", answer: "a" });
    const tr = fakeTransport();
    const u = uploaderFor(root, tr);
    for (let i = 0; i < FLUSH_EVERY - 1; i += 1) assert.equal(u.note(), null);
    await u.note();
    assert.equal(tr.sent.length, 1);
  });
});

/**
 * A host api that enforces the CONVERSATION GATE the way OpenClaw does:
 * `registerTypedHook` drops `agent_end` for a non-bundled plugin unless
 * `allowConversationAccess === true`, and the refusal is a BARE RETURN --
 * `api.on()` reports nothing either way, so the plugin cannot detect it
 * afterwards. A fixture whose `on()` records every hook cannot see the defect
 * this suite exists for, which is exactly why the old one did not.
 */
function hostApi({ allowConversationAccess = false } = {}) {
  const hooks = [];
  return {
    hooks,
    logger: { info() {}, warn() {} },
    on(name, fn) {
      if (name === "agent_end" && !allowConversationAccess) return;
      hooks.push({ name, fn });
    },
    config: {
      plugins: {
        entries: { [PLUGIN_ID]: { hooks: { allowConversationAccess } } },
      },
    },
    fire(name, ...args) {
      for (const h of hooks) if (h.name === name) h.fn(...args);
    },
  };
}

/** Let a not-awaited cadence flush run to completion. */
async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

/** Backdate a turn directory past the settle window: it stopped changing. */
function age(dir) {
  const t = new Date(Date.now() - UNANSWERED_SETTLE_MS - 60_000);
  utimesSync(dir, t, t);
  return dir;
}

/** Wire the production lane against a fake control plane, verdict already in. */
async function wireCapture(root, a, tr) {
  const out = registerTurnCapture(a, {
    config: { apiKey: "k", agentId: "a1" },
    turns: createTurnCapture({ root }),
    pluginId: PLUGIN_ID,
    logger: a.logger,
    env: { PERCEPTEYE_CAPTURE_DIR: root },
    makeTransport: () => tr,
  });
  await settle();
  assert.equal(out.uploader.mayUpload, true, "the fake verdict did not land");
  return out;
}

describe("the cadence hangs off a hook the host actually delivers", () => {
  it("flushes after FLUSH_EVERY message_received, with agent_end DROPPED", async () => {
    // THE DEFECT THIS SUITE EXISTS FOR. `uploader.note()` -- the only thing
    // that advances the flush counter -- used to be called from the
    // `agent_end` handler alone. `agent_end` is the one hook this host drops
    // for a non-bundled plugin, and the only other trigger is `gateway_stop`,
    // which a gateway that keeps running never reaches. So the default
    // install uploaded NOTHING, EVER, while the startup log told the operator
    // its turns were being uploaded. The old cadence test called `u.note()`
    // by hand and never asked which hook drives it, so it passed green.
    const root = tmp();
    const a = hostApi();
    const tr = fakeTransport();
    await wireCapture(root, a, tr);
    assert.ok(!a.hooks.some((h) => h.name === "agent_end"),
      "the fixture must model the host DROPPING the conversation hook");

    // One turn already on disk and finished, so a flush has something to send.
    age(makeTurn(root, "earlier", { task: "t", answer: "a" }));

    for (let i = 0; i < FLUSH_EVERY; i += 1) {
      a.fire("message_received", { runId: `r${i}`, content: "hi", sessionKey: "c" }, {});
    }
    await settle();
    assert.deepEqual(tr.sent.map((t) => t.turn_id), ["earlier"],
      "FLUSH_EVERY user messages did not trigger an upload; the cadence is " +
      "still waiting on a hook this host does not deliver");
  });

  it("does not flush on agent_end, so the cadence stays Python's", async () => {
    // Python increments `_turns_since_flush` in `turn()` and NOT in
    // `record_answer`; counting in both places would flush a granted install
    // at twice the documented rate, and "same cadence" is a promise this
    // package makes in its first paragraph.
    const root = tmp();
    const a = hostApi({ allowConversationAccess: true });
    const tr = fakeTransport();
    await wireCapture(root, a, tr);
    assert.ok(a.hooks.some((h) => h.name === "agent_end"),
      "the granted fixture must actually subscribe the conversation hook");

    age(makeTurn(root, "earlier", { task: "t", answer: "a" }));
    for (let i = 0; i < FLUSH_EVERY; i += 1) {
      a.fire("agent_end",
             { runId: `r${i}`, messages: [{ role: "assistant", content: "a" }] }, {});
    }
    await settle();
    assert.deepEqual(tr.sent, [], "agent_end advanced the flush counter");
  });

  it("sends unanswered turns on the cadence when no answer is coming", async () => {
    // "Hold a turn back, an answer may still be coming" is only true where
    // answers come at all. With `agent_end` dropped, EVERY turn has
    // `final_text: null` forever -- so a cadence that skips them sends zero
    // turns however often it fires.
    const root = tmp();
    const a = hostApi();
    const tr = fakeTransport();
    await wireCapture(root, a, tr);

    age(makeTurn(root, "quiet", { task: "t", calls: [OK_CALL] }));
    for (let i = 0; i < FLUSH_EVERY; i += 1) {
      a.fire("message_received", { runId: `r${i}`, content: "hi" }, {});
    }
    await settle();
    assert.deepEqual(tr.sent.map((t) => t.turn_id), ["quiet"],
      "the cadence fired but sent nothing: every turn is unanswered here");
    assert.equal(tr.sent[0].final_text, null);
    assert.deepEqual(tr.sent[0].tool_calls, [OK_CALL]);
  });

  it("still holds an unanswered turn back while an answer may be coming", async () => {
    const root = tmp();
    age(makeTurn(root, "r1", { task: "t" }));
    const tr = fakeTransport();
    const u = createTurnUploader({
      transport: tr, agentId: "a1", root, flushEvery: 1,
    });
    u.setVerdict({ mayUpload: true });
    await u.note();
    assert.deepEqual(tr.sent, [],
      "this host delivers agent_end, so an answer may still be coming");
  });

  it("will not send a turn that is still being written", async () => {
    // The cadence fires from inside the NEWEST turn's own handler, before that
    // turn has called a tool. Sending it there marks it uploaded, and the
    // calls it goes on to make are never sent -- a worse loss than the one the
    // cadence exists to fix. Quiescence is the only "this turn is done" signal
    // left once there is no answer to wait for.
    const root = tmp();
    makeTurn(root, "inflight", { task: "t" });
    const tr = fakeTransport();
    const u = createTurnUploader({
      transport: tr, agentId: "a1", root, flushEvery: 1, answersExpected: false,
    });
    u.setVerdict({ mayUpload: true });
    await u.note();
    assert.deepEqual(tr.sent, [],
      "a turn written moments ago was uploaded and marked sent; its tool " +
      "calls can now never be sent");

    age(turnDir(root, "inflight"));
    await u.note();
    assert.deepEqual(tr.sent.map((t) => t.turn_id), ["inflight"]);
  });

  it("sends even a just-written unanswered turn at shutdown", async () => {
    // Shutdown does NOT wait out the settle window: nothing more is coming for
    // anything by then, so waiting would only lose the turn.
    const root = tmp();
    makeTurn(root, "inflight", { task: "t" });
    const tr = fakeTransport();
    const u = createTurnUploader({ transport: tr, agentId: "a1", root });
    u.setVerdict({ mayUpload: true });
    assert.equal((await u.flush({ includeUnanswered: true })).sent, 1);
  });
});

describe("asking for the verdict is a READ", () => {
  it("READS the verdict and never registers", async () => {
    // THE POINT OF THE ROUTE. Reading it through `POST /agents` upserts, and a
    // registration omitting `discovered_agent` is recorded as introspection
    // `disabled` -- which stops that agent's description driving workflow
    // generation, so re-asking a permission question must not write.
    //
    // This is about `announce` ALONE. The agent IS registered, once, at
    // startup by `enrol` -- see the suite below -- because that row is what
    // the verdict is computed from. What must never come back is registering
    // in order to ASK.
    const tr = fakeTransport();
    const root = tmp();
    const u = createTurnUploader({ transport: tr, agentId: "a1", root });
    await announce({
      transport: tr, uploader: u,
      config: { agentId: "a1" }, pluginId: PLUGIN_ID, logger: null, env: {},
    });
    assert.deepEqual(tr.registered, [],
      "asking for the verdict registered the agent; that write has a side " +
      "effect on introspection_state that this route exists to avoid");
    assert.deepEqual(tr.verdictReads, ["a1"]);
    assert.equal(u.mayUpload, true);
  });

  it("leaves uploading OFF when the control plane cannot be reached", async () => {
    const root = tmp();
    const u = createTurnUploader({ transport: {}, agentId: "a1", root });
    await announce({
      transport: { captureCurrent() { throw new Error("down"); } },
      uploader: u, config: { agentId: "a1" }, pluginId: PLUGIN_ID,
      logger: null, env: {},
    });
    assert.equal(u.mayUpload, false);
  });

  it("passes the server's refusal through to the operator", async () => {
    const root = tmp();
    const tr = fakeTransport({ turns: false, reason: "an operator enables it." });
    const u = createTurnUploader({ transport: tr, agentId: "a1", root });
    const v = await announce({
      transport: tr, uploader: u, config: { agentId: "a1" },
      pluginId: PLUGIN_ID, logger: null, env: {},
    });
    assert.equal(v.mayUpload, false);
    assert.equal(u.refusal, "an operator enables it.");
  });
});

/**
 * REGISTRATION -- the producer of the row every consent decision needs.
 *
 * THE DEFECT THIS SUITE EXISTS FOR. `AttachTransport.register` shipped with no
 * caller at all, so no install ever created a `FlywheelAgent` row -- and
 * `POST /agents` is the only route in the control plane that creates one. The
 * consequences are not "the dashboard looks empty": the operator's consent
 * control, `POST /flywheel-agents/{id}/production-capture`, 404s on a missing
 * row, and `capture_verdict` answers "this agent is not registered, so no
 * operator has been able to enable production capture for it. Register it
 * first." So production turn upload -- the whole point of this file -- was
 * unreachable by construction, and the remedy the control plane named was the
 * one call the package did not make.
 *
 * Every test above stayed green because they wire the uploader by hand and
 * assert what happens once permission is granted; none of them asked how an
 * agent could ever be granted it.
 */
describe("the agent is registered, so an operator has something to enable", () => {
  it("registers ONCE at startup, and BEFORE it asks for the verdict", async () => {
    // The order is load-bearing, not tidiness. The verdict is computed FROM
    // the agent row, so a first start that asks first can only be told "not
    // registered" -- an answer whose remedy is the call it just skipped.
    const root = tmp();
    const a = hostApi();
    const tr = fakeTransport();
    await wireCapture(root, a, tr);
    assert.deepEqual(tr.calls, ["register", "captureCurrent"],
      "the agent row must exist before the permission question is asked");
    assert.equal(tr.registered.length, 1, "registration must happen ONCE");
  });

  it("sends a registration the control plane will accept", async () => {
    // The modes and contract versions `POST /agents` accepts, which it checks
    // BEFORE anything else and answers 422 on. Vendored rather than imported
    // for the same reason `config-gate.test.js` vendors the route set: this
    // package must not import the control plane. A registration that 422s is
    // indistinguishable, from the operator's side, from no registration at
    // all.
    const SUPPORTED_MODES = ["rollout", "production"];
    const SUPPORTED_CONTRACT_VERSIONS = ["flywheel/1"];

    const root = tmp();
    const tr = fakeTransport();
    await wireCapture(root, hostApi(), tr);
    const spec = tr.registered[0];

    assert.equal(spec.agent_id, "a1", "the row must be keyed on OUR agent id");
    assert.ok(SUPPORTED_MODES.includes(spec.mode),
      `mode=${JSON.stringify(spec.mode)} is refused with 422 mode_not_available`);
    assert.equal(spec.mode, "production",
      "this process serves users and claims no rollouts; sending the donor " +
      "value would make the field carry zero bits");
    assert.ok(SUPPORTED_CONTRACT_VERSIONS.includes(spec.contract_version),
      `contract_version=${JSON.stringify(spec.contract_version)} is refused ` +
      `with 422 unsupported_contract_version`);
    assert.equal(spec.contract_version, CONTRACT_VERSION,
      "the registration must claim the contract this package speaks");
    assert.equal(spec.sdk, SDK_UA, "one version, from package.json");
    assert.equal(spec.reports_tool_calls, true,
      "this plugin does report tool outcomes; false earns the " +
      "flywheel_does_not_report_tool_outcomes grade reason for no reason");
  });

  it("sends discovered_agent as an explicit null ON THE WIRE", async () => {
    // THE THREE-STATE FIELD, and the one assertion that has to survive
    // serialisation. The handler branches on key ABSENT (-> introspection
    // `disabled`, "the customer opted out") versus key = null (-> `unreadable`,
    // "we looked and could not describe it"), and `JSON.stringify` DROPS a key
    // whose value is `undefined` -- so `discovered_agent: undefined` would
    // pass a naive equality check here and arrive as the opting-out state.
    //
    // `disabled` is the destructive one: `FlywheelAgentRepository.upsert`
    // writes it onto the row unconditionally, which stops an existing
    // description driving workflow generation. That side effect is why the
    // old permission-probe registration was removed; a registration that
    // re-introduced it would trade this defect for that one.
    const root = tmp();
    const tr = fakeTransport();
    await wireCapture(root, hostApi(), tr);
    const wire = JSON.parse(JSON.stringify(tr.registered[0]));

    assert.ok("discovered_agent" in wire,
      "discovered_agent is ABSENT on the wire, which records introspection " +
      "as `disabled` -- a claim that the customer opted out, and one that " +
      "overwrites a description an operator can no longer get back");
    assert.equal(wire.discovered_agent, null,
      "the honest state is `unreadable`: this lane has no description to " +
      "send, and `unreadable` is the one state that preserves a stored one");
  });

  it("still reads the verdict when the registration is REFUSED", async () => {
    // A registration the intake dislikes must not also cost this process its
    // permission. An operator may have consented long ago; the row may already
    // exist. Same split the Python SDK's `attach()` makes.
    const root = tmp();
    const tr = fakeTransport({ registerFails: "422 unsupported_contract_version" });
    const a = hostApi();
    const out = registerTurnCapture(a, {
      config: { apiKey: "k", agentId: "a1" },
      turns: createTurnCapture({ root }),
      pluginId: PLUGIN_ID,
      logger: a.logger,
      env: { PERCEPTEYE_CAPTURE_DIR: root },
      makeTransport: () => tr,
    });
    await settle();
    assert.deepEqual(tr.calls, ["register", "captureCurrent"]);
    assert.equal(out.uploader.mayUpload, true,
      "a refused registration swallowed the verdict read with it");
  });

  it("never throws, and never rejects, when the control plane is down", async () => {
    // The host treats a throw from the plugin's `register()` as a FAILED
    // PLUGIN LOAD, which would take local capture -- the half that needs no
    // account at all -- down with a control plane the customer may not even
    // have configured.
    const rejections = [];
    const onUnhandled = (err) => rejections.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
      const root = tmp();
      const a = hostApi();
      const dead = {
        register() { throw new Error("ECONNREFUSED"); },
        captureCurrent() { throw new Error("ECONNREFUSED"); },
      };
      assert.doesNotThrow(() => registerTurnCapture(a, {
        config: { apiKey: "k", agentId: "a1" },
        turns: createTurnCapture({ root }),
        pluginId: PLUGIN_ID,
        logger: a.logger,
        env: { PERCEPTEYE_CAPTURE_DIR: root },
        makeTransport: () => dead,
      }));
      await settle();
      assert.deepEqual(rejections, [], "an unhandled rejection escaped");
      // And capture still works with no control plane at all.
      a.fire("message_received", { runId: "r", content: "hi", sessionKey: "c" }, {});
      assert.ok(existsSync(join(root, "r", TURNS_FILENAME)));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("attempts NO registration without an API key", async () => {
    // THE CONSENT BOUNDARY, unchanged: no key means nothing leaves the
    // machine, and a registration is something leaving the machine.
    //
    // TWO assertions because one is not enough. "No transport was built" alone
    // stays green if the registration is hoisted OUT of the key gate: with no
    // key the transport is `null`, `null.register` throws, and `enrol` catches
    // it -- so the attempt is invisible except in the log it then writes. A
    // keyless install must not be told its registration failed; it never made
    // one.
    const root = tmp();
    const a = hostApi();
    const said = [];
    const logger = { info: (m) => said.push(m), warn: (m) => said.push(m) };
    let built = 0;
    const out = registerTurnCapture(a, {
      config: { apiKey: null, agentId: "a1" },
      turns: createTurnCapture({ root }),
      pluginId: PLUGIN_ID,
      logger,
      env: { PERCEPTEYE_CAPTURE_DIR: root },
      makeTransport: () => { built += 1; return fakeTransport(); },
    });
    await settle();
    assert.equal(built, 0, "a keyless install built a transport");
    assert.equal(out.uploader, null);
    assert.deepEqual(
      said.filter((m) => /could not register/.test(m)), [],
      "a keyless install tried to register and reported the failure",
    );
  });
});

describe("the production lane is wired", () => {
  const api = (over = {}) => {
    const hooks = [];
    return {
      hooks, id: PLUGIN_ID, logger: { info() {}, warn() {} },
      on: (n, fn) => hooks.push({ name: n, fn }),
      config: { plugins: { entries: { [PLUGIN_ID]: { hooks: {} } } } },
      ...over,
    };
  };

  it("subscribes the two turn hooks in production mode", () => {
    const a = api();
    register(a, {}, { PERCEPTEYE_AGENT_MODE: "production" });
    const names = a.hooks.map((h) => h.name);
    for (const h of ["message_received", "agent_end", "after_tool_call"]) {
      assert.ok(names.includes(h), `production did not subscribe '${h}'`);
    }
  });

  it("does NOT subscribe them in training mode", () => {
    // Turn capture is the production lane. A training install's trajectory
    // belongs to a rollout, not to an end user's turn.
    const a = api();
    register(a, {}, { PERCEPTEYE_AGENT_MODE: "training" });
    assert.ok(!a.hooks.map((h) => h.name).includes("message_received"));
  });

  it("routes each tool call into its own turn directory", () => {
    const root = mkdtempSync(join(tmpdir(), "percepteye-route-"));
    const a = api();
    register(a, {}, {
      PERCEPTEYE_AGENT_MODE: "production", PERCEPTEYE_CAPTURE_DIR: root,
    });
    const tool = a.hooks.find((h) => h.name === "after_tool_call").fn;
    tool({ toolName: "lookup", params: { id: 1 }, runId: "runA", result: "ok" }, {});
    tool({ toolName: "lookup", params: { id: 2 }, runId: "runB", result: "ok" }, {});
    assert.ok(existsSync(join(root, "runA", "tool_calls.jsonl")));
    assert.ok(existsSync(join(root, "runB", "tool_calls.jsonl")));
  });

  it("DROPS a tool call it cannot attribute to a turn", () => {
    // An unattributable call landing in some other turn's trajectory is the
    // misattribution this package refuses everywhere else.
    const root = mkdtempSync(join(tmpdir(), "percepteye-drop-"));
    const a = api();
    register(a, {}, {
      PERCEPTEYE_AGENT_MODE: "production", PERCEPTEYE_CAPTURE_DIR: root,
    });
    const tool = a.hooks.find((h) => h.name === "after_tool_call").fn;
    tool({ toolName: "lookup", params: {}, result: "ok" }, {});
    assert.deepEqual(readdirSync(root), []);
  });

  it("captures locally with no API key, and contacts nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "percepteye-nokey-"));
    const a = api();
    const out = register(a, {}, {
      PERCEPTEYE_AGENT_MODE: "production", PERCEPTEYE_CAPTURE_DIR: root,
    });
    assert.equal(out.capture.uploader, null);
    const msg = a.hooks.find((h) => h.name === "message_received").fn;
    msg({ runId: "r", content: "hello", sessionKey: "c" }, {});
    assert.ok(existsSync(join(root, "r", TURNS_FILENAME)));
  });
});

describe("reading the answer", () => {
  it("takes the last assistant message and joins parts", () => {
    assert.equal(lastAssistantText([
      { role: "assistant", content: "a" }, { role: "user", content: "b" },
      { role: "assistant", content: [{ text: "c" }, { text: "d" }] },
    ]), "cd");
  });

  it("returns empty rather than inventing one", () => {
    assert.equal(lastAssistantText(null), "");
    assert.equal(lastAssistantText([{ role: "user", content: "x" }]), "");
  });
});

describe("where capture lands", () => {
  it("honours an explicit dir above the default", () => {
    assert.equal(captureRoot({ PERCEPTEYE_CAPTURE_DIR: "/x" }), "/x");
    assert.match(captureRoot({ PERCEPTEYE_HOME: "/h" }), /^\/h\/captured$/);
  });


});

describe("one answer per question", () => {
  it("both lanes read the agent's answer through the SAME function", async () => {
    // `lastAssistantText` and `conversationAccessGranted` were each written
    // TWICE -- once in the rollout driver, once here -- with the same intent
    // and slightly different code. Two copies of one answer is the shape this
    // codebase keeps finding, and it always fails the same way: one gets
    // fixed. They now live in `host.js`; this asserts both lanes reach the
    // same object, so a re-fork is a red test rather than a silent drift.
    const host = await import("../src/host.js");
    const rollout = await import("../src/rollout.js");
    const capture = await import("../src/capture.js");
    for (const name of ["lastAssistantText", "conversationAccessGranted"]) {
      assert.equal(rollout[name], host[name], `${name} re-forked in rollout.js`);
      assert.equal(capture[name], host[name], `${name} re-forked in capture.js`);
    }
  });
});
