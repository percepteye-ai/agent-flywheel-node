/**
 * Production capture records ONLY this agent's own turns, under a root keyed
 * by this agent (the NEW agent-scoping finding of the 2026-11-20 review).
 *
 * The host runs every hook for every agent, subagent and cron session a
 * gateway serves. Capture used to record all of them into one unkeyed root,
 * and upload them under this agent's id and this agent's consent.
 */
import { testEnv } from "./support/home.js";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { PLUGIN_ID, register } from "../src/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "pe-scope-"));

function host(agents = null) {
  const hooks = [];
  const lines = [];
  return {
    hooks, lines, id: PLUGIN_ID,
    logger: { info: (m) => lines.push(m), warn: (m) => lines.push(m) },
    on(name, fn) { hooks.push({ name, fn }); },
    config: {
      plugins: { entries: { [PLUGIN_ID]: { hooks: { allowConversationAccess: true } } } },
      ...(agents ? { agents: { list: agents.map((id) => ({ id })) } } : {}),
    },
    fire(name, ...args) {
      for (const h of hooks) if (h.name === name) h.fn(...args);
    },
  };
}

/** One run through the three capture hooks, as the host delivers them. */
function serve(a, runId, sessionKey, agentId) {
  const ctx = { runId, sessionKey, agentId };
  a.fire("message_received", { runId, content: "hi", sessionKey },
    { sessionKey, runId });
  a.fire("after_tool_call", { toolName: "lookup", params: {}, runId, result: "ok" }, ctx);
  a.fire("agent_end", { runId, messages: [{ role: "assistant", content: "ok" }] }, ctx);
}

describe("capture is scoped to this agent's own runs", () => {
  it("records the served agent's turns and nobody else's", () => {
    // Mutation: drop the scope gate in createTurnCapture -> the subagent,
    // cron and other agent's runs are captured too, red.
    const root = tmp();
    const a = host(["support", "billing"]);
    register(a, { agentId: "support" }, testEnv({
      PERCEPTEYE_AGENT_MODE: "production", PERCEPTEYE_CAPTURE_DIR: root,
    }));
    serve(a, "own", "agent:support:slack:dm:u1", "support");
    serve(a, "sub", "agent:support:subagent:abc", "support");
    serve(a, "cron", "agent:support:cron:nightly", "support");
    serve(a, "other", "agent:billing:slack:dm:u2", "billing");
    assert.deepEqual(readdirSync(root).filter((n) => !n.startsWith(".")), ["own"]);
    assert.ok(existsSync(join(root, "own", "tool_calls.jsonl")));
    const said = a.lines.filter((m) => m.includes("was NOT captured"));
    assert.equal(said.length, 3, said.join("\n"));
    assert.ok(said.some((m) => m.includes("subagent")));
    assert.ok(said.some((m) => m.includes("cron")));
    assert.ok(said.some((m) => m.includes('"billing"')));
    // Said once per reason, not per run.
    serve(a, "sub2", "agent:support:subagent:def", "support");
    assert.equal(a.lines.filter((m) => m.includes("was NOT captured")).length, 3);
  });

  it("keys the default root by agent, so two agents on one home never mix", () => {
    // Mutation: captureRoot ignores the agent -> both land in one root, red.
    const home = tmp();
    const a = host();
    const b = host();
    register(a, { agentId: "alpha" }, testEnv({
      PERCEPTEYE_AGENT_MODE: "production", PERCEPTEYE_HOME: home }));
    register(b, { agentId: "beta" }, testEnv({
      PERCEPTEYE_AGENT_MODE: "production", PERCEPTEYE_HOME: home }));
    serve(a, "ra", "agent:main:x", "main");
    serve(b, "rb", "agent:main:y", "main");
    assert.deepEqual(readdirSync(join(home, "captured", "alpha")), ["ra"]);
    assert.deepEqual(readdirSync(join(home, "captured", "beta")), ["rb"]);
  });

  it("leaves turns an earlier release captured unkeyed, and says where they are", () => {
    const home = tmp();
    mkdirSync(join(home, "captured", "old-run"), { recursive: true });
    writeFileSync(join(home, "captured", "old-run", "turns.jsonl"), "{}\n");
    const a = host();
    register(a, { agentId: "alpha" }, testEnv({
      PERCEPTEYE_AGENT_MODE: "production", PERCEPTEYE_HOME: home }));
    assert.ok(a.lines.some((m) => m.includes("earlier release")
      && m.includes(join(home, "captured"))), a.lines.join("\n"));
    assert.ok(existsSync(join(home, "captured", "old-run", "turns.jsonl")),
      "never moved or deleted");
  });
});
