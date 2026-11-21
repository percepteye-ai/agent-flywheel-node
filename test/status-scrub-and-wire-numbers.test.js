/**
 * An `unknown` call carries no recoverable status, and a tool call and a
 * reward leave in the shape the schema publishes: the Python SDK's
 * `tests/test_status_scrub_and_wire_numbers.py` (PY-H13), ported. That suite
 * also drives `scrubStatus` against `_scrub_status` over one table and
 * compares the bytes.
 */
import "./support/home.js";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { readTrajectory } from "../src/trajectory.js";
import {
  ContractError, rolloutOutputToWire, scrubStatus, toolCallToWire,
} from "../src/wire.js";

const unknown = (output) => toolCallToWire({
  name: "POST /issue", arguments: {}, outcome: "unknown", status_code: 200, output });

describe("the status scrub (PY-H13)", () => {
  it("scrubs a JSON body inside an object's string value", () => {
    // Mutation: back to regex-and-trim for an object's strings -> red.
    const tc = unknown({ body: JSON.stringify({ status_code: 200, id: "PROJ-1" }) });
    assert.deepEqual(JSON.parse(tc.output.body), { id: "PROJ-1" });
    assert.equal(tc.status_code, null);
  });

  it("writes the body back in json.dumps's spelling", () => {
    assert.equal(scrubStatus('{"a":"é","status":1,"b":[1,2]}'),
      '{"a": "\\u00e9", "b": [1, 2]}');
  });

  for (const line of ["HTTP/1.1 200", "HTTP/2 201", "http/1.0 204", "HTTP 200 OK"]) {
    it(`scrubs the status line spelled ${line}`, () => {
      // Mutation: back to /\bHTTP\s*\d{3}\b/ -> the versioned lines stay, red.
      assert.ok(!/[0-9]{3}/.test(unknown(`got ${line} back`).output));
    });
  }

  for (const key of ["Status", "STATUS_CODE", "statusCode", "StatusCode", "HTTP_Status", "Code"]) {
    it(`finds the status key ${key} whatever its case`, () => {
      // Mutation: compare keys as spelled -> red.
      assert.deepEqual(unknown({ [key]: 200, keep: 1 }).output, { keep: 1 });
    });
  }

  it("reads a JSON scalar string as text, not a body", () => {
    assert.equal(scrubStatus('"HTTP 200 inside"'), '" inside"');
    assert.equal(scrubStatus("42"), "42");
  });

  it("reads NaN and Infinity as null and still scrubs the body", () => {
    assert.equal(scrubStatus('{"a": NaN, "code": 1}'), '{"a": null}');
  });
});

describe("entity_ids leave under the schema's names", () => {
  it("lowercases a field's spelling", () => {
    // Mutation: drop entityIdsToWire -> {"ID": ...} goes out, red.
    const tc = toolCallToWire({ name: "t", outcome: "ok", status_code: 201,
      entity_ids: { " ID ": "10001", Key: "PROJ-1" } });
    assert.deepEqual(tc.entity_ids, { id: "10001", key: "PROJ-1" });
  });

  it("refuses two spellings of one field, and a field that is no identity", () => {
    assert.throws(() => toolCallToWire({ name: "t", outcome: "ok",
      entity_ids: { id: "1", ID: "2" } }), (e) => e instanceof ContractError
      && /twice/.test(e.message));
    assert.throws(() => toolCallToWire({ name: "t", outcome: "ok",
      entity_ids: { name: "Story 1" } }), ContractError);
  });

  it("is the rule readTrajectory reads by: an unknown row scrubbed, a refused row malformed", () => {
    // Mutation: readTrajectory back to pushing the raw row -> red.
    const dir = mkdtempSync(join(tmpdir(), "pe-scrub-"));
    writeFileSync(join(dir, "tool_calls.jsonl"), [
      { name: "a", outcome: "unknown", status_code: 200, output: "HTTP/1.1 200 ok" },
      { name: "b", outcome: "ok", status_code: 201, entity_ids: { ID: "9" } },
      { name: "c", outcome: "ok", status_code: 201, entity_ids: { id: "1", Id: "2" } },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const { calls, malformed } = readTrajectory(dir);
    assert.equal(malformed, 1);
    assert.deepEqual(calls.map((c) => [c.status_code, c.output ?? null, c.entity_ids ?? null]), [
      [null, " ok", null], [201, null, { id: "9" }]]);
  });
});

describe("a reward the wire cannot carry", () => {
  for (const reward of [true, false, NaN, Infinity, -Infinity, "1"]) {
    it(`is refused: ${String(reward)}`, () => {
      // Mutation: drop the refusal -> it goes out as sent, red.
      assert.throws(() => rolloutOutputToWire({ finalText: "x", reward }),
        (e) => e instanceof ContractError && /reward must be a finite number/.test(e.message));
    });
  }
  for (const reward of [0, 1, 0.5, -2]) {
    it(`is sent as given: ${reward}`, () => {
      assert.equal(rolloutOutputToWire({ finalText: "x", reward }).reward, reward);
    });
  }
});
