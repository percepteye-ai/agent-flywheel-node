/**
 * Retention of the production capture on disk: the Python SDK's
 * `attach(retention_turns=...)` and `Attachment.prune()`, case for case.
 *
 * Capture is append-only and nothing else removes it, so a long-running
 * gateway keeps one directory per recording turn forever. Deleting is never a
 * default -- it is the customer's data -- so it happens only when asked, and
 * when it happens it must not quietly destroy what was about to be uploaded.
 * Each case mirrors one in the Python suite (tests/test_capture_cost.py,
 * tests/test_production_upload_producer.py, tests/test_production_turn_upload.py).
 */
import "./support/home.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PRUNE_EVERY, UPLOADED_INDEX, createTurnCapture, pruneTurns,
  registerTurnCapture, retentionTurnsFrom,
} from "../src/capture.js";
import { CONFIG_SCHEMA, resolveConfig } from "../src/config.js";
import { turnDir } from "../src/turns.js";
import { PLUGIN_ID } from "../src/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "percepteye-ret-"));

const dirs = (root) => readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isDirectory()).map((e) => e.name).sort();

/** One recorded turn, written `ageS` seconds ago (later turns are newer). */
function turn(root, id, { ageS = 0, answer = true, empty = false } = {}) {
  const dir = turnDir(root, id);
  mkdirSync(dir, { recursive: true });
  if (!empty) {
    const lines = [{ kind: "task", text: `ask ${id}`, turn_id: id }];
    if (answer) lines.push({ kind: "answer", text: `answer ${id}`, turn_id: id });
    writeFileSync(join(dir, "turns.jsonl"),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  }
  const t = new Date(Date.now() - ageS * 1000);
  utimesSync(dir, t, t);
  return dir;
}

/** `n` turns, oldest first: t0 is the oldest. */
function turns(root, n, prefix = "t", opts = {}) {
  for (let i = 0; i < n; i += 1) turn(root, `${prefix}${i}`, { ageS: (n - i) * 10, ...opts });
}

const quietLogger = () => {
  const warned = [];
  return { warned, info() {}, warn(m) { warned.push(m); } };
};

describe("prune", () => {
  it("deletes nothing when asked for nothing", () => {
    // An unqualified "prune" would be a request to delete everything, and
    // that is not a thing to infer.
    const root = tmp();
    turns(root, 5);
    assert.equal(pruneTurns({ root }), 0);
    assert.equal(dirs(root).length, 5);
  });

  it("keeps the most recent", () => {
    const root = tmp();
    turns(root, 20);
    assert.equal(pruneTurns({ root, keepLast: 5 }), 15);
    assert.deepEqual(dirs(root), ["t15", "t16", "t17", "t18", "t19"]);
  });

  it("never throws on a missing root", () => {
    assert.equal(pruneTurns({ root: join(tmp(), "gone"), keepLast: 1 }), 0);
  });

  it("deletes by age alone", () => {
    // Python shipped `entries[:max(0, keep_last or 0)]`, which for this use is
    // `entries[:0]`: a time-based window that deleted nothing and said 0.
    const root = tmp();
    turns(root, 3, "t", { ageS: 10_000 });
    assert.equal(pruneTurns({ root, olderThanS: 60 }), 3);
    assert.deepEqual(dirs(root), []);
  });

  it("deletes by age and by count together, a turn going if either says so", () => {
    const root = tmp();
    turns(root, 3);
    assert.equal(pruneTurns({ root, olderThanS: 10_000, keepLast: 2 }), 1,
      "nothing was old enough, so only keepLast should have bitten");
    assert.equal(dirs(root).length, 2);
  });

  it("deletes UPLOADED turns before pending ones", () => {
    // The pending turns are the OLDEST, which is what forces the choice: by
    // mtime alone the two newest -- both already uploaded -- would be kept and
    // the two still waiting would be destroyed. The same number still goes.
    const root = tmp();
    turn(root, "p0", { ageS: 100, answer: false });
    turn(root, "p1", { ageS: 90, answer: false });
    turns(root, 4, "u");
    const uploaded = new Set(["u0", "u1", "u2", "u3"]);
    assert.equal(pruneTurns({ root, keepLast: 2, uploaded, logger: quietLogger() }), 4);
    assert.deepEqual(dirs(root), ["p0", "p1"]);
  });

  it("warns when it really does lose a turn that was never uploaded", () => {
    const root = tmp();
    turns(root, 3, "t", { answer: false });
    const logger = quietLogger();
    pruneTurns({ root, keepLast: 1, uploaded: new Set(), logger });
    assert.ok(logger.warned.some((m) => m.includes("had not been uploaded")),
      "retention destroyed unsent turns and said nothing");
  });

  it("stays quiet when everything deleted was already sent", () => {
    const root = tmp();
    turns(root, 3);
    const logger = quietLogger();
    pruneTurns({ root, keepLast: 1, uploaded: new Set(["t0", "t1", "t2"]), logger });
    assert.deepEqual(logger.warned, []);
  });

  it("does not charge empty turn directories as lost data", () => {
    const root = tmp();
    turns(root, 3, "e", { empty: true });
    const logger = quietLogger();
    pruneTurns({ root, keepLast: 1, uploaded: new Set(), logger });
    assert.deepEqual(logger.warned, [],
      "retention warned about turns that held nothing and could never be sent");
  });

  it("forgets pruned turns from the upload index", () => {
    // The index describes this tree, so it is bounded by this tree.
    const root = tmp();
    turns(root, 4);
    writeFileSync(join(root, UPLOADED_INDEX), "t0\nt1\nt2\nt3\n", "utf8");
    pruneTurns({ root, keepLast: 1, uploaded: new Set(["t0", "t1", "t2", "t3"]) });
    assert.equal(readFileSync(join(root, UPLOADED_INDEX), "utf8"), "t3\n");
    assert.ok(existsSync(join(root, "t3")));
  });
});

describe("retentionTurns", () => {
  it("is a whole number of turns, 0 or more, or unset", () => {
    assert.deepEqual(retentionTurnsFrom(undefined), { retentionTurns: null, refusal: null });
    assert.deepEqual(retentionTurnsFrom(null), { retentionTurns: null, refusal: null });
    assert.deepEqual(retentionTurnsFrom(0), { retentionTurns: 0, refusal: null });
    assert.deepEqual(retentionTurnsFrom(50_000), { retentionTurns: 50_000, refusal: null });
    for (const bad of [-1, 2.5, "100", true, [], {}]) {
      const { retentionTurns, refusal } = retentionTurnsFrom(bad);
      assert.equal(retentionTurns, null, `${JSON.stringify(bad)} was accepted`);
      assert.match(refusal, /retentionTurns must be a whole number of turns, 0 or more/);
    }
  });

  it("is a config-only setting the host accepts", () => {
    assert.ok("retentionTurns" in CONFIG_SCHEMA.properties);
    assert.equal(resolveConfig({ retentionTurns: 20 }, {}).retentionTurns, 20);
    assert.equal(resolveConfig({}, { PERCEPTEYE_RETENTION_TURNS: "20" }).retentionTurns, null,
      "the Python SDK has no environment form for it, so neither does this");
  });
});

/** A host api that records every hook, and a transport with consent granted. */
function host() {
  const hooks = [];
  const logger = quietLogger();
  return {
    hooks,
    logger,
    on(name, fn) { hooks.push({ name, fn }); },
    config: { plugins: { entries: { [PLUGIN_ID]: { hooks: { allowConversationAccess: true } } } } },
    fire(name, ...args) { for (const h of hooks) if (h.name === name) h.fn(...args); },
  };
}

function transport() {
  return {
    register() { return { capture: { turns: true } }; },
    async captureCurrent(agentId) { return { agent_id: agentId, capture: { turns: true } }; },
    async reportTurns() { return {}; },
  };
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
}

function wire(root, a, retentionTurns) {
  return registerTurnCapture(a, {
    config: { agentId: "a1", ...(retentionTurns === undefined ? {} : { retentionTurns }) },
    turns: createTurnCapture({ root }),
    pluginId: PLUGIN_ID,
    logger: a.logger,
    env: { PERCEPTEYE_CAPTURE_DIR: root },
    makeTransport: () => transport(),
  });
}

describe("the gateway prunes on its own only when asked", () => {
  it("bounds the directory to retentionTurns + PRUNE_EVERY", async () => {
    const root = tmp();
    const a = host();
    wire(root, a, 20);
    for (let i = 0; i < 900; i += 1) {
      a.fire("message_received", { runId: `r${i}`, content: "hi", sessionKey: "c" }, {});
      if (i % 64 === 0) await settle();
    }
    await settle();
    const n = dirs(root).length;
    assert.ok(n <= 20 + PRUNE_EVERY, `${n} turns kept with retentionTurns: 20`);
    assert.ok(n < 900, "nothing was pruned");
  });

  it("deletes nothing without retentionTurns", async () => {
    const root = tmp();
    const a = host();
    wire(root, a);
    for (let i = 0; i < PRUNE_EVERY + 10; i += 1) {
      a.fire("message_received", { runId: `r${i}`, content: "hi", sessionKey: "c" }, {});
    }
    await settle();
    assert.equal(dirs(root).length, PRUNE_EVERY + 10);
  });

  it("names a retentionTurns it cannot use, and prunes nothing", async () => {
    const root = tmp();
    const a = host();
    const out = wire(root, a, "500");
    assert.equal(out.retentionTurns, null);
    assert.ok(a.logger.warned.some((m) => m.includes("retentionTurns must be a whole number")));
  });

  it("hands the operator the same prune", async () => {
    const root = tmp();
    const a = host();
    const out = wire(root, a);
    turns(root, 6);
    assert.equal(out.prune(), 0);
    assert.equal(out.prune({ keepLast: 2 }), 4);
    assert.deepEqual(dirs(root), ["t4", "t5"]);
  });
});
