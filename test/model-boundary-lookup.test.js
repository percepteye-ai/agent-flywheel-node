/**
 * The model boundary's lookup tables answer only for their own keys.
 *
 * A provider id and a stop reason are the host's strings. Indexed into a plain
 * object, `constructor`, `toString` or `__proto__` answered with
 * `Object.prototype`'s member -- a function or an object where the GenAI
 * attribute must be a string -- instead of falling through to the verbatim id.
 */
import "./support/home.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inputFromLlmInput, operationsFromRun } from "../src/model-boundary.js";

const INHERITED = ["constructor", "toString", "__proto__", "hasOwnProperty"];

describe("the model boundary's lookups", () => {
  it("passes an inherited-member provider id through verbatim", () => {
    for (const provider of INHERITED) {
      const first = inputFromLlmInput({ prompt: "hi", provider }, "1");
      assert.equal(first.provider, provider);
    }
    assert.equal(inputFromLlmInput({ prompt: "hi", provider: "google" }, "1").provider,
      "gcp.gemini");
  });

  it("reads an inherited-member stop reason as no known reason", () => {
    for (const stopReason of INHERITED) {
      const first = inputFromLlmInput({ prompt: "hi", provider: "openai" }, "1");
      const ops = operationsFromRun(first, [
        { role: "user", content: "hi", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "ok" }],
          stopReason, provider: stopReason, timestamp: 2 },
      ], "3000000");
      const chat = ops.operations.find((op) => op.operation === "chat");
      assert.equal(chat.output_messages[0].finish_reason, "stop", stopReason);
      assert.equal(chat.provider_name, stopReason);
    }
  });
});
