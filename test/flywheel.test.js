import "./support/home.js";
import { testEnv } from "./support/home.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  currentTurn, flywheel, recordToolCall, ToolCallBlocked,
} from "../src/index.js";

const quiet = { info() {}, warn() {}, error() {} };

function captured(env, agentId) {
  const root = join(env.PERCEPTEYE_HOME, "captured", agentId);
  const dirs = existsSync(root)
    ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
    : [];
  return dirs.map((d) => {
    const read = (f) => {
      const p = join(root, d.name, f);
      return existsSync(p) ? readFileSync(p, "utf8") : null;
    };
    const lines = (f) => (read(f) ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return {
      turnId: d.name,
      turns: lines("turns.jsonl"),
      tools: lines("tool_calls.jsonl"),
      conversationId: read("conversation_id"),
    };
  });
}

describe("flywheel().turn(): a production turn through the plugin's own lanes", () => {
  it("captures the task, the answer and every tool call, with no key and no network", async () => {
    const env = testEnv();
    const fw = flywheel({ agentId: "support-agent", logger: quiet }, env);
    assert.equal(fw.mode, "production");
    const answer = await fw.turn("refund order 42", async (t) => {
      assert.equal(t.input, "refund order 42");
      assert.equal(t.conversationId, "conv-1");
      assert.equal(t.model, null, "nothing approved: the agent keeps its own model");
      assert.equal(t.systemPrompt("mine"), "mine");
      assert.equal(currentTurn(), t, "the turn is reachable without a handle");
      t.recordToolCall({
        name: "refund", arguments: { order: 42 },
        outcome: "failed", statusCode: 200, error: "permission denied",
      });
      recordToolCall({ name: "lookup", arguments: { order: 42 }, result: { id: "a1b2c3d4e5f6" } });
      return "Refund could not be issued.";
    }, { conversationId: "conv-1" });
    assert.equal(answer, "Refund could not be issued.");
    await fw.close();

    const [turn, ...rest] = captured(env, "support-agent");
    assert.equal(rest.length, 0);
    assert.equal(turn.conversationId, "conv-1");
    assert.deepEqual(turn.turns.map((r) => [r.kind, r.text]), [
      ["task", "refund order 42"], ["answer", "Refund could not be issued."],
    ]);
    // A STATED verdict is taken as stated: an HTTP 200 that was a denial.
    assert.deepEqual(
      [turn.tools[0].outcome, turn.tools[0].status_code, turn.tools[0].error],
      ["failed", 200, "permission denied"]);
    // An unstated one is read from the result, and a returned result is never
    // rounded up to `ok`.
    assert.equal(turn.tools[1].outcome, "unknown");
    assert.deepEqual(turn.tools[1].entity_ids, { id: "a1b2c3d4e5f6" });
  });

  it("closes a turn whose agent threw, with no answer, and rethrows", async () => {
    const env = testEnv();
    const fw = flywheel({ agentId: "a", logger: quiet }, env);
    await assert.rejects(fw.turn("hi", async () => { throw new Error("boom"); }), /boom/);
    const [turn] = captured(env, "a");
    assert.deepEqual(turn.turns.map((r) => r.kind), ["task"]);
  });

  it("records nothing outside a turn", () => {
    assert.equal(currentTurn(), null);
    assert.equal(recordToolCall({ name: "x", outcome: "ok" }), false);
  });

  it("refuses serve() in production mode, naming the switch", async () => {
    const fw = flywheel({ agentId: "a", logger: quiet }, testEnv());
    await assert.rejects(fw.serve(async () => "x"), /PERCEPTEYE_AGENT_MODE=training/);
  });

  it("refuses to start without an agent name, and takes PERCEPTEYE_AGENT_ID", () => {
    assert.throws(() => flywheel({ logger: quiet }, testEnv()), /PERCEPTEYE_AGENT_ID/);
    assert.equal(flywheel({ logger: quiet }, testEnv({ PERCEPTEYE_AGENT_ID: "env-agent" })).mode,
      "production");
  });

  it("captures nothing with capture turned off, and still runs the turn", async () => {
    const env = testEnv({ PERCEPTEYE_CAPTURE: "0" });
    const fw = flywheel({ agentId: "a", logger: quiet }, env);
    assert.equal(await fw.turn("hi", async () => "ok"), "ok");
    assert.deepEqual(captured(env, "a"), []);
  });
});

/**
 * A control plane and a rollout gateway in one local server: the routes the
 * transport calls, and `/llm/...` standing in for the gateway the rollout
 * samples through.
 */
async function fakeControlPlane({ rollouts = [], policy = {}, prompt = {}, revoked = [] } = {}) {
  const seen = { reports: [], abandons: [], llm: 0, hosted: 0, claims: 0, agents: [] };
  const queue = [...rollouts];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : null;
    const send = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const path = new URL(req.url, "http://x").pathname;
    if (path.startsWith("/llm/")) {
      if (path.includes("/hosted/")) seen.hosted += 1; else seen.llm += 1;
      return send(200, { choices: [{ message: { role: "assistant", content: "ok" } }] });
    }
    const route = path.replace(/^\/api\/flywheel\/v1/, "");
    if (route === "/health") return send(200, { contract_versions_supported: ["flywheel/1"] });
    if (route === "/agents") {
      seen.agents.push(json);
      return send(200, { agent_id: json.agent_id, accepted: true });
    }
    if (/^\/agents\/[^/]+\/capture$/.test(route)) return send(200, { enabled: false });
    if (route === "/policy/current") return send(200, typeof policy === "function" ? policy(base) : policy);
    if (route === "/prompt/current") return send(200, prompt);
    if (route === "/rollouts/claim") {
      seen.claims += 1;
      const next = queue.shift();
      return send(200, { rollouts: next ? [next(base)] : [], poll_after_ms: 50 });
    }
    const m = route.match(/^\/rollouts\/([^/]+)\/(result|abandon|heartbeat)$/);
    if (m) {
      if (m[2] === "heartbeat" && revoked.includes(m[1])) {
        return send(410, { detail: "lease revoked" });
      }
      if (m[2] === "result") seen.reports.push({ id: m[1], ...json });
      if (m[2] === "abandon") seen.abandons.push({ id: m[1], ...json });
      return send(200, { ok: true, lease_expires_ts: Date.now() / 1000 + 600 });
    }
    return send(404, { detail: "not here" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, seen,
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
  };
}

const rollout = (id, input) => (base) => ({
  rollout_id: id,
  turn_input: input,
  llm_url: `${base}/llm/${id}/v1`,
  api_key: `rk_${id}`,
  artifacts_dir: "",
  lease_token: `lt_${id}`,
  lease_expires_ts: Date.now() / 1000 + 600,
  deadline_ts: Date.now() / 1000 + 600,
});

const trainingEnv = (base) => testEnv({
  PERCEPTEYE_AGENT_MODE: "training",
  PERCEPTEYE_API_KEY: "pefw_test",
  PERCEPTEYE_CONTROL_PLANE_URL: `${base}/api/flywheel/v1`,
  PERCEPTEYE_TRAJECTORY_DIR: "",
});

describe("flywheel().turn(): the approved pair, handed to the agent", () => {
  const APPROVED_PROMPT = {
    name: "support-agent", version: 3, sha256: "a".repeat(64),
    text: "You are a careful support agent.", candidate_kind: "replacement",
    status: "approved", model_prompt_checksum: "a".repeat(64), stale_baseline: false,
  };
  const served = (endpoint) => (base) => ({
    arm: "candidate", reason: "certified", candidate_available: true,
    endpoint: typeof endpoint === "function" ? endpoint(base) : endpoint,
    model: { uri: "gs://bucket/ckpt-7" },
    prompt: { pins: { p1: {} }, digest: "d".repeat(16), captured_at: "now" },
    bundle_digest: "b".repeat(64), resolved_at: "2026-11-20T00:00:00+00:00",
    ttl_s: 60.0, serving_generation: "0123456789abcdef",
  });
  const productionEnv = (base, extra = {}) => testEnv({
    PERCEPTEYE_API_KEY: "pefw_test",
    PERCEPTEYE_CONTROL_PLANE_URL: `${base}/api/flywheel/v1`,
    ...extra,
  });
  async function ready(fw, ms = 5_000) {
    const until = performance.now() + ms;
    while (!fw.plugin.serving.resolved && performance.now() < until) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(fw.plugin.serving.resolved, "the serving policy was never read");
  }

  it("hands the approved prompt and the approved model, keyed by this agent's key at the control plane's own gateway", async () => {
    const cp = await fakeControlPlane({
      policy: served((base) => ({
        base_url: `${base}/llm/v1/agents/support-agent/v1`, model: "ckpt-7",
        api_key_env: "PERCEPTEYE_API_KEY",
      })),
      prompt: APPROVED_PROMPT,
    });
    try {
      const fw = flywheel({ agentId: "support-agent", logger: quiet }, productionEnv(cp.base));
      await ready(fw);
      await fw.turn("hi", async (t) => {
        assert.equal(t.systemPrompt("mine"), "You are a careful support agent.");
        assert.deepEqual(t.model, {
          baseURL: `${cp.base}/llm/v1/agents/support-agent/v1`, apiKey: "pefw_test", model: "ckpt-7",
        });
        return "ok";
      });
      await fw.close();
    } finally {
      await cp.close();
    }
  });

  it("never sends this agent's key to an endpoint of yours: the credential is yours to give", async () => {
    const policy = served({ base_url: "https://gpu.example/v1", model: "ckpt-7" });
    const cp = await fakeControlPlane({ policy, prompt: APPROVED_PROMPT });
    try {
      const fw = flywheel({ agentId: "a", logger: quiet }, productionEnv(cp.base));
      await ready(fw);
      await fw.turn("hi", async (t) => {
        assert.deepEqual(t.model, { baseURL: "https://gpu.example/v1", apiKey: null, model: "ckpt-7" });
        return "ok";
      });
      const mine = flywheel({ agentId: "a", servedModelApiKey: "sk-mine", logger: quiet },
        productionEnv(cp.base));
      await ready(mine);
      await mine.turn("hi", async (t) => {
        assert.equal(t.model.apiKey, "sk-mine");
        return "ok";
      });
    } finally {
      await cp.close();
    }
  });

  it("hands over nothing when switched off, and the agent keeps its own", async () => {
    const policy = served({ base_url: "https://gpu.example/v1", model: "ckpt-7" });
    const cp = await fakeControlPlane({ policy, prompt: APPROVED_PROMPT });
    try {
      const fw = flywheel({ agentId: "a", logger: quiet }, productionEnv(cp.base, {
        PERCEPTEYE_APPLY_PROMPT: "0", PERCEPTEYE_APPLY_MODEL: "0",
      }));
      await ready(fw);
      await fw.turn("hi", async (t) => {
        assert.equal(t.systemPrompt("mine"), "mine");
        assert.equal(t.model, null);
        return "ok";
      });
    } finally {
      await cp.close();
    }
  });
});

describe("flywheel().serve(): training rollouts through the one rollout lane", () => {
  it("runs the task on the rollout's own gateway and reports the answer, the tool calls and the observed model-call count", async () => {
    const cp = await fakeControlPlane({ rollouts: [rollout("r1", "close ticket 7")] });
    try {
      const fw = flywheel({ agentId: "support-agent", logger: quiet }, trainingEnv(cp.base));
      assert.equal(fw.mode, "training");
      let seenTurn = null;
      await fw.serve(async (t) => {
        seenTurn = t;
        assert.equal(t.input, "close ticket 7");
        assert.equal(t.rolloutId, "r1");
        assert.deepEqual(t.model, {
          baseURL: `${cp.base}/llm/r1/v1`, apiKey: "rk_r1", model: "policy",
        });
        for (let i = 0; i < 2; i += 1) {
          await fetch(`${t.model.baseURL}/chat/completions`, {
            method: "POST", body: "{}", headers: { authorization: `Bearer ${t.model.apiKey}` },
          });
        }
        // A model that is NOT the policy (a judge, a simulator): not counted.
        await fetch(`${t.model.baseURL}/hosted/openai/chat/completions`, { method: "POST", body: "{}" });
        t.recordToolCall({ name: "close_ticket", arguments: { id: 7 }, outcome: "ok", statusCode: 200 });
        return "Closed.";
      }, { maxRollouts: 1 });
      assert.ok(seenTurn, "the agent ran");
      assert.equal(cp.seen.reports.length, 1);
      const [report] = cp.seen.reports;
      assert.equal(report.id, "r1");
      assert.equal(report.final_text, "Closed.");
      assert.equal(report.tool_calls.length, 1);
      assert.equal(report.tool_calls[0].name, "close_ticket");
      assert.equal(report.llm_call_count, 2, "two policy calls, the hosted one excluded");
      assert.equal(cp.seen.llm, 2);
      assert.equal(cp.seen.hosted, 1);
      assert.equal(cp.seen.abandons.length, 0);
      await fw.close();
    } finally {
      await cp.close();
    }
  });

  it("reports an agent that threw as a failed attempt, never hands it back", async () => {
    const cp = await fakeControlPlane({ rollouts: [rollout("r2", "x")] });
    try {
      const fw = flywheel({ agentId: "a", logger: quiet }, trainingEnv(cp.base));
      await fw.serve(async () => { throw new Error("agent bug"); }, { maxRollouts: 1 });
      assert.equal(cp.seen.reports.length, 1);
      assert.equal(cp.seen.reports[0].success, false);
      assert.equal(cp.seen.abandons.length, 0);
    } finally {
      await cp.close();
    }
  });

  it("reports no model-call count when the agent never called the rollout's model", async () => {
    const cp = await fakeControlPlane({ rollouts: [rollout("r3", "x")] });
    try {
      const fw = flywheel({ agentId: "a", logger: quiet }, trainingEnv(cp.base));
      await fw.serve(async () => "answered from somewhere else", { maxRollouts: 1 });
      const [report] = cp.seen.reports;
      assert.equal(report.final_text, "answered from somewhere else");
      assert.equal(report.llm_call_count, undefined,
        "no observed call is no count, never a claimed zero");
    } finally {
      await cp.close();
    }
  });

  it("runs rollouts one after another until maxRollouts, then stops claiming", async () => {
    const cp = await fakeControlPlane({
      rollouts: [rollout("r4", "a"), rollout("r5", "b"), rollout("r6", "c")],
    });
    try {
      const fw = flywheel({ agentId: "a", logger: quiet }, trainingEnv(cp.base));
      const inputs = [];
      await fw.serve(async (t) => { inputs.push(t.input); return t.input; }, { maxRollouts: 2 });
      assert.deepEqual(inputs, ["a", "b"]);
      assert.deepEqual(cp.seen.reports.map((r) => r.final_text), ["a", "b"]);
    } finally {
      await cp.close();
    }
  });

  it("puts fetch back when serve() returns", async () => {
    const before = globalThis.fetch;
    const cp = await fakeControlPlane({ rollouts: [rollout("r7", "a")] });
    try {
      const fw = flywheel({ agentId: "a", logger: quiet }, trainingEnv(cp.base));
      await fw.serve(async () => "x", { maxRollouts: 1 });
      assert.equal(globalThis.fetch, before);
    } finally {
      await cp.close();
    }
  });

  it("stops when its signal aborts", async () => {
    const cp = await fakeControlPlane({ rollouts: [] });
    try {
      const fw = flywheel({ agentId: "a", logger: quiet }, trainingEnv(cp.base));
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 50);
      await fw.serve(async () => "x", { signal: ac.signal });
      assert.equal(cp.seen.reports.length, 0);
    } finally {
      await cp.close();
    }
  });

  it("refuses a tool call once the rollout's lease is revoked, through the adapter, and records nothing for it", async () => {
    const { flywheelTools } = await import("../src/adapters/ai-sdk.js");
    const cp = await fakeControlPlane({ rollouts: [rollout("r8", "a")] });
    try {
      const fw = flywheel({ agentId: "a", logger: quiet }, trainingEnv(cp.base));
      let ran = false;
      const tools = flywheelTools({ write: { execute: async () => { ran = true; return "ok"; } } });
      let refusal = null;
      await fw.serve(async (t) => {
        // What the lane does when a heartbeat answers 410 for a started run.
        fw.plugin.rollouts.revokedRuns.set(`percepteye-rollout-${t.rolloutId}`, null);
        try {
          await tools.write.execute({}, { toolCallId: "c1" });
        } catch (err) {
          refusal = err;
        }
        return "done";
      }, { maxRollouts: 1 });
      assert.ok(refusal instanceof ToolCallBlocked, `expected ToolCallBlocked, got ${refusal}`);
      assert.equal(ran, false, "the side effect never ran");
    } finally {
      await cp.close();
    }
  });

  it("registers as the framework API, in both lanes -- never as the OpenClaw plugin", async () => {
    const cp = await fakeControlPlane({ rollouts: [rollout("r9", "a")] });
    try {
      const training = flywheel({ agentId: "a", framework: "langchain", logger: quiet }, trainingEnv(cp.base));
      await training.serve(async () => "x", { maxRollouts: 1 });
      const production = flywheel({ agentId: "b", logger: quiet }, testEnv({
        PERCEPTEYE_API_KEY: "pefw_test",
        PERCEPTEYE_CONTROL_PLANE_URL: `${cp.base}/api/flywheel/v1`,
      }));
      await production.plugin.capture.started;
      const byMode = Object.fromEntries(cp.seen.agents.map((a) => [a.agent_id, a]));
      // The framework reaches the control plane in the agent's DESCRIPTION
      // once the model input is observed (adapters.test.js); at
      // registration, with nothing observed, the description is honestly
      // null -- and the entry point says which integration this is.
      assert.equal(byMode.a.entrypoint, "agent-flywheel-node:flywheel");
      assert.equal(byMode.b.entrypoint, "agent-flywheel-node:flywheel");
      assert.equal(byMode.a.discovered_agent, null);
      await production.close();
    } finally {
      await cp.close();
    }
  });

  it("aborts t.signal when the control plane revokes the lease, and reports nothing for it", async () => {
    const short = (base) => ({ ...rollout("r10", "a")(base), lease_expires_ts: Date.now() / 1000 + 3 });
    const cp = await fakeControlPlane({ rollouts: [short], revoked: ["r10"] });
    try {
      const fw = flywheel({ agentId: "a", logger: quiet }, trainingEnv(cp.base));
      let aborted = false;
      await fw.serve(async (t) => {
        aborted = await new Promise((resolve) => {
          if (t.signal.aborted) { resolve(true); return; }
          const timer = setTimeout(() => resolve(false), 8_000);
          t.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(true); });
        });
        return "too late";
      }, { maxRollouts: 1 });
      assert.equal(aborted, true, "the run was told to stop");
      assert.equal(cp.seen.reports.length, 0, "a revoked rollout's result is not reported");
    } finally {
      await cp.close();
    }
  });

  it("exports the blocked-tool error the adapters throw", () => {
    assert.equal(new ToolCallBlocked("revoked").name, "ToolCallBlocked");
  });
});
