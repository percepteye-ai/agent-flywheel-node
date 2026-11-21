/**
 * D: the one-line model-client wrappers. The shared `model_wrappers.json`
 * holds both SDKs to the same chat operation for the same provider request
 * and response; the rest pins OBSERVE ONLY: the same promise and the same
 * stream object go back, every chunk passes untouched, and nothing is
 * recorded outside a consenting production turn.
 */
import "./support/home.js";
import { testEnv } from "./support/home.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { flywheel, wrapAnthropic, wrapGemini, wrapOpenAI } from "../src/index.js";
import {
  chatOperation, requestOf, responseOf, streamResponseOf,
} from "../src/wrappers.js";
import { OBSERVATION_FILENAME } from "../src/genai-otlp.js";
import { turnWire } from "../src/turns.js";

const quiet = { info() {}, warn() {}, error() {} };
const FIXTURE = JSON.parse(readFileSync(
  new URL("./fixtures/model_wrappers.json", import.meta.url), "utf8"));

describe("D: the wrappers' operations match the Python SDK's (model_wrappers.json)", () => {
  for (const c of FIXTURE.cases) {
    it(c.name, () => {
      const request = requestOf(c.api, c.request);
      const answer = c.stream ? streamResponseOf(c.api, c.stream) : responseOf(c.api, c.response);
      const { span_id: _s, ...op } = chatOperation(request, { start: "1", end: "2", answer });
      assert.deepEqual(op, c.expected);
      // Byte-for-byte, not only equal: key order is what both SDKs write.
      assert.equal(JSON.stringify(op), JSON.stringify(c.expected));
    });
  }
});

function production({ consent = true } = {}) {
  const env = testEnv();
  const fw = flywheel({ agentId: "a", logger: quiet }, env);
  fw.plugin.capture.turns.gateModelContent(() => consent);
  return { fw, dir: (id) => join(env.PERCEPTEYE_HOME, "captured", "a", id) };
}

const chats = (dir) => {
  const trace = turnWire(dir, { modelContentAgent: "a" }).genai_trace;
  return (trace?.resourceSpans[0].scopeSpans[0].spans ?? [])
    .filter((s) => s.attributes.some((a) => a.key === "gen_ai.operation.name"
      && a.value.stringValue === "chat"));
};
const attr = (span, key) => span.attributes.find((a) => a.key === key)?.value.stringValue;

/** A promise with an extra method, as openai's and anthropic's APIPromise are. */
function apiPromise(value) {
  const p = Promise.resolve(value);
  p.withResponse = () => "kept";
  return p;
}

describe("D: wrapOpenAI / wrapAnthropic / wrapGemini observe only", () => {
  it("records an OpenAI call in a turn and returns the client's own promise", async () => {
    const { fw, dir } = production();
    const response = { model: "gpt-4o-mini-2024", choices: [{ finish_reason: "stop",
      message: { role: "assistant", content: "It shipped." } }] };
    const body = { model: "gpt-4o-mini", messages: [{ role: "user", content: "Where?" }] };
    let sent = null;
    let returned = null;
    const client = wrapOpenAI({ chat: { completions: {
      create(b) { sent = b; returned = apiPromise(response); return returned; } } } });
    assert.equal(wrapOpenAI(client), client, "wrapping twice is wrapping once");
    await fw.turn("Where?", async () => {
      const p = client.chat.completions.create(body);
      assert.equal(p, returned, "the SAME promise goes back");
      assert.equal(p.withResponse(), "kept");
      assert.equal(await p, response);
      return "It shipped.";
    }, { turnId: "t-openai" });
    assert.equal(sent, body, "the request is passed on as given");
    const [chat] = chats(dir("t-openai"));
    assert.equal(attr(chat, "gen_ai.provider.name"), "openai");
    assert.deepEqual(JSON.parse(attr(chat, "gen_ai.output.messages"))[0].parts,
      [{ type: "text", content: "It shipped." }]);
  });

  it("reads an Anthropic stream on its way through, chunks untouched", async () => {
    const { fw, dir } = production();
    const events = [
      { type: "message_start", message: { model: "claude-x" } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
    ];
    const stream = { async *[Symbol.asyncIterator]() { yield* events; } };
    const client = wrapAnthropic({ messages: { create: () => apiPromise(stream) } });
    const seen = [];
    await fw.turn("Hi", async () => {
      const s = await client.messages.create({ model: "claude", stream: true,
        messages: [{ role: "user", content: "Hi" }] });
      assert.equal(s, stream, "the SAME stream object");
      for await (const e of s) seen.push(e);
      return "Hi";
    }, { turnId: "t-anthropic" });
    assert.deepEqual(seen, events);
    const [chat] = chats(dir("t-anthropic"));
    assert.equal(attr(chat, "gen_ai.response.model"), "claude-x");
    assert.deepEqual(JSON.parse(attr(chat, "gen_ai.output.messages"))[0].parts,
      [{ type: "text", content: "Hi" }]);
  });

  it("records Anthropic's stream helper from its finalMessage event, same stream back", async () => {
    // Mutation: leave messages.stream unwrapped -- red.
    const { EventEmitter } = await import("node:events");
    const { fw, dir } = production();
    const stream = new EventEmitter();
    const client = wrapAnthropic({ messages: { create: () => apiPromise({}), stream: () => stream } });
    await fw.turn("Hi", async () => {
      const s = client.messages.stream({ model: "claude", messages: [{ role: "user", content: "Hi" }] });
      assert.equal(s, stream, "the SAME MessageStream");
      s.emit("finalMessage", { model: "claude-x", stop_reason: "end_turn",
        content: [{ type: "text", text: "Hi" }] });
      return "Hi";
    }, { turnId: "t-anthropic-helper" });
    const [chat] = chats(dir("t-anthropic-helper"));
    assert.equal(attr(chat, "gen_ai.response.model"), "claude-x");
  });

  it("reads a Gemini stream (an async generator) and records a failed call", async () => {
    const { fw, dir } = production();
    async function* gen() {
      yield { modelVersion: "g", candidates: [{ content: { parts: [{ text: "He" }] } }] };
      yield { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "llo" }] } }] };
    }
    const client = wrapGemini({ models: {
      generateContentStream: async () => gen(),
      generateContent: async () => { throw new RangeError("quota"); },
    } });
    await fw.turn("Hi", async () => {
      let text = "";
      for await (const c of await client.models.generateContentStream({ model: "g", contents: "Hi" })) {
        text += c.candidates[0].content.parts[0].text;
      }
      assert.equal(text, "Hello");
      await assert.rejects(client.models.generateContent({ model: "g", contents: "Hi" }), RangeError);
      return text;
    }, { turnId: "t-gemini" });
    const [streamed, failed] = chats(dir("t-gemini"));
    assert.deepEqual(JSON.parse(attr(streamed, "gen_ai.output.messages"))[0].parts,
      [{ type: "text", content: "Hello" }]);
    assert.equal(attr(failed, "error.type"), "RangeError");
  });

  it("records nothing outside a turn, or without model-content consent", async () => {
    const { fw, dir } = production({ consent: false });
    const client = wrapOpenAI({ chat: { completions: { create: async () => ({ choices: [] }) } } });
    await client.chat.completions.create({ model: "m", messages: [] });
    await fw.turn("x", async () => {
      await client.chat.completions.create({ model: "m", messages: [] });
      return "y";
    }, { turnId: "t-none" });
    assert.equal(existsSync(join(dir("t-none"), OBSERVATION_FILENAME)), false);
  });
});
