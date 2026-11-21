/**
 * THE EVIDENCE VOCABULARY IS THE PYTHON SDK'S, WORD FOR WORD.
 *
 * What a check's status may be, what it may establish, how an episode may
 * end, how many checks a report carries and how long each text may be are
 * stated twice -- `contract.py` and `wire.js` -- and read once, by the control
 * plane. The vendored schema pins the enums on each side separately, which
 * holds only while the two schema copies are the same file; the text limits
 * and the seed bound are in no schema both sides read. A status this package
 * accepts and Python refuses (or the reverse) is an `outcome.json` that is
 * evidence under one runner and silently nothing under the other.
 *
 * So this reads the Python SOURCE -- the authority -- and holds this package
 * to it: the constants by value, and the limits by BEHAVIOUR (a text at the
 * limit is sent, one character over is refused), since a constant nobody
 * enforces is not a limit. Where the Python checkout is, and when its absence
 * may skip, is `support/python-sdk.js`.
 */
import "./support/home.js";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { pythonFile } from "./support/python-sdk.js";
import { OUTCOME_FILENAME } from "../src/trajectory.js";
import {
  CHECK_ESTABLISHES, CHECK_STATUSES, ContractError, MAX_REPORTED_CHECKS,
  TERMINATION_CLASSES, WIRE_KEYS, checksToWire, seedsToWire, terminationToWire,
} from "../src/wire.js";

const read = (relative) => {
  const file = pythonFile(relative);
  return file ? readFileSync(file, "utf8") : null;
};
const contract = read("src/agent_flywheel/contract.py");
const runner = read("src/agent_flywheel/runner.py");

/** The string literals of `NAME = (...)` / `NAME = frozenset({...})`, in order. */
function strings(source, name) {
  const found = new RegExp(`^${name} = (?:frozenset\\(\\{|\\()([^)}]*)[)}]`, "m").exec(source);
  assert.ok(found, `the Python SDK's contract.py no longer defines ${name} as a literal`);
  return [...found[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

/** The whole-number literal (or `2**a - b`) of `NAME = ...`. */
function integer(source, name) {
  const found = new RegExp(`^${name} = (\\d+)(?:\\*\\*(\\d+) - (\\d+))?$`, "m").exec(source);
  assert.ok(found, `the Python SDK no longer defines ${name} as a literal`);
  return found[2] === undefined
    ? Number(found[1]) : Number(found[1]) ** Number(found[2]) - Number(found[3]);
}

/** `{what: limit}` for every `_short_text(value, limit, what)` call. */
function textLimits(source) {
  const limits = {};
  for (const m of source.matchAll(/_short_text\(\s*[^,]+,\s*(\d+),\s*f?"([^"]+)"\)/g)) {
    limits[m[2]] = Number(m[1]);
  }
  return limits;
}

const refused = (fn) => {
  try { fn(); return false; } catch (err) { return err instanceof ContractError; }
};

describe("the evidence vocabulary is the Python SDK's", { skip: contract === null }, () => {
  it("has the same check statuses, in the same order", () => {
    assert.deepEqual([...CHECK_STATUSES], strings(contract, "CHECK_STATUSES"));
  });

  it("has the same things a check may establish", () => {
    assert.deepEqual([...CHECK_ESTABLISHES], strings(contract, "CHECK_ESTABLISHES"));
  });

  it("has the same ways an episode may end", () => {
    assert.deepEqual([...TERMINATION_CLASSES], strings(contract, "TERMINATION_CLASSES"));
  });

  it("may send exactly the keys the Python SDK may send", () => {
    assert.deepEqual([...WIRE_KEYS].sort(), strings(contract, "WIRE_KEYS").sort());
  });

  it("carries as many checks in one report", () => {
    assert.equal(MAX_REPORTED_CHECKS, integer(contract, "MAX_REPORTED_CHECKS"));
  });

  it("takes the same largest integer seed", () => {
    const largest = integer(contract, "MAX_SAFE_SEED");
    assert.equal(largest, Number.MAX_SAFE_INTEGER);
    assert.deepEqual(seedsToWire({ environment: largest }), { environment: largest });
    assert.ok(refused(() => seedsToWire({ environment: largest + 1 })));
  });

  it("holds each text to the Python SDK's limit, to the character", () => {
    const limits = textLimits(contract);
    // Every text the Python SDK bounds, and how this package is asked to
    // send one of that length. A new bounded text there fails here until it
    // has a row, instead of going unpinned.
    const senders = {
      "{where}.id": (s) => checksToWire([{ id: s, status: "measured" }]),
      "{where}.basis": (s) => checksToWire([{ id: "a", status: "measured", basis: s }]),
      "termination.detail": (s) => terminationToWire({ class: "completed", detail: s }),
      "seeds.{key}": (s) => seedsToWire({ sampling: s }),
    };
    assert.deepEqual(Object.keys(limits).sort(), Object.keys(senders).sort());
    for (const [what, send] of Object.entries(senders)) {
      const limit = limits[what];
      assert.ok(!refused(() => send("x".repeat(limit))), `${what} at ${limit} was refused`);
      assert.ok(refused(() => send("x".repeat(limit + 1))), `${what} over ${limit} was sent`);
      assert.ok(refused(() => send("")), `an empty ${what} was sent`);
    }
  });

  it("reads the agent's own grade from the file the Python runner reads", () => {
    const found = /^OUTCOME_FILENAME = "([^"]+)"$/m.exec(runner);
    assert.ok(found, "the Python runner no longer names its outcome file as a literal");
    assert.equal(OUTCOME_FILENAME, found[1]);
  });
});
