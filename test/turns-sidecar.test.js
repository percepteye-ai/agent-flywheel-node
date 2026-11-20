/**
 * The turn directory's write-once files and the text it keeps (ND-H17).
 */
import "./support/home.js";
import { strict as assert } from "node:assert";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";

import {
  AGENT_FINGERPRINT_CONFLICT_FILENAME, CONVERSATION_ID_FILENAME,
  MAX_TEXT_CHARS, TASK_ID_CONFLICT_FILENAME, readConversationId,
  readModelBoundary, readTurnText, recordConversationId, recordModelBoundary,
  recordTurnText, turnWire,
} from "../src/turns.js";
import { OBSERVATION_FILENAME } from "../src/genai-otlp.js";
import { TOOL_CALLS_FILENAME, toWire } from "../src/trajectory.js";

const tmp = () => mkdtempSync(join(tmpdir(), "pe-sidecar-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("write-once sidecars", () => {
  it("never record a false conflict when writers race with the same value", async () => {
    // Mutation: back to `wx` + read -> a racer reads the empty file, red
    // (52 of 300 turns conflicted with six writers before the fix).
    const root = tmp();
    const writers = 6;
    const turns = 100;
    const sab = new SharedArrayBuffer(8);
    const workers = [];
    for (let i = 0; i < writers; i += 1) {
      workers.push(new Worker(new URL("./support/sidecar-race-worker.js", import.meta.url),
        { workerData: { root, sab, writers, turns } }));
    }
    await Promise.all(workers.map((w) => new Promise((resolve, reject) => {
      w.on("exit", resolve);
      w.on("error", reject);
    })));
    const conflicted = [];
    for (let k = 0; k < turns; k += 1) {
      for (const name of [TASK_ID_CONFLICT_FILENAME, AGENT_FINGERPRINT_CONFLICT_FILENAME]) {
        if (existsSync(join(root, `t${k}`, name))) conflicted.push(`t${k}/${name}`);
      }
    }
    assert.deepEqual(conflicted, []);
  });

  it("binds a turn's conversation once, and never moves its start", async () => {
    // Mutation: back to rewriting the file on every hook -> its mtime (the
    // turn's start) moves and a different id replaces the first, red.
    const dir = join(tmp(), "t1");
    assert.equal(recordConversationId(dir, "c1"), true);
    const started = statSync(join(dir, CONVERSATION_ID_FILENAME)).mtimeMs;
    await sleep(25);
    assert.equal(recordConversationId(dir, "c1"), true);
    assert.equal(recordConversationId(dir, "c2"), false);
    assert.equal(readConversationId(dir), "c1");
    assert.equal(statSync(join(dir, CONVERSATION_ID_FILENAME)).mtimeMs, started);
  });

  it("gives a 0-byte observation file its trace header", () => {
    // Mutation: back to existsSync -> no header, the boundary is unreadable, red.
    const dir = join(tmp(), "t1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, OBSERVATION_FILENAME), "");
    assert.equal(recordModelBoundary(dir, {
      start: "100", end: "300",
      operations: [{ operation: "execute_tool", span_id: "1".repeat(16),
        start_time_unix_nano: "100", end_time_unix_nano: "200", tool_name: "x" }],
    }), true);
    assert.notEqual(readModelBoundary(dir), null);
  });
});

describe("turn text the intake can store", () => {
  it("removes NUL and replaces a lone surrogate", () => {
    // Mutation: drop the scrub -> NUL and the lone surrogate are kept, red.
    const dir = join(tmp(), "t1");
    assert.equal(recordTurnText(dir, "task", "a\u0000b\ud800c"), true);
    assert.equal(readTurnText(dir).task, "ab�c");
    assert.equal(recordTurnText(dir, "answer", "\u0000\u0000"), false,
      "text that is only NUL is no text");
  });

  it("cuts a huge paste without spreading it", () => {
    // Mutation: back to [...text].slice -> millions of one-character strings
    // allocated for a cut at 20k; measured several times slower, red.
    const huge = "😀".repeat(4_000_000);
    const started = performance.now();
    const dir = join(tmp(), "t1");
    recordTurnText(dir, "task", huge);
    const took = performance.now() - started;
    assert.equal([...readTurnText(dir).task].length, MAX_TEXT_CHARS);
    assert.ok(took < 150, `cutting took ${took.toFixed(0)}ms`);
  });
});

describe("the tool-call tri-state", () => {
  it("reads an unreadable trajectory as no observation, never as zero calls", () => {
    // Mutation: back to existsSync -> tool_calls: [], red.
    const dir = join(tmp(), "t1");
    mkdirSync(join(dir, TOOL_CALLS_FILENAME), { recursive: true });
    recordTurnText(dir, "task", "hi");
    assert.equal(turnWire(dir).tool_calls, null);
  });

  it("sends arguments as an object, the way Python builds them", () => {
    // Mutation: pass an array through -> it reaches the wire as an array, red.
    const call = (args) => toWire({ name: "t", args, outcome: "ok" }).arguments;
    assert.deepEqual(call([["a", 1], ["b", 2]]), { a: 1, b: 2 });
    assert.deepEqual(call([1, 2]), {});
    assert.deepEqual(call({ q: 1 }), { q: 1 });
    assert.deepEqual(call("x"), {});
  });
});
