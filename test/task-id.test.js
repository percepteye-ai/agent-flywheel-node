/**
 * A task_id is valid exactly when Mission Control's intake takes it
 * (`is_canonical_task_id`: equal to its own strip(), every character
 * `str.isprintable()`), and the identifier patterns answer as the published
 * schema's -- the Python SDK's `test_task_id_is_the_control_planes.py`, this
 * side of it.
 */
import "./support/home.js";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { taskIdOf } from "../src/host.js";
import { AttachTransport } from "../src/transport.js";
import { readTaskId, recordTaskId, TASK_ID_FILENAME } from "../src/turns.js";
import {
  PRODUCTION_IDENTIFIER_PATTERN, PRODUCTION_TURN_IDENTIFIER_PATTERN,
  productionIdentifier, productionTaskIdentifier, productionTurnIdentifier,
  TASK_IDENTIFIER_PATTERN,
} from "../src/wire.js";

const SCHEMA = JSON.parse(readFileSync(
  new URL("../schema/flywheel-1.json", import.meta.url), "utf8"));

/** Each a character `str.isprintable()` refuses, which the shared grammar let through. */
const NOT_PRINTABLE = {
  "zero width space": "​",
  "line separator": " ",
  "paragraph separator": " ",
  "soft hyphen": "­",
  "byte order mark": "﻿",
  "no-break space": " ",
  "ideographic space": "　",
  "unassigned U+0378": "͸",
  "private use U+E000": "",
};

describe("productionTaskIdentifier is the control plane's predicate", () => {
  for (const [name, ch] of Object.entries(NOT_PRINTABLE)) {
    it(`refuses a task id carrying a ${name}`, () => {
      const id = `case${ch}1`;
      assert.equal(productionIdentifier(id), id, "the shared grammar alone let it through");
      assert.equal(productionTaskIdentifier(id), null);
      assert.equal(taskIdOf({ taskId: id }, {}), null, "capture omits it");
    });
  }

  it("keeps a printable task id, astral and internal spaces included", () => {
    for (const id of ["case-1", "a b", "café — #42", "\u{1f4e6} parcel", "x".repeat(255)]) {
      assert.equal(productionTaskIdentifier(id), id);
      assert.equal(taskIdOf({ taskId: id }, {}), id);
    }
  });

  it("keeps every rule the shared grammar already had", () => {
    for (const id of [null, "", " lead", "trail ", "x".repeat(256), 7, "\ud800"]) {
      assert.equal(productionTaskIdentifier(id), null, JSON.stringify(id));
    }
  });

  it("is what the turn sidecar writer and reader apply", () => {
    const dir = mkdtempSync(join(tmpdir(), "task-id-"));
    try {
      assert.equal(recordTaskId(dir, "case​1"), false);
      // A sidecar an older SDK wrote under the looser rule is not sent.
      writeFileSync(join(dir, TASK_ID_FILENAME), "case​1", "utf8");
      assert.equal(readTaskId(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is what the turn transport refuses before anything is sent", () => {
    const calls = [];
    const tx = new AttachTransport(
      { request: async (...args) => { calls.push(args); return {}; } },
      { agentId: "agent-1" },
    );
    assert.throws(
      () => tx.reportTurns("agent-1", [{
        turn_id: "t1", input_text: "hi", final_text: "ok", tool_calls: null,
        tool_calls_omitted_count: 0, task_id: "case​1",
      }]),
      /invalid task_id/,
    );
    assert.deepEqual(calls, []);
  });
});

describe("the identifier patterns are the published schema's", () => {
  const turn = SCHEMA.$defs.ProductionTurn.properties;

  it("publishes the same strings this SDK compiles", () => {
    assert.equal(turn.task_id.pattern, TASK_IDENTIFIER_PATTERN);
    assert.equal(turn.conversation_id.pattern, PRODUCTION_IDENTIFIER_PATTERN);
    assert.equal(turn.turn_id.pattern, PRODUCTION_TURN_IDENTIFIER_PATTERN);
    assert.match(turn.task_id.description, /isprintable/);
  });

  it("refuses in ECMA-262 what Python's re refuses", () => {
    // `.` does not match U+2028/U+2029 here and does in Python; `\s` covers
    // U+FEFF here and not in Python. Each of these was let through by the
    // old patterns in this SDK alone.
    for (const id of ["a  ", "a  ", "﻿a", "a﻿"]) {
      assert.equal(productionIdentifier(id), null, JSON.stringify(id));
    }
    assert.equal(productionTurnIdentifier("a /b"), null);
    assert.equal(productionIdentifier("a b"), "a b");
  });

  it("never refuses a task id the predicate takes (BMP)", () => {
    const pattern = new RegExp(TASK_IDENTIFIER_PATTERN, "u");
    const refused = [];
    for (let cp = 0; cp < 0x10000; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const id = `a${String.fromCodePoint(cp)}b`;
      if (productionTaskIdentifier(id) !== null && !pattern.test(id)) {
        refused.push(cp.toString(16));
      }
    }
    assert.deepEqual(refused, []);
  });
});
