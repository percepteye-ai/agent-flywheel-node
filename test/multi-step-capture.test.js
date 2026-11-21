/**
 * FULL MULTI-STEP CAPTURE through the framework API: a production turn run
 * with the AI SDK middleware or the LangChain.js callbacks records EVERY
 * model call (what it was sent, what it answered, the tool calls it asked
 * for) and every tool execution on the turn's model boundary -- never a
 * reconstruction from the first model input and a two-message transcript,
 * which held one chat call and no tool step at all.
 */
import "./support/home.js";
import { testEnv } from "./support/home.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { flywheel } from "../src/index.js";
import { flywheelMiddleware, flywheelTools } from "../src/adapters/ai-sdk.js";
import { flywheelCallbacks } from "../src/adapters/langchain.js";
import { OBSERVATION_FILENAME } from "../src/genai-otlp.js";
import { turnWire } from "../src/turns.js";

const quiet = { info() {}, warn() {}, error() {} };
const AGENT = "support-agent";

function production({ consent = true } = {}) {
  const env = testEnv();
  const fw = flywheel({ agentId: AGENT, logger: quiet }, env);
  fw.plugin.capture.turns.gateModelContent(() => consent);
  const dir = (turnId) => join(env.PERCEPTEYE_HOME, "captured", AGENT, turnId);
  return { fw, dir };
}

const spansOf = (dir) => {
  const trace = turnWire(dir, { modelContentAgent: AGENT }).genai_trace;
  return trace ? trace.resourceSpans[0].scopeSpans[0].spans : [];
};
const attrs = (span) => Object.fromEntries(
  span.attributes.map((a) => [a.key, Object.values(a.value)[0]]));
const op = (span) => attrs(span)["gen_ai.operation.name"];
const json = (span, key) => JSON.parse(attrs(span)[key]);

const MODEL = { provider: "openai.chat", modelId: "gpt-4o-mini", specificationVersion: "v2" };
// The model input is NOT the user's text: a template wraps it.
const templated = (input, extra = []) => [
  { role: "system", content: "You are Acme's order agent." },
  { role: "user", content: [{ type: "text", text: `Customer says:\n${input}\nAnswer briefly.` }] },
  ...extra,
];
const TOOLS = [{ type: "function", name: "lookup_order", description: "Find an order.",
  inputSchema: { type: "object", properties: { id: { type: "string" } } } }];

describe("C: the AI SDK adapter records every model call and tool execution", () => {
  it("records a tool loop: call, tool, call -- with a templated model input", async () => {
    const { fw, dir } = production();
    const mw = flywheelMiddleware();
    const tools = flywheelTools({
      lookup_order: { execute: async ({ id }) => ({ id, status: "shipped" }) },
    });
    const input = "Where is order 4417?";
    await fw.turn(input, async () => {
      const first = await mw.wrapGenerate({
        model: MODEL,
        params: { prompt: templated(input), tools: TOOLS },
        doGenerate: async () => ({
          content: [{ type: "tool-call", toolCallId: "c1", toolName: "lookup_order",
                      input: '{"id":"4417"}' }],
          finishReason: "tool-calls", response: { modelId: "gpt-4o-mini-2024-07-18" },
        }),
      });
      assert.equal(first.finishReason, "tool-calls", "the result is returned untouched");
      const result = await tools.lookup_order.execute({ id: "4417" }, { toolCallId: "c1" });
      await mw.wrapGenerate({
        model: MODEL,
        params: { prompt: templated(input, [
          { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1",
                                           toolName: "lookup_order", input: { id: "4417" } }] },
          { role: "tool", content: [{ type: "tool-result", toolCallId: "c1",
                                      toolName: "lookup_order",
                                      output: { type: "json", value: result } }] },
        ]), tools: TOOLS },
        doGenerate: async () => ({
          content: [{ type: "text", text: "It shipped." }], finishReason: "stop",
        }),
      });
      return "It shipped.";
    }, { turnId: "turn-ai", conversationId: "conv-1" });
    await fw.close();

    const spans = spansOf(dir("turn-ai")).filter((s) => op(s) !== "invoke_agent");
    assert.deepEqual(spans.map(op), ["chat", "execute_tool", "chat"]);
    const [chat1, tool, chat2] = spans;
    assert.deepEqual(json(chat1, "gen_ai.input.messages"), [
      { role: "user", parts: [{ type: "text",
        content: "Customer says:\nWhere is order 4417?\nAnswer briefly." }] },
    ]);
    assert.deepEqual(json(chat1, "gen_ai.system_instructions"),
      [{ type: "text", content: "You are Acme's order agent." }]);
    assert.deepEqual(json(chat1, "gen_ai.output.messages")[0].parts, [
      { type: "tool_call", id: "c1", name: "lookup_order", arguments: { id: "4417" } }]);
    assert.equal(json(chat1, "gen_ai.tool.definitions")[0].name, "lookup_order");
    assert.equal(attrs(chat1)["gen_ai.provider.name"], "openai");
    assert.equal(attrs(tool)["gen_ai.tool.name"], "lookup_order");
    assert.equal(attrs(tool)["gen_ai.tool.call.id"], "c1");
    const sent = json(chat2, "gen_ai.input.messages");
    assert.deepEqual(sent.at(-1), { role: "tool", parts: [{ type: "tool_call_response",
      id: "c1", response: { id: "4417", status: "shipped" } }] });
    assert.deepEqual(json(chat2, "gen_ai.output.messages")[0].parts,
      [{ type: "text", content: "It shipped." }]);
  });

  it("records a streamed call and passes every chunk through unchanged", async () => {
    const { fw, dir } = production();
    const mw = flywheelMiddleware();
    const chunks = [
      { type: "response-metadata", modelId: "gpt-4o-mini-2024-07-18" },
      { type: "text-delta", id: "t", delta: "It " },
      { type: "text-delta", id: "t", delta: "shipped." },
      { type: "finish", finishReason: "stop", usage: {} },
    ];
    let seen = [];
    await fw.turn("Where is 4417?", async () => {
      const out = await mw.wrapStream({
        model: MODEL, params: { prompt: templated("Where is 4417?") },
        doStream: async () => ({ stream: new ReadableStream({
          start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); },
        }), request: {} }),
      });
      for await (const ch of out.stream) seen.push(ch);
      return "It shipped.";
    }, { turnId: "turn-stream" });
    assert.deepEqual(seen, chunks);
    const [chat] = spansOf(dir("turn-stream")).filter((s) => op(s) === "chat");
    assert.deepEqual(json(chat, "gen_ai.output.messages")[0].parts,
      [{ type: "text", content: "It shipped." }]);
    assert.equal(attrs(chat)["gen_ai.response.model"], "gpt-4o-mini-2024-07-18");
  });

  it("records nothing a model call saw without model-content consent", async () => {
    const { fw, dir } = production({ consent: false });
    const mw = flywheelMiddleware();
    await fw.turn("hi", async () => {
      await mw.wrapGenerate({ model: MODEL, params: { prompt: templated("hi") },
        doGenerate: async () => ({ content: [{ type: "text", text: "hello" }],
                                   finishReason: "stop" }) });
      return "hello";
    }, { turnId: "turn-none" });
    assert.equal(existsSync(join(dir("turn-none"), OBSERVATION_FILENAME)), false);
  });
});

describe("C: the LangChain.js callbacks record every model call and tool execution", () => {
  const msg = (type, content, extra = {}) => ({ _getType: () => type, content, ...extra });

  it("records the chat calls, their tool calls and the tool's result", async () => {
    const { fw, dir } = production();
    await fw.turn("Where is order 4417?", async () => {
      const h = flywheelCallbacks();
      const llm = { id: ["langchain", "chat_models", "openai", "ChatOpenAI"] };
      const extra = { invocation_params: { model: "gpt-4o-mini", tools: [
        { type: "function", function: { name: "lookup_order", description: "Find an order.",
                                         parameters: { type: "object" } } }] } };
      const meta = { ls_provider: "openai" };
      const sys = msg("system", "You are Acme's order agent.");
      const user = msg("human", "Order question: Where is order 4417?");
      const call = msg("ai", "", { tool_calls: [{ id: "c1", name: "lookup_order", args: { id: "4417" } }],
                                   response_metadata: { finish_reason: "tool_calls" } });
      h.handleChatModelStart(llm, [[sys, user]], "m1", undefined, extra, [], meta);
      h.handleLLMEnd({ generations: [[{ message: call }]] }, "m1");
      h.handleToolStart({ name: "lookup_order" }, '{"id":"4417"}', "t1", undefined, [], {},
        "lookup_order", "c1");
      const toolMsg = msg("tool", '{"status":"shipped"}', { tool_call_id: "c1" });
      h.handleToolEnd(toolMsg, "t1");
      const answer = msg("ai", "It shipped.", { response_metadata: { finish_reason: "stop",
                                                                      model_name: "gpt-4o-mini-2024" } });
      h.handleChatModelStart(llm, [[sys, user, call, toolMsg]], "m2", undefined, extra, [], meta);
      h.handleLLMEnd({ generations: [[{ message: answer }]] }, "m2");
      return "It shipped.";
    }, { turnId: "turn-lc" });
    const spans = spansOf(dir("turn-lc")).filter((s) => op(s) !== "invoke_agent");
    assert.deepEqual(spans.map(op), ["chat", "execute_tool", "chat"]);
    const [chat1, tool, chat2] = spans;
    assert.deepEqual(json(chat1, "gen_ai.output.messages")[0].parts, [
      { type: "tool_call", id: "c1", name: "lookup_order", arguments: { id: "4417" } }]);
    assert.equal(json(chat1, "gen_ai.tool.definitions")[0].name, "lookup_order");
    assert.equal(attrs(tool)["gen_ai.tool.call.id"], "c1");
    assert.deepEqual(json(chat2, "gen_ai.input.messages").at(-1), { role: "tool",
      parts: [{ type: "tool_call_response", id: "c1", response: '{"status":"shipped"}' }] });
    assert.equal(attrs(chat2)["gen_ai.response.model"], "gpt-4o-mini-2024");
  });
});
