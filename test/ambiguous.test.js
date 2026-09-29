/**
 * "Not registered" only when that is known.
 *
 * A request can fail AFTER the control plane performed it -- a timeout, a
 * dropped connection, a 502 from a proxy whose upstream finished -- and a
 * caller that then tells an operator "that did not happen" sends them to act
 * on something false. The client is the one place that saw every attempt, so
 * it is the one that says (`TransportError.ambiguous`), and `rulebookRefusal`
 * reads it. The Python SDK's client and `rulebook_refusal` answer the same
 * cases the same way; `test_rulebook_parity.py` there compares the sentences.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ControlPlaneClient } from "../src/http.js";
import { TransportError } from "../src/errors.js";
import { rulebookRefusal } from "../src/transport.js";

function netError(code) {
  const e = new TypeError("fetch failed");
  e.cause = { code };
  return e;
}

function timeout() {
  const e = new Error("The operation was aborted due to timeout");
  e.name = "TimeoutError";
  return e;
}

/** A client whose attempts meet `answers` in order: an Error (thrown by
 * fetch) or `[status, body]`. */
function attempts(...answers) {
  const queue = [...answers];
  return new ControlPlaneClient("https://cp.test", "pefw_k", {
    maxAttempts: answers.length,
    fetchImpl: async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      const [status, body] = next;
      return new Response(body, { status });
    },
  });
}

const CASES = [
  ["never sent", [netError("ECONNREFUSED")], false],
  ["never sent twice", [netError("ENOTFOUND"), netError("ECONNREFUSED")], false],
  ["a timeout", [timeout()], true],
  // OVER EVERY ATTEMPT: the last was never sent, the first may have landed.
  ["a timeout, then never sent", [timeout(), netError("ECONNREFUSED")], true],
  ["503 twice", [[503, '{"detail":"store unavailable"}'], [503, "{}"]], false],
  ["429 then 409", [[429, "{}"], [409, '{"detail":"no"}']], false],
  ["a 502", [[502, "bad gateway"]], true],
  ["a 500", [[500, "{}"]], true],
  ["504 then 409", [[504, "{}"], [409, '{"detail":"no"}']], true],
  ["an unparseable 2xx", [[200, "not json"]], true],
  // The lease refusal carries it too: the first attempt may have landed.
  ["a timeout, then 410", [timeout(), [410, '{"detail":"lease gone"}']], true],
  ["a 410", [[410, '{"detail":"lease gone"}']], false],
];

describe("the client says whether any attempt may have been performed", () => {
  for (const [name, answers, ambiguous] of CASES) {
    it(`${name}: ${ambiguous ? "ambiguous" : "not performed"}`, async () => {
      // Mutations: judge the last attempt only -> "a timeout, then never
      // sent" (red); count a 503 as performed -> red; an unparseable 2xx as
      // unperformed -> red; a timeout as never sent -> red.
      await assert.rejects(
        attempts(...answers).request("POST", "/agents/a/rulebook", {
          jsonBody: { rules: [] },
        }),
        (err) => {
          assert.ok(err instanceof TransportError);
          assert.equal(err.ambiguous, ambiguous);
          return true;
        },
      );
    });
  }
});

describe("rulebookRefusal", () => {
  it("names a failure after the rules may have landed as unknown", () => {
    // Mutation: ignore `ambiguous` -> "were not registered" (red).
    const err = new TransportError(
      "POST /agents/a/rulebook failed after 1 attempts: HTTP 502: gone",
      { ambiguous: true });
    assert.equal(
      rulebookRefusal(err),
      "whether this agent's rules were registered is unknown: POST " +
      "/agents/a/rulebook failed after 1 attempts: HTTP 502: gone. The " +
      "control plane may have received them before the failure; declaring " +
      "the same rules again is safe, because rules equal to the ones in " +
      "force are answered unchanged.");
  });

  it("says not registered when nothing can have been performed", () => {
    const refused = new TransportError(
      "POST /agents/a/rulebook -> HTTP 409: no", { statusCode: 409 });
    assert.equal(
      rulebookRefusal(refused),
      "this agent's rules were not registered: POST /agents/a/rulebook -> " +
      "HTTP 409: no. The rulebook in force, if any, is unchanged.");
    // A transport that threw before sending anything.
    assert.match(rulebookRefusal(new Error("socket closed")),
                 /^this agent's rules were not registered: socket closed\./);
  });
});
