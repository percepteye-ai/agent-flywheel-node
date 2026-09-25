/**
 * Production MODEL-CONTENT capture: what a turn's model calls saw and said,
 * recorded under its own consent tier and uploaded as one OTel GenAI trace.
 *
 * The happy path is the first suite and it runs through the plugin's real
 * `register()`: the host's `llm_input` and `agent_end` hooks fire as OpenClaw
 * fires them, the control plane grants `model_content`, and the turn that
 * reaches `reportTurns` carries a `genai_trace` whose chat spans hold each
 * model call's WHOLE input -- the system prompt, the history, the tool
 * definitions and the tool result -- and whose tool span holds what the tool
 * returned. Everything after it pins a refusal or a boundary: no consent,
 * nothing recorded; a prefix this plugin cannot see, nothing rendered; a
 * revocation, nothing more sent.
 */
import { strict as assert } from "node:assert";
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  MODEL_CONTENT_REFUSED, captureVerdict, createTurnCapture, createTurnUploader,
  registerTurnCapture,
} from "../src/capture.js";
import { TransportError } from "../src/errors.js";
import { OBSERVATION_FILENAME } from "../src/genai-otlp.js";
import { PLUGIN_ID, register } from "../src/index.js";
import { turnWire } from "../src/turns.js";

const tmp = () => mkdtempSync(join(tmpdir(), "percepteye-mc-"));
const CONVERSATION = "7d0c2a8e-4b1f-4c3e-9a57-2f1e6b8d9c10";
const SYSTEM = "You are Acme's order-support agent. Look orders up before answering.";
const TOOL = {
  name: "lookup_order",
  label: "Lookup",
  description: "Look up an order's shipping status.",
  parameters: {
    type: "object",
    properties: { order_id: { type: "string" } },
    required: ["order_id"],
  },
  execute() { throw new Error("never called by the observer"); },
};

/** `llm_input` exactly as OpenClaw 2026.7.1 emits it for a run's first call. */
function llmInput(runId, { prompt = "Where is my order 4417?", history = [], ...over } = {}) {
  return {
    runId, sessionId: "sess-1", provider: "openai", model: "gpt-4o-mini",
    systemPrompt: SYSTEM, prompt, historyMessages: history, imagesCount: 0,
    tools: [TOOL], ...over,
  };
}

/** `agent_end`'s transcript for a tool loop: call, result, answer. */
function transcript(history = []) {
  return [
    ...history,
    { role: "user", content: "Where is my order 4417?", timestamp: 1758000000005 },
    {
      role: "assistant", provider: "openai", model: "gpt-4o-mini-2024-07-18",
      stopReason: "toolUse", timestamp: 1758000000060,
      content: [{ type: "toolCall", id: "call_1", name: "lookup_order",
                  arguments: { order_id: "4417" } }],
    },
    {
      role: "toolResult", toolCallId: "call_1", toolName: "lookup_order",
      content: [{ type: "text", text: '{"status":"shipped","eta":"Friday"}' }],
      isError: false, timestamp: 1758000000100,
    },
    {
      role: "assistant", provider: "openai", model: "gpt-4o-mini-2024-07-18",
      stopReason: "stop", timestamp: 1758000000160,
      content: [{ type: "text", text: "Order 4417 has shipped and arrives Friday." }],
    },
  ];
}

function hostApi() {
  const hooks = [];
  return {
    hooks,
    id: PLUGIN_ID,
    logger: { info() {}, warn() {} },
    on(name, fn) { hooks.push({ name, fn }); },
    config: {
      plugins: { entries: { [PLUGIN_ID]: { hooks: { allowConversationAccess: true } } } },
    },
    fire(name, ...args) {
      for (const h of hooks) if (h.name === name) h.fn(...args);
    },
  };
}

function transport({ modelContent = true, reason = null } = {}) {
  const batches = [];
  return {
    batches,
    register() { return { capture: { turns: true, model_content: modelContent } }; },
    async captureCurrent() {
      return { capture: { turns: true, model_content: modelContent,
                          ...(reason ? { model_content_reason: reason } : {}) } };
    },
    async reportTurns(_agentId, turns) {
      batches.push(turns);
      return { turns: turns.map((t) => ({ turn_id: t.turn_id, accepted: true })) };
    },
    get sent() { return batches.flat(); },
  };
}

const spans = (trace) => trace.resourceSpans[0].scopeSpans[0].spans;
const attrs = (span) => Object.fromEntries(
  span.attributes.map((a) => [a.key, a.value.stringValue ?? a.value]));

/** One served turn, through the plugin's real hooks. */
function serveTurn(a, runId, history = []) {
  const ctx = { runId, sessionKey: CONVERSATION, agentId: "acme-support" };
  a.fire("message_received", { runId, content: "Where is my order 4417?",
                               sessionKey: CONVERSATION }, ctx);
  a.fire("llm_input", llmInput(runId, { history }), ctx);
  a.fire("agent_end", { runId, success: true, messages: transcript(history) }, ctx);
}

describe("the happy path, through register()", () => {
  it("uploads a turn carrying its model calls' whole input and output", async () => {
    const root = tmp();
    const a = hostApi();
    const tr = transport();
    const turns = createTurnCapture({ root });
    const wired = registerTurnCapture(a, {
      config: { apiKey: "k", agentId: "acme-support" }, turns,
      pluginId: PLUGIN_ID, logger: a.logger, env: { PERCEPTEYE_CAPTURE_DIR: root },
      makeTransport: () => tr,
    });
    await wired.started;
    assert.equal(wired.uploader.mayCaptureModelContent, true);
    const ctx = { runId: "run-1", sessionKey: CONVERSATION, agentId: "acme-support" };
    a.fire("message_received", { runId: "run-1", content: "Where is my order 4417?",
                                 sessionKey: CONVERSATION }, ctx);
    // llm_input reaches the turn store through index.js's one subscription
    // (the describer's); the next test proves that route through register().
    turns.onLlmInput(llmInput("run-1"), ctx);
    a.fire("agent_end", { runId: "run-1", success: true, messages: transcript() }, ctx);

    const res = await wired.uploader.flush();
    assert.equal(res.sent, 1);
    const [turn] = tr.sent;
    assert.equal(turn.conversation_id, CONVERSATION);
    assert.equal(turn.final_text, "Order 4417 has shipped and arrives Friday.");
    const [root_, chat1, tool, chat2] = spans(turn.genai_trace);
    assert.equal(attrs(root_)["gen_ai.operation.name"], "invoke_agent");
    assert.equal(attrs(root_)["gen_ai.agent.name"], "acme-support");
    for (const s of [root_, chat1, tool, chat2]) {
      assert.equal(attrs(s)["gen_ai.conversation.id"], CONVERSATION);
    }
    assert.deepEqual(JSON.parse(attrs(chat1)["gen_ai.system_instructions"]),
      [{ type: "text", content: SYSTEM }]);
    assert.deepEqual(JSON.parse(attrs(chat1)["gen_ai.input.messages"]), [
      { role: "user", parts: [{ type: "text", content: "Where is my order 4417?" }] },
    ]);
    assert.deepEqual(JSON.parse(attrs(chat1)["gen_ai.tool.definitions"]), [{
      type: "function", name: "lookup_order",
      description: "Look up an order's shipping status.",
      parameters: TOOL.parameters,
    }]);
    assert.deepEqual(JSON.parse(attrs(chat1)["gen_ai.output.messages"]), [{
      role: "assistant",
      parts: [{ type: "tool_call", id: "call_1", name: "lookup_order",
                arguments: { order_id: "4417" } }],
      finish_reason: "tool_call",
    }]);
    assert.equal(attrs(tool)["gen_ai.tool.call.result"],
      JSON.stringify('{"status":"shipped","eta":"Friday"}'));
    // The second call's input is the first call's, extended by exactly what
    // the loop sent back: the model's own call and the tool's result.
    assert.deepEqual(JSON.parse(attrs(chat2)["gen_ai.input.messages"]), [
      { role: "user", parts: [{ type: "text", content: "Where is my order 4417?" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "call_1",
                                     name: "lookup_order", arguments: { order_id: "4417" } }] },
      { role: "tool", parts: [{ type: "tool_call_response", id: "call_1",
                                response: '{"status":"shipped","eta":"Friday"}' }] },
    ]);
    assert.equal(attrs(chat2)["gen_ai.response.model"], "gpt-4o-mini-2024-07-18");
    // Ordered, and inside the turn.
    const t = (s, k) => BigInt(s[k]);
    assert.ok(t(chat1, "endTimeUnixNano") <= t(tool, "startTimeUnixNano"));
    assert.ok(t(tool, "endTimeUnixNano") <= t(chat2, "startTimeUnixNano"));
    assert.ok(t(root_, "startTimeUnixNano") <= t(chat1, "startTimeUnixNano"));
    assert.ok(t(chat2, "endTimeUnixNano") <= t(root_, "endTimeUnixNano"));
  });

  it("routes the host's llm_input to capture through register()", () => {
    const root = tmp();
    const a = hostApi();
    const out = register(a, {}, {
      PERCEPTEYE_AGENT_MODE: "production", PERCEPTEYE_CAPTURE_DIR: root,
    });
    out.capture.turns.gateModelContent(() => true);
    serveTurn(a, "run-9");
    assert.ok(existsSync(join(root, "run-9", OBSERVATION_FILENAME)),
      "llm_input never reached the turn store through the plugin's hook");
  });
});

describe("consent: model content is RECORDED only when granted", () => {
  it("is granted only by the exact value, on a granted turn", () => {
    // The full table is driven through BOTH SDKs by the Python suite's
    // test_capture_verdict_parity.py; these are its three load-bearing rows.
    assert.equal(captureVerdict({ capture: { turns: true, model_content: true } })
      .mayCaptureModelContent, true);
    assert.equal(captureVerdict({ capture: { turns: true, model_content: "true" } })
      .mayCaptureModelContent, false);
    const riding = captureVerdict({ capture: { turns: false, model_content: true,
                                               reason: "no scope" } });
    assert.equal(riding.mayCaptureModelContent, false);
    assert.equal(riding.modelContentReason, "no scope");
  });

  it("records nothing, anywhere, without the second tier", () => {
    const root = tmp();
    const turns = createTurnCapture({ root });
    const ctx = { runId: "r", sessionKey: CONVERSATION };
    // Refused at the FIRST hook, not only at the write: an unconsented run's
    // prompt is not even held in memory until its agent_end.
    assert.equal(turns.onLlmInput(llmInput("r"), ctx), false);
    turns.onAgentEnd({ runId: "r", messages: transcript() }, ctx);
    assert.ok(!existsSync(join(root, "r", OBSERVATION_FILENAME)));
    assert.ok(!("genai_trace" in turnWire(join(root, "r"), { modelContentAgent: "a" })));
  });

  it("uploads no trace once the control plane withdraws the tier", async () => {
    const root = tmp();
    const turns = createTurnCapture({ root });
    turns.gateModelContent(() => true);
    const ctx = { runId: "r", sessionKey: CONVERSATION };
    turns.onLlmInput(llmInput("r"), ctx);
    turns.onAgentEnd({ runId: "r", messages: transcript() }, ctx);
    const tr = transport();
    const u = createTurnUploader({ transport: tr, agentId: "a", root });
    u.setVerdict({ mayUpload: true, mayCaptureModelContent: false,
                   modelContentReason: "withdrawn" });
    tr.captureCurrent = async () => ({ capture: { turns: true, model_content: false } });
    await u.flush();
    assert.ok(!("genai_trace" in tr.sent[0]),
      "a recorded trace was sent after the tier was withdrawn");
  });

  it("stops recording when the intake refuses a trace by name", async () => {
    const root = tmp();
    const turns = createTurnCapture({ root });
    const tr = transport();
    tr.reportTurns = async (_a, ts) => {
      tr.batches.push(ts);
      return { turns: ts.map((t) => ({
        turn_id: t.turn_id, accepted: true,
        genai_trace: { stored: false, error: MODEL_CONTENT_REFUSED,
                       detail: "an operator withdrew model-content capture" },
      })) };
    };
    const u = createTurnUploader({ transport: tr, agentId: "a", root });
    u.setVerdict(captureVerdict({ capture: { turns: true, model_content: true } }));
    turns.gateModelContent(() => u.mayCaptureModelContent);
    const ctx = { runId: "r", sessionKey: CONVERSATION };
    turns.onLlmInput(llmInput("r"), ctx);
    turns.onAgentEnd({ runId: "r", messages: transcript() }, ctx);
    await u.flush();
    assert.ok("genai_trace" in tr.sent[0]);
    assert.equal(u.mayCaptureModelContent, false);
    assert.equal(u.modelContentReason, "an operator withdrew model-content capture");
    turns.onLlmInput(llmInput("r2"), { runId: "r2" });
    turns.onAgentEnd({ runId: "r2", messages: transcript() }, { runId: "r2" });
    assert.ok(!existsSync(join(root, "r2", OBSERVATION_FILENAME)),
      "model content was recorded after the intake refused it");
  });

  it("stops recording model content when the intake refuses the turns", async () => {
    // A 403 on /turns is an operator's decision, not a blip. Read as a blip it
    // left both tiers on, and every later run's system prompt, history and
    // tool results were written to disk while consent was withdrawn -- ready
    // to be uploaded if consent came back, which makes the grant retroactive.
    const root = tmp();
    const turns = createTurnCapture({ root });
    const tr = transport();
    let verdict = { turns: false, reason: "disabled by an operator" };
    tr.captureCurrent = async () => ({ capture: verdict });
    let posts = 0;
    tr.reportTurns = async () => {
      posts += 1;
      throw new TransportError(
        "POST /api/flywheel/v1/agents/a/turns -> HTTP 403: production " +
        "capture is not enabled for this agent.", { statusCode: 403 });
    };
    const u = createTurnUploader({ transport: tr, agentId: "a", root });
    u.setVerdict(captureVerdict({ capture: { turns: true, model_content: true } }));
    turns.gateModelContent(() => u.mayCaptureModelContent);
    const ctx = { runId: "r", sessionKey: CONVERSATION };
    turns.onLlmInput(llmInput("r"), ctx);
    turns.onAgentEnd({ runId: "r", messages: transcript() }, ctx);
    assert.ok(existsSync(join(root, "r", OBSERVATION_FILENAME)));

    const res = await u.flush();
    assert.equal(res.notPermitted, true);
    assert.equal(u.mayUpload, false, "a 403 was read as a transport blip");
    assert.equal(u.refusal, "production capture is not enabled for this agent.");
    assert.equal(u.mayCaptureModelContent, false,
      "model content is still being recorded after the intake refused the turns");
    assert.equal(u.modelContentReason, u.refusal);
    assert.equal(turns.onLlmInput(llmInput("r2"), { runId: "r2" }), false);
    turns.onAgentEnd({ runId: "r2", messages: transcript() }, { runId: "r2" });
    assert.ok(!existsSync(join(root, "r2", OBSERVATION_FILENAME)),
      "model content was recorded while consent was withdrawn");
    await u.flush();
    assert.equal(posts, 1, "the refused batch was POSTed again");

    // COMPLETES: an operator re-enables both tiers, and the next flush picks
    // the grant up, uploads the backlog and records model content again.
    verdict = { turns: true, model_content: true };
    tr.reportTurns = async (_a, ts) => {
      tr.batches.push(ts);
      return { turns: ts.map((t) => ({ turn_id: t.turn_id, accepted: true })) };
    };
    assert.equal((await u.flush()).sent, 2);
    assert.equal(u.mayUpload, true);
    assert.equal(u.mayCaptureModelContent, true);
    assert.equal(turns.onLlmInput(llmInput("r3"), { runId: "r3" }), true);
  });

  it("keeps both tiers through a transport blip", async () => {
    const root = tmp();
    const turns = createTurnCapture({ root });
    turns.gateModelContent(() => true);
    turns.onLlmInput(llmInput("r"), { runId: "r", sessionKey: CONVERSATION });
    turns.onAgentEnd({ runId: "r", messages: transcript() }, { runId: "r" });
    const tr = transport();
    let posts = 0;
    tr.reportTurns = async () => {
      posts += 1;
      throw new TransportError("POST /x -> HTTP 503: upstream", { statusCode: 503 });
    };
    const u = createTurnUploader({ transport: tr, agentId: "a", root });
    u.setVerdict(captureVerdict({ capture: { turns: true, model_content: true } }));
    await u.flush();
    assert.equal(posts, 1);
    assert.equal(u.mayUpload, true, "a 5xx was read as a revocation");
    assert.equal(u.mayCaptureModelContent, true);
  });

  it("notices a model-content grant made after startup", async () => {
    const root = tmp();
    const tr = transport({ modelContent: true });
    const u = createTurnUploader({ transport: tr, agentId: "a", root });
    u.setVerdict({ mayUpload: true, mayCaptureModelContent: false });
    await u.flush();
    assert.equal(u.mayCaptureModelContent, true);
  });
});

describe("what the plugin cannot see, it does not render", () => {
  const recorded = (event, messages) => {
    const root = tmp();
    const turns = createTurnCapture({ root });
    turns.gateModelContent(() => true);
    const ctx = { runId: "r", sessionKey: CONVERSATION };
    for (const e of [].concat(event)) turns.onLlmInput(e, ctx);
    turns.onAgentEnd({ runId: "r", messages }, ctx);
    return existsSync(join(root, "r", OBSERVATION_FILENAME));
  };

  it("records the plain run (the control for every refusal below)", () => {
    assert.equal(recorded(llmInput("r"), transcript()), true);
  });

  it("refuses a run that assembled a second model input", () => {
    assert.equal(recorded([llmInput("r"), llmInput("r")], transcript()), false);
  });

  it("refuses a prompt whose images llm_input does not carry", () => {
    assert.equal(recorded(llmInput("r", { imagesCount: 1 }), transcript()), false);
  });

  it("refuses a history message the host converts out of sight", () => {
    const history = [{ role: "compactionSummary", summary: "earlier turns" }];
    assert.equal(recorded(llmInput("r", { history }), transcript()), false);
  });

  it("refuses a runtime-context carrier the model saw and llm_input omits", () => {
    const messages = transcript();
    messages[0] = { ...messages[0], runtimeContextCarrier: true };
    assert.equal(recorded(llmInput("r"), messages), false);
  });

  it("records nothing for a run with no model answer", () => {
    assert.equal(recorded(llmInput("r"), [
      { role: "user", content: "hi", timestamp: 1 },
    ]), false);
  });

  it("records an errored model call as an error, never as an answer", () => {
    const root = tmp();
    const turns = createTurnCapture({ root });
    turns.gateModelContent(() => true);
    const ctx = { runId: "r", sessionKey: CONVERSATION };
    turns.onLlmInput(llmInput("r"), ctx);
    turns.onAgentEnd({ runId: "r", messages: [
      { role: "user", content: "hi", timestamp: 1 },
      { role: "assistant", content: [], stopReason: "error", errorType: "RateLimit",
        provider: "openai", model: "m", timestamp: 2 },
    ] }, ctx);
    const trace = turnWire(join(root, "r"), { modelContentAgent: "a" }).genai_trace;
    const chat = spans(trace)[1];
    assert.deepEqual(chat.status, { code: 2 });
    assert.equal(attrs(chat)["error.type"], "RateLimit");
    assert.ok(!("gen_ai.output.messages" in attrs(chat)));
  });
});

describe("clocks", () => {
  it("keeps the transcript's order when the host's clock cannot", () => {
    // Message timestamps behind the llm_input receipt, and two on one
    // millisecond: every span still starts after the one before it, so the
    // decoder's time order is the transcript's order.
    const root = tmp();
    const turns = createTurnCapture({ root });
    turns.gateModelContent(() => true);
    const ctx = { runId: "r", sessionKey: CONVERSATION };
    turns.onLlmInput(llmInput("r"), ctx);
    const messages = transcript().map((m) => ({ ...m, timestamp: 1 }));
    turns.onAgentEnd({ runId: "r", messages }, ctx);
    const children = spans(turnWire(join(root, "r"), { modelContentAgent: "a" })
      .genai_trace).slice(1);
    assert.deepEqual(children.map((s) => attrs(s)["gen_ai.operation.name"]),
      ["chat", "execute_tool", "chat"]);
    for (let i = 0; i < children.length; i += 1) {
      const start = BigInt(children[i].startTimeUnixNano);
      const endAt = BigInt(children[i].endTimeUnixNano);
      assert.ok(endAt > start, `span ${i} has no duration`);
      if (i) assert.ok(start >= BigInt(children[i - 1].endTimeUnixNano));
    }
  });
});

describe("the training lane is untouched", () => {
  it("records no model boundary in training mode, whatever the host fires", () => {
    // The rollout lane's report is its own contract, and the control plane's
    // GRPO reads it byte for byte. Production capture is not constructed in
    // training mode, so llm_input reaches no turn store at all.
    const home = tmp();
    const traj = tmp();
    const a = hostApi();
    const out = register(a, {}, {
      PERCEPTEYE_AGENT_MODE: "training", PERCEPTEYE_HOME: home,
      PERCEPTEYE_CAPTURE_DIR: join(home, "captured"),
      PERCEPTEYE_TRAJECTORY_DIR: traj,
    });
    assert.equal(out.capture, null);
    const ctx = { runId: "r", sessionKey: CONVERSATION };
    a.fire("llm_input", llmInput("r"), ctx);
    a.fire("agent_end", { runId: "r", messages: transcript() }, ctx);
    const found = [];
    const walk = (dir) => {
      for (const name of existsSync(dir) ? readdirSync(dir) : []) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name === OBSERVATION_FILENAME) found.push(path);
      }
    };
    walk(home);
    walk(traj);
    assert.deepEqual(found, []);
  });
});

describe("the wire", () => {
  it("renders the same trace on every read, so a retried upload is identical", () => {
    const root = tmp();
    const turns = createTurnCapture({ root });
    turns.gateModelContent(() => true);
    const ctx = { runId: "r", sessionKey: CONVERSATION };
    turns.onLlmInput(llmInput("r"), ctx);
    turns.onAgentEnd({ runId: "r", messages: transcript() }, ctx);
    const once = turnWire(join(root, "r"), { modelContentAgent: "a" });
    const twice = turnWire(join(root, "r"), { modelContentAgent: "a" });
    assert.deepEqual(once, twice);
    assert.ok(readFileSync(join(root, "r", OBSERVATION_FILENAME), "utf8")
      .split("\n").filter(Boolean).length >= 5);
  });

  it("names ONE trace per turn, however many runs are recorded into it", () => {
    // The upload carries exactly one trace per turn, so the second run's
    // operations join the first run's trace instead of minting another.
    const root = tmp();
    const turns = createTurnCapture({ root });
    turns.gateModelContent(() => true);
    const ctx = { runId: "r", sessionKey: CONVERSATION };
    for (let i = 0; i < 2; i += 1) {
      turns.onLlmInput(llmInput("r"), ctx);
      turns.onAgentEnd({ runId: "r", messages: transcript() }, ctx);
    }
    const records = readFileSync(join(root, "r", OBSERVATION_FILENAME), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(records.filter((r) => r.record === "trace").length, 1);
    assert.equal(records.filter((r) => r.record === "operation").length, 6);
  });

  it("keeps a turn without a model boundary byte-for-byte what it was", () => {
    const root = tmp();
    const turns = createTurnCapture({ root });
    turns.onMessageReceived({ runId: "r", content: "hi", sessionKey: CONVERSATION },
                            { runId: "r" });
    const plain = turnWire(join(root, "r"));
    const granted = turnWire(join(root, "r"), { modelContentAgent: "a" });
    assert.deepEqual(granted, plain);
    assert.ok(!("genai_trace" in granted));
  });
});
