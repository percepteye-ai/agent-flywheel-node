import "./support/home.js";
import { testEnv } from "./support/home.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TRAJECTORY_DIR_ENV } from "../src/trajectory.js";

import { flywheel } from "../src/index.js";
import { flywheelMiddleware, flywheelTools, modelInputOf } from "../src/adapters/ai-sdk.js";
import { flywheelCallbacks, modelInputOf as lcModelInputOf } from "../src/adapters/langchain.js";

// These run with neither framework installed: the adapters are plain objects
// in the frameworks' shapes. The same adapters were driven through the real
// `ai` (5 and 7) and `@langchain/core` (0.3 and 1.5) packages when written;
// what is pinned here is the contract between the adapter and the turn.

const quiet = { info() {}, warn() {}, error() {} };

function toolCalls(env, agentId) {
  const root = join(env.PERCEPTEYE_HOME, "captured", agentId);
  const [dir] = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  const path = join(root, dir.name, "tool_calls.jsonl");
  return existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
}

describe("the Vercel AI SDK adapter", () => {
  it("records each executed tool: a throw is failed, a return is never rounded up to ok", async () => {
    const env = testEnv();
    const fw = flywheel({ agentId: "ai", logger: quiet }, env);
    const tools = flywheelTools({
      lookup: { description: "d", execute: async ({ id }) => ({ id: "ord_9f8e7d6c5b4a", n: id }) },
      refund: { description: "d", execute: async () => { throw new Error("denied"); } },
      schemaOnly: { description: "no execute: the model's to handle" },
    });
    assert.equal(tools.schemaOnly.execute, undefined, "a tool with no execute is left alone");
    await fw.turn("go", async () => {
      await tools.lookup.execute({ id: 7 }, { toolCallId: "c1" });
      await assert.rejects(tools.refund.execute({ id: 7 }, { toolCallId: "c2" }), /denied/);
      return "done";
    });
    const calls = toolCalls(env, "ai");
    assert.deepEqual(calls.map((c) => [c.name, c.outcome, c.tool_call_id]), [
      ["lookup", "unknown", "c1"], ["refund", "failed", "c2"],
    ]);
    assert.equal(calls[1].error, "denied");
    assert.deepEqual(calls[0].entity_ids, { id: "ord_9f8e7d6c5b4a" });
  });

  it("is a pass-through outside a turn", async () => {
    const tools = flywheelTools({ t: { execute: async (a) => a.x * 2 } });
    assert.equal(await tools.t.execute({ x: 2 }, {}), 4);
  });

  it("reports the model input once per turn, and passes the call through unchanged", async () => {
    // Observed where it lands: the agent description the `llm_input`
    // consumer writes under the trajectory directory.
    const dir = mkdtempSync(join(tmpdir(), "percepteye-describe-"));
    const before = process.env[TRAJECTORY_DIR_ENV];
    process.env[TRAJECTORY_DIR_ENV] = dir;
    try {
      const fw = flywheel({ agentId: "ai", framework: "ai-sdk", logger: quiet }, testEnv());
      const mw = flywheelMiddleware();
      assert.equal(mw.middlewareVersion, "v2");
      const params = {
        prompt: [
          { role: "system", content: "You are support." },
          { role: "user", content: [{ type: "text", text: "earlier" }] },
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
          { role: "user", content: [{ type: "text", text: "refund 7" }] },
        ],
        tools: [{ type: "function", name: "refund", description: "d", inputSchema: { type: "object" } }],
      };
      const model = { provider: "openai.chat", modelId: "gpt-x" };
      assert.deepEqual(modelInputOf(params, model), {
        systemPrompt: "You are support.",
        prompt: "refund 7",
        historyMessages: [params.prompt[1], params.prompt[2]],
        provider: "openai.chat",
        model: "gpt-x",
        tools: params.tools,
      });
      await fw.turn("refund 7", async () => {
        assert.equal(await mw.wrapGenerate({ doGenerate: async () => "R", params, model }), "R");
        assert.equal(await mw.wrapStream({ doStream: async () => "S", params, model }), "S");
        return "x";
      });
      const described = JSON.parse(readFileSync(join(dir, "discovered_agent.json"), "utf8"));
      assert.equal(described.framework, "ai-sdk");
      assert.equal(described.source_type, "sdk_runtime");
      assert.equal(described.system_prompt, "You are support.");
      assert.deepEqual(described.tool_definitions.map((t) => t.name), ["refund"]);
      assert.deepEqual(described.discovered_model_config,
        { provider: "openai.chat", model_name: "gpt-x" });
    } finally {
      if (before === undefined) delete process.env[TRAJECTORY_DIR_ENV];
      else process.env[TRAJECTORY_DIR_ENV] = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a pass-through outside a turn, middleware included", async () => {
    const mw = flywheelMiddleware();
    assert.equal(await mw.wrapGenerate({ doGenerate: async () => 1, params: {}, model: {} }), 1);
  });
});

describe("the LangChain.js adapter", () => {
  const serialized = (name) => ({ lc: 1, type: "not_implemented", id: ["langchain", "tools", name] });

  it("records each tool run by its run id: an error is failed, an output is unknown", async () => {
    const env = testEnv();
    const fw = flywheel({ agentId: "lc", logger: quiet }, env);
    await fw.turn("go", async () => {
      const h = flywheelCallbacks();
      h.handleToolStart(serialized("lookup"), '{"id":7}', "run-1", undefined, [], {}, "lookup", "call_1");
      h.handleToolStart(serialized("refund"), "plain text", "run-2", undefined, [], {}, undefined);
      h.handleToolError(new Error("denied"), "run-2");
      h.handleToolEnd('{"id":"ord_9f8e7d6c5b4a"}', "run-1");
      h.handleToolEnd("late", "run-unknown");
      return "done";
    });
    const calls = toolCalls(env, "lc");
    assert.deepEqual(calls.map((c) => [c.name, c.outcome]), [["refund", "failed"], ["lookup", "unknown"]]);
    assert.deepEqual(calls[0].arguments, { input: "plain text" });
    assert.deepEqual(calls[1].arguments, { id: 7 });
    assert.equal(calls[1].tool_call_id, "call_1");
  });

  it("binds the turn it was created in, and records nothing when created outside one", async () => {
    const outside = flywheelCallbacks();
    assert.doesNotThrow(() => {
      outside.handleToolStart(serialized("x"), "{}", "r");
      outside.handleToolEnd("y", "r");
    });
    assert.equal(outside.raiseError, false, "a record never fails the customer's run");
  });

  it("reads the chat model's input: system, prompt, history, model and bound tools", () => {
    const msg = (type, content) => ({ _getType: () => type, content });
    const input = lcModelInputOf(
      { id: ["langchain", "chat_models", "openai", "ChatOpenAI"] },
      [[msg("system", "You are support."), msg("human", "hi"), msg("ai", "hello"), msg("human", "refund 7")]],
      { invocation_params: { model: "gpt-x", tools: [{ type: "function", function: { name: "refund" } }] } },
    );
    assert.deepEqual(input, {
      systemPrompt: "You are support.",
      prompt: "refund 7",
      historyMessages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
      provider: "ChatOpenAI",
      model: "gpt-x",
      tools: [{ type: "function", function: { name: "refund" } }],
    });
  });
});
