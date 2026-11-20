/**
 * The flush is off the hook's path and scales with the capture root (ND-C4);
 * a turn's quiet and its conversation order are read from the right files
 * (ND-C7); and a flush asked for while one runs is coalesced, never dropped,
 * with the shutdown flush returned to the host, bounded (ND-C5).
 */
import "./support/home.js";
import { strict as assert } from "node:assert";
import fs, {
  appendFileSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { describe, it, mock } from "node:test";

import {
  SHUTDOWN_FLUSH_GRACE_MS, UNANSWERED_SETTLE_MS, createTurnCapture,
  createTurnUploader, registerTurnCapture,
} from "../src/capture.js";
import {
  CONVERSATION_ID_FILENAME, TURNS_FILENAME, turnDir, turnIndexOf,
} from "../src/turns.js";
import { TOOL_CALLS_FILENAME } from "../src/trajectory.js";

const tmp = () => mkdtempSync(join(tmpdir(), "pe-flush-"));
const HOST = { agentId: "main" };

function turn(root, runId, { conversation = "c", answer = "ok", calls = false } = {}) {
  const cap = createTurnCapture({ root });
  cap.onMessageReceived({ runId, content: "hi", sessionKey: conversation }, HOST);
  if (calls) appendFileSync(join(turnDir(root, runId), TOOL_CALLS_FILENAME), "");
  if (answer) {
    cap.onAgentEnd({ runId, messages: [{ role: "assistant", content: answer }] }, HOST);
  }
  return turnDir(root, runId);
}

/** Set every file in a turn, and the turn, to `when` (seconds). */
function stamp(dir, when) {
  for (const name of readdirSync(dir)) utimesSync(join(dir, name), when, when);
  utimesSync(dir, when, when);
}

function recorder() {
  const sent = [];
  return {
    sent,
    async captureCurrent() { return { capture: { turns: true, model_content: true } }; },
    async reportTurns(_a, turns) {
      sent.push(...turns);
      return { turns: turns.map((t) => ({ turn_id: t.turn_id, accepted: true })) };
    },
  };
}

function granted(root, transport, extra = {}) {
  const u = createTurnUploader({ transport, agentId: "a1", root, ...extra });
  u.setVerdict({ mayUpload: true, mayCaptureModelContent: true });
  return u;
}

describe("the flush is off the hook's path (ND-C4)", () => {
  /** 2,000 answered turns in 20 conversations, written as the hooks write
   *  them (the files, not the hooks: building them is not what is timed). */
  let built = null;
  const big = () => {
    if (built) return built;
    const root = tmp();
    built = root;
    for (let i = 0; i < 2000; i += 1) {
      const dir = join(root, `t${i}`);
      mkdirSync(dir);
      writeFileSync(join(dir, CONVERSATION_ID_FILENAME), `c${i % 20}`);
      writeFileSync(join(dir, TURNS_FILENAME),
        `${JSON.stringify({ kind: "task", text: "hi" })}\n` +
        `${JSON.stringify({ kind: "answer", text: "ok" })}\n`);
    }
    return root;
  };

  it("returns from the hook before anything is listed", async () => {
    // Mutation: back to the synchronous pending() -> note() lists the root
    // (2,000 times over) before it returns, red.
    const root = big();
    // Nothing is marked sent here: the next test sends this same root.
    const u = granted(root, { ...recorder(), async reportTurns() {
      throw new Error("not this test's question");
    } }, { flushEvery: 1 });
    const listed = [];
    const real = { sync: fs.readdirSync, async: fs.promises.readdir };
    fs.readdirSync = (...a) => { listed.push("sync"); return real.sync(...a); };
    fs.promises.readdir = (...a) => { listed.push("async"); return real.async(...a); };
    syncBuiltinESMExports();
    let flushing;
    const started = performance.now();
    try {
      flushing = u.note();
    } finally {
      fs.readdirSync = real.sync;
      fs.promises.readdir = real.async;
      syncBuiltinESMExports();
    }
    const took = performance.now() - started;
    assert.deepEqual(listed, [], "the hook listed the capture root");
    assert.ok(took < 20, `the hook took ${took.toFixed(1)}ms`);
    await flushing;
  });

  it("never blocks the event loop for long over a 2,000-turn root", async () => {
    // Mutation: back to one synchronous listing per turn -> seconds of
    // blocking, red.
    const root = big();
    const tr = recorder();
    const u = granted(root, tr);
    const delay = monitorEventLoopDelay({ resolution: 5 });
    delay.enable();
    const counts = await u.flush();
    delay.disable();
    assert.equal(counts.sent, 2000);
    const worstMs = delay.max / 1e6;
    // Minutes before the fix (one synchronous listing per turn: 2,000 x
    // 2,000); ~10-30ms after on a quiet machine. The bound is far from both
    // on purpose: a host at load ~20 stalls this process 150-260ms with
    // nothing of ours running, and a bound inside that range made the test
    // red on scheduling rather than on the code.
    assert.ok(worstMs < 2000, `the event loop was blocked for ${worstMs.toFixed(0)}ms`);
    // One listing gave every turn its place in its conversation.
    const byConversation = new Map();
    for (const t of tr.sent) {
      byConversation.set(t.conversation_id,
        [...(byConversation.get(t.conversation_id) ?? []), t.turn_index]);
    }
    for (const indices of byConversation.values()) {
      assert.deepEqual([...indices].sort((a, b) => a - b),
        indices.map((_, i) => i));
    }
  });
});

describe("a turn's quiet and its order (ND-C7)", () => {
  it("is not quiet while a file in it is still being appended to", async () => {
    // Mutation: back to the directory's mtime -> appending a tool call does
    // not move it, and the turn is sent mid-run, red.
    const root = tmp();
    const dir = turn(root, "busy", { answer: null, calls: true });
    const old = (Date.now() - UNANSWERED_SETTLE_MS - 60_000) / 1000;
    stamp(dir, old);
    appendFileSync(join(dir, TOOL_CALLS_FILENAME),
      `${JSON.stringify({ name: "x", arguments: {}, outcome: "ok", status_code: null })}\n`);
    utimesSync(dir, old, old);
    const tr = recorder();
    const u = granted(root, tr, { answersExpected: false });
    await u.flush({ includeUnanswered: true, settleMs: UNANSWERED_SETTLE_MS });
    assert.deepEqual(tr.sent, []);
  });

  it("orders a conversation by when each turn started, ties by code point", async () => {
    // Mutation: order by the directory's mtime with localeCompare -> the
    // turn answered late moves behind the next one, and "a" sorts before
    // "B", red.
    const root = tmp();
    const first = turn(root, "first");
    const second = turn(root, "second");
    stamp(first, 1000);
    stamp(second, 2000);
    utimesSync(first, 3000, 3000); // a file created late in the first turn
    assert.equal(turnIndexOf(root, "first", "c"), 0);
    assert.equal(turnIndexOf(root, "second", "c"), 1);
    for (const name of ["a", "B"]) stamp(turn(root, name, { conversation: "d" }), 5000);
    assert.equal(turnIndexOf(root, "B", "d"), 0);
    assert.equal(turnIndexOf(root, "a", "d"), 1);
    const tr = recorder();
    await granted(root, tr).flush();
    const index = Object.fromEntries(tr.sent.map((t) => [t.turn_id, t.turn_index]));
    assert.deepEqual(index, { first: 0, second: 1, B: 0, a: 1 });
    utimesSync(join(first, CONVERSATION_ID_FILENAME), 1000, 1000);
  });
});

describe("a flush asked for while one runs (ND-C5)", () => {
  it("runs once more after it, and sends what arrived meanwhile", async () => {
    // Mutation: back to `{skipped: true}` -> the second call sends nothing
    // and the turn written meanwhile waits for some later flush, red.
    const root = tmp();
    turn(root, "one");
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tr = recorder();
    const real = tr.reportTurns;
    let calls = 0;
    tr.reportTurns = async (...args) => {
      calls += 1;
      if (calls === 1) await gate;
      return real(...args);
    };
    const u = granted(root, tr);
    const firstPass = u.flush();
    await new Promise((r) => setTimeout(r, 20));
    turn(root, "two");
    const secondPass = u.flush();
    const third = u.flush();
    assert.equal(third, secondPass, "callers arriving meanwhile share one rerun");
    release();
    assert.equal((await firstPass).sent, 1);
    assert.equal((await secondPass).sent, 1);
    assert.deepEqual(tr.sent.map((t) => t.turn_id), ["one", "two"]);
  });

  it("gateway_stop hands the host its flush, bounded", async () => {
    // Mutation: back to a handler that returns nothing -> the host does not
    // wait for the last chance, red.
    const root = tmp();
    const hooks = new Map();
    const tr = { ...recorder(), async register() { return {}; },
      async declareRulebook() { return {}; } };
    const out = registerTurnCapture({ on: (n, f) => hooks.set(n, f), config: {} }, {
      config: { apiKey: "k", agentId: "a1" }, turns: createTurnCapture({ root }),
      pluginId: "p", env: { PERCEPTEYE_CAPTURE_DIR: root }, makeTransport: () => tr,
    });
    await out.started;
    turn(root, "last", { answer: null });
    const stopping = hooks.get("gateway_stop")();
    assert.equal(typeof stopping?.then, "function");
    assert.equal((await stopping).sent, 1);

    // A control plane that never answers: the host is released at the grace.
    turn(root, "stuck");
    tr.reportTurns = () => new Promise(() => {});
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const stuck = hooks.get("gateway_stop")();
      mock.timers.tick(SHUTDOWN_FLUSH_GRACE_MS);
      assert.equal((await stuck).timedOut, true);
    } finally {
      mock.timers.reset();
    }
  });
});
