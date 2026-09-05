/**
 * The transport, with emphasis on the ONE call that must never be replayed.
 */
import { strict as assert } from "node:assert";
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, it } from "node:test";
import { AttachTransport } from "../src/transport.js";
import { TOOL_CALLS_FILENAME } from "../src/trajectory.js";
import {
  MAX_TEXT_CHARS, readTurnText, recordTurnText, turnWire,
} from "../src/turns.js";

/** Records every request the transport makes, and replays scripted bodies. */
function recorder(bodies = {}) {
  const calls = [];
  const client = {
    async request(method, path, opts = {}) {
      calls.push({ method, path, ...opts });
      if (bodies[path] instanceof Error) throw bodies[path];
      return bodies[path] ?? {};
    },
  };
  return { client, calls };
}

const t = (bodies) => {
  const r = recorder(bodies);
  return { tx: new AttachTransport(r.client, { agentId: "goose" }), calls: r.calls };
};

describe("claiming is not replayable", () => {
  it("turns ambiguous retries OFF for /rollouts/claim", async () => {
    // The control plane does not honour Idempotency-Key on this route, so a
    // resend that MAY have been processed leases a SECOND batch while the
    // first is held by nobody. transport.py:134-139 records the incident.
    const { tx, calls } = t({ "/rollouts/claim": { rollouts: [] } });
    await tx.claim(1);
    assert.equal(calls[0].retryIfAmbiguous, false);
  });

  it("leaves ambiguous retries ON for the replayable result call", async () => {
    const { tx, calls } = t();
    await tx.report({ rolloutId: "r1" }, { finalText: "done" });
    assert.notEqual(calls[0].retryIfAmbiguous, false);
    assert.equal(calls[0].idempotencyKey, "result-r1");
  });

  it("clamps the batch size to the server's bounds", async () => {
    const { tx, calls } = t({ "/rollouts/claim": { rollouts: [] } });
    await tx.claim(999);
    assert.equal(calls[0].jsonBody.max, 16);
    await tx.claim(0);
    assert.equal(calls[1].jsonBody.max, 1);
  });

  it("parses rollouts through the wire contract", async () => {
    const { tx } = t({
      "/rollouts/claim": {
        rollouts: [{ rollout_id: "r9", turn_input: "go", deadline_ts: 5 }],
        poll_after_ms: 2500,
      },
    });
    const { rollouts, pollAfterMs } = await tx.claim(1);
    assert.equal(rollouts[0].rolloutId, "r9");
    assert.equal(rollouts[0].turnInput, "go");
    assert.equal(pollAfterMs, 2500);
  });

  it("an empty queue is a normal answer, not an error", async () => {
    const { tx } = t({ "/rollouts/claim": {} });
    const { rollouts, pollAfterMs } = await tx.claim(1);
    assert.deepEqual(rollouts, []);
    assert.equal(pollAfterMs, 1000);
  });
});

describe("the reads fail OPEN", () => {
  it("policyCurrent returns {} when the control plane is unreachable", async () => {
    // A control plane that cannot answer must not stop an agent from running.
    const { tx } = t({ "/policy/current": new Error("down") });
    assert.deepEqual(await tx.policyCurrent(), {});
  });

  it("promptCurrent returns {} rather than blanking the prompt", async () => {
    const { tx } = t({ "/prompt/current": new Error("down") });
    assert.deepEqual(await tx.promptCurrent(), {});
  });
});

describe("abandon is typed", () => {
  it("refuses to abandon without a reason", async () => {
    // Abandon is "do not train on this", not a low reward. An untyped abandon
    // cannot be told apart from the agent simply doing badly.
    const { tx } = t();
    await assert.rejects(async () => tx.abandon({ rolloutId: "r" }, {}));
  });

  it("sends the reason and the lease token", async () => {
    const { tx, calls } = t();
    await tx.abandon({ rolloutId: "r1", leaseToken: "lt" },
                     { reason: "substrate_fault", detail: "oom" });
    assert.equal(calls[0].jsonBody.reason, "substrate_fault");
    assert.equal(calls[0].jsonBody.lease_token, "lt");
  });
});

describe("registration", () => {
  it("is idempotent per agent", async () => {
    const { tx, calls } = t();
    await tx.register({ agent_id: "goose" });
    assert.equal(calls[0].idempotencyKey, "reg-goose");
  });
  it("requires an agentId at construction", () => {
    assert.throws(() => new AttachTransport({}, {}));
  });
});

describe("the turn-upload wire", () => {
  it("posts the intake's route and body", async () => {
    const calls = [];
    const tx = new AttachTransport(
      { request: (m, p, o) => { calls.push({ m, p, ...o }); } },
      { agentId: "a1" });
    await tx.reportTurns("a1", [{ turn_id: "t1", final_text: "x" }]);
    assert.equal(calls[0].m, "POST");
    assert.equal(calls[0].p, "/turns");
    assert.deepEqual(Object.keys(calls[0].jsonBody).sort(), ["agent_id", "turns"]);
  });

  it("derives a key that is stable per batch and differs across batches", async () => {
    const key = async (turns) => {
      const calls = [];
      await new AttachTransport({ request: (m, p, o) => calls.push(o) },
                                { agentId: "a1" }).reportTurns("a1", turns);
      return calls[0].idempotencyKey;
    };
    const a = await key([{ turn_id: "t1", final_text: "x" }]);
    assert.equal(a, await key([{ turn_id: "t1", final_text: "x" }]));
    assert.notEqual(a, await key([{ turn_id: "t1", final_text: "y" }]));
    assert.match(a, /^turns-a1-[0-9a-f]{32}$/);
  });

  it("hashes key ORDER, SEPARATORS and NON-ASCII the way Python does", async () => {
    // The three ways JSON.stringify differs from json.dumps. Each is asserted
    // here so the Node side alone goes red on a regression; the Python package
    // additionally hashes one real batch through BOTH ends and compares, which
    // is what caught all three after this shipped claiming parity it lacked.
    const key = async (turns) => {
      const calls = [];
      await new AttachTransport({ request: (m, p, o) => calls.push(o) },
                                { agentId: "a1" }).reportTurns("a1", turns);
      return calls[0].idempotencyKey;
    };
    // Key order must not matter: Python sorts.
    assert.equal(await key([{ b: 1, a: 2 }]), await key([{ a: 2, b: 1 }]));
    // Non-ASCII must fold to \uXXXX, so these differ from their escaped forms
    // only if the folding is absent. Assert against a KNOWN Python digest.
    const nonAscii = await key([{ turn_id: "t1", final_text: "mañana — 📦" }]);
    assert.equal(nonAscii, PY_NON_ASCII_KEY,
      "the non-ASCII digest no longer matches json.dumps(ensure_ascii=True)");
  });
});

//: Produced by the Python end, verbatim:
//:   AttachTransport(c, "a1").report_turns(
//:       "a1", [{"turn_id": "t1", "final_text": "mañana — \U0001f4e6"}])
const PY_NON_ASCII_KEY = "turns-a1-a496e0f0d4c048270af7fa9b8de992ed";

/** The batch key this package would send for `turns`. */
async function batchKey(turns, agentId = "a1") {
  const calls = [];
  await new AttachTransport({ request: (m, p, o) => calls.push(o) },
                            { agentId }).reportTurns(agentId, turns);
  return calls[0].idempotencyKey;
}

describe("the batch key's parity with json.dumps, and where it stops", () => {
  it("matches Python on a whole turn of strings, ints, nulls and lists", async () => {
    // A REAL turn wire, not a toy: this is the shape `turnWire` emits, and
    // every digest below was produced by the Python end rather than by reading
    // this package's own output back to itself.
    assert.equal(
      await batchKey([{
        turn_id: "t1", input_text: "hi", final_text: "ok", tool_calls: [],
        tool_calls_omitted_count: 0, conversation_id: "c1", turn_index: 2,
      }]),
      "turns-a1-f30b6c6cbc68ac203d9628806fe22837",
      "the batch key no longer matches json.dumps(sort_keys=True) for the " +
      "value shapes the two SDKs DO agree on",
    );
  });

  it("does NOT match Python on a non-integral number, and that is documented", async () => {
    // NOT A CERTIFICATION THAT THE GAP IS FINE -- a pin so it stays visible.
    // The shared fixture in the Python package contains only the integers 0, 1
    // and 2, so it agrees by construction on the one axis that still diverges;
    // this asserts the divergence itself, with Python's own two digests.
    //
    // `12.0` reaches this through JSON on disk, not only through native
    // values: `JSON.parse` erases int-vs-float before `stableStringify` ever
    // sees the number, which is why no formatter on THIS side can fix it and
    // why the fix is one canonicaliser applied on both. See the
    // `stableStringify` docstring.
    const withFloat = [{
      turn_id: "t1",
      tool_calls: [{
        name: "refund", arguments: { amount: 100.0 }, outcome: "ok",
        status_code: 200,
      }],
    }];
    const PY_FLOAT = "turns-a1-e0c67725d65add96c39c78cb14ebc313";
    const PY_INT = "turns-a1-373e710f1f1cc0aebbcaffa509763a09";
    const ours = await batchKey(withFloat);
    assert.equal(ours, PY_INT,
      "this side renders 100.0 as the integer 100; if that changed, the " +
      "docstring's statement of the gap changed with it");
    assert.notEqual(ours, PY_FLOAT,
      "the number gap is CLOSED -- update stableStringify's docstring, which " +
      "still says a batch carrying a non-integral number may not collapse");
  });
});

describe("the captured turn's wire", () => {
  const roots = [];
  const newRoot = () => {
    const r = mkdtempSync(join(tmpdir(), "pe-turnwire-"));
    roots.push(r);
    return r;
  };
  const cleanup = () => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  };

  it("takes turn_id from the directory NAME, not from splitting on '/'", async (t) => {
    t.after(cleanup);
    // The bug is win32-only in production -- `join` builds `C:\...\run1`, a
    // hardcoded "/" split returns the WHOLE path, and that path goes onto the
    // wire as the turn id AND can never match the bare `d.name` that
    // `createTurnUploader` writes into `.uploaded`, so every flush re-sends
    // the entire capture root. A posix job cannot make `join` emit a
    // backslash, so the probe here is the other input on which the two
    // derivations differ: a trailing separator, where the split yields "".
    const root = newRoot();
    const dir = join(root, "run1");
    recordTurnText(dir, "task", "hello");
    assert.equal(turnWire(dir).turn_id, "run1");
    assert.equal(turnWire(dir + sep).turn_id, "run1",
      "turn_id must be the directory name under node:path's rules, not the " +
      "last field of a hardcoded '/' split");
  });

  it("asks for the tool-call file by the ABI's own name, in one place", async (t) => {
    t.after(cleanup);
    // The tri-state's `[]` branch and `readTrajectory` must ask about the SAME
    // file: `[]` claims the agent ran and called nothing, `null` claims
    // nothing was recorded, and a second copy of the filename makes a rename
    // turn the first silently into the second.
    const root = newRoot();
    const dir = join(root, "run2");
    mkdirSync(dir, { recursive: true });
    recordTurnText(dir, "task", "hello");
    writeFileSync(join(dir, TOOL_CALLS_FILENAME), "", "utf8");
    assert.deepEqual(turnWire(dir).tool_calls, [],
      "a turn that ran and called nothing must not be reported as a turn " +
      "that reports no tool calls");

    // There is exactly ONE spelling of that filename in the module, for the
    // same reason `config-gate.test.js` reads the transport's routes out of
    // the source: the property is that no second copy exists, and only the
    // source can say so.
    const src = readFileSync(new URL("../src/turns.js", import.meta.url), "utf8");
    assert.ok(!src.includes(`"${TOOL_CALLS_FILENAME}"`),
      `src/turns.js hardcodes "${TOOL_CALLS_FILENAME}" instead of importing ` +
      `TOOL_CALLS_FILENAME from the module that owns the ABI`);
  });
});

describe("turn text truncates where PYTHON truncates", () => {
  const roots = [];
  const cleanup = () => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  };
  const dirFor = (name) => {
    const r = mkdtempSync(join(tmpdir(), "pe-turntext-"));
    roots.push(r);
    return join(r, name);
  };

  it("counts CODE POINTS, so an emoji message under the cap is kept whole", (t) => {
    t.after(cleanup);
    // Python's `record_turn_text` does `text.strip()[:20_000]` -- code points.
    // `slice` counts UTF-16 units, so this message was cut in half and the two
    // corpora stopped being comparable, which is the only thing the shared
    // constant is for.
    const dir = dirFor("emoji");
    const text = "\u{1F4E6}".repeat(15_000);
    assert.equal(recordTurnText(dir, "task", text), true);
    assert.equal([...readTurnText(dir).task].length, 15_000);
  });

  it("never emits a LONE SURROGATE when it does truncate", (t) => {
    t.after(cleanup);
    // The cut landing between the halves of a pair put an unpaired \ud83d on
    // the wire; the intake cannot encode that to UTF-8, so the chunk was never
    // acknowledged and `flush` re-sent it on every flush forever.
    // One leading ASCII char, so the 20,000th CODE UNIT falls on the high half
    // of a pair; over the cap in code points too, so the cap really fires.
    const dir = dirFor("split-pair");
    assert.equal(
      recordTurnText(dir, "task", "a" + "\u{1F4E6}".repeat(25_000)), true);
    const stored = readTurnText(dir).task;
    assert.equal([...stored].length, MAX_TEXT_CHARS);
    assert.equal(Buffer.from(stored, "utf8").toString("utf8"), stored,
      "the stored text does not survive a UTF-8 round trip, so it holds an " +
      "unpaired surrogate and the intake will refuse the whole chunk");
  });
});

describe("the capture verdict read", () => {
  it("is a GET on the agent, with no body and no idempotency key", async () => {
    const calls = [];
    const tx = new AttachTransport(
      { request: (m, p, o) => { calls.push({ m, p, o }); return { capture: { turns: true } }; } },
      { agentId: "a1" });
    const out = await tx.captureCurrent("a1");
    assert.equal(calls[0].m, "GET");
    assert.equal(calls[0].p, "/agents/a1/capture");
    assert.equal(calls[0].o, undefined,
      "a READ that sends a body or a key looks like the write it replaces");
    assert.equal(out.capture.turns, true);
  });

  it("escapes an agent id that would otherwise change the path", async () => {
    const calls = [];
    await new AttachTransport({ request: (m, p) => calls.push(p) }, { agentId: "a" })
      .captureCurrent("a/../b");
    assert.ok(!calls[0].includes("/../"), calls[0]);
  });

  it("FAILS CLOSED when the control plane cannot be reached", async () => {
    // The opposite of `policyCurrent`, whose safe direction is the other way.
    // Asserted against the REAL method: a fake transport that throws exercises
    // the CALLER's catch, not this one, which is how the same mutation
    // survived on the Python side.
    const tx = new AttachTransport(
      { request: () => { throw new Error("unreachable"); } }, { agentId: "a1" });
    const out = await tx.captureCurrent("a1");
    assert.deepEqual(out, {});
    assert.notEqual(out?.capture?.turns, true);
  });
});
