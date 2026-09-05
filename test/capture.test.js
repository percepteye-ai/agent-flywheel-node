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
  BATCH_SIZE, FLUSH_EVERY, UPLOADED_INDEX, announce, captureRoot,
  captureVerdict, createTurnCapture, createTurnUploader, lastAssistantText,
  readDescribedAgent, registerTurnCapture,
} from "../src/capture.js";
import {
  CONVERSATION_ID_FILENAME, MAX_TEXT_CHARS, TURNS_FILENAME, readTurnText,
  recordTurnText,
  turnDir, turnIndexOf, turnWire,
} from "../src/turns.js";
import { register, PLUGIN_ID } from "../src/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "percepteye-cap-"));

/** Build a turn on disk the way the hooks would. */
function makeTurn(root, runId, { task, answer, calls, conversation } = {}) {
  const cap = createTurnCapture({ root });
  if (task !== undefined) {
    cap.onMessageReceived({ runId, content: task, sessionKey: conversation });
  }
  if (calls) {
    const dir = turnDir(root, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tool_calls.jsonl"),
                  calls.map((c) => JSON.stringify(c)).join("\n") + (calls.length ? "\n" : ""),
                  "utf8");
  }
  if (answer !== undefined) {
    cap.onAgentEnd({ runId, messages: [{ role: "assistant", content: answer }] });
  }
  return turnDir(root, runId);
}

const OK_CALL = { name: "lookup", arguments: { id: "1" }, outcome: "ok", status_code: 200 };

describe("the on-disk format is the Python SDK's", () => {
  it("names the files exactly as the other end reads them", () => {
    // `percepteye_agent_flywheel.outcomes` opens these literal names.
    assert.equal(TURNS_FILENAME, "turns.jsonl");
    assert.equal(CONVERSATION_ID_FILENAME, "conversation_id");
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

  it("keeps a host-supplied turn id inside the root", () => {
    // A PROPERTY OF THE FUNCTION, not a filesystem probe. This first asserted
    // that `<root>/../../escape` did not exist -- which a mutation then
    // CREATED, outside any temp directory, where it survived the restore and
    // failed the test forever after. A test that can pollute the machine it
    // runs on is a test that stops meaning anything.
    const root = tmp();
    for (const hostile of ["../../escape", "/etc/passwd", "a/b", "..", ""]) {
      const dir = turnDir(root, hostile);
      assert.ok(dir.startsWith(`${root}/`),
        `turn id ${JSON.stringify(hostile)} escaped the root: ${dir}`);
      assert.ok(!dir.slice(root.length + 1).includes("/"),
        `turn id ${JSON.stringify(hostile)} became more than one segment: ${dir}`);
    }
    // ...and the sanitised name is what actually lands.
    createTurnCapture({ root }).onMessageReceived(
      { runId: "../../escape", content: "hi" });
    assert.deepEqual(readdirSync(root), ["....escape"]);
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

function fakeTransport() {
  const batches = [];
  return {
    batches,
    registered: [],
    register(spec) { this.registered.push(spec); return { capture: { turns: true } }; },
    async reportTurns(agentId, turns) { batches.push(turns); return {}; },
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

describe("registration reads the verdict without a harmful side effect", () => {
  it("sends discovered_agent EXPLICITLY NULL, never absent", async () => {
    // Mission Control reads an ABSENT key as "the customer opted out of
    // introspection", which flips introspection_state to `disabled` and stops
    // that agent's description driving workflow generation -- a real side
    // effect for a call made only to read a verdict. Explicit null means
    // "introspection ran and could not describe it", which leaves both stored
    // columns alone, and is true here.
    const tr = fakeTransport();
    const root = tmp();
    const u = createTurnUploader({ transport: tr, agentId: "a1", root });
    await announce({
      transport: tr, uploader: u,
      config: { agentId: "a1" }, pluginId: PLUGIN_ID, logger: null, env: {},
    });
    const spec = tr.registered[0];
    assert.ok("discovered_agent" in spec, "the key must be PRESENT");
    assert.equal(spec.discovered_agent, null);
    assert.equal(spec.mode, "production");
    assert.equal(u.mayUpload, true);
  });

  it("leaves uploading OFF when the control plane cannot be reached", async () => {
    const root = tmp();
    const u = createTurnUploader({ transport: {}, agentId: "a1", root });
    await announce({
      transport: { register() { throw new Error("down"); } },
      uploader: u, config: { agentId: "a1" }, pluginId: PLUGIN_ID,
      logger: null, env: {},
    });
    assert.equal(u.mayUpload, false);
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

  it("reads no description when there is no trajectory dir", () => {
    assert.equal(readDescribedAgent({}), null);
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
