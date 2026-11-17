/**
 * The wire contract, and the distinctions that keep a report honest.
 *
 * The first test is the most important one in this package: it is the only
 * mechanism keeping the vendored schema from silently diverging from the
 * Python end. A comment saying "keep these in sync" is not a mechanism.
 */
import "./support/home.js";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { pythonFile } from "./support/python-sdk.js";
import {
  CONTRACT_VERSION, ContractError, RULEBOOK_RECEIPT_KEYS,
  RULEBOOK_RECEIPT_STATUSES, WIRE_KEYS, rolloutOutputToWire,
  rolloutRequestFromWire, rulebookRequestToWire, productionOutcome,
  turnFeedback, productionIdentifier, productionTurnIdentifier,
} from "../src/wire.js";

const schema = JSON.parse(
  readFileSync(new URL("../schema/flywheel-1.json", import.meta.url), "utf8"),
);

describe("the vendored schema IS the contract", () => {
  it("declares the same contract version this package sends", () => {
    assert.equal(schema["x-contract-version"], CONTRACT_VERSION);
  });

  it("agrees with the schema on every wire key", () => {
    // If Python adds a field and this list does not, a report silently drops
    // it; if this list adds one Python does not know, the server rejects the
    // whole report. Either way the failure is far from the edit that caused it.
    const fromSchema = Object.keys(schema.$defs.RolloutOutput.properties);
    assert.deepEqual([...WIRE_KEYS].sort(), fromSchema.sort());
  });

  it("agrees that final_text is the one required field", () => {
    assert.deepEqual(schema.$defs.RolloutOutput.required, ["final_text"]);
  });

  it("matches the Python authority for both production-turn definitions", () => {
    const sibling = pythonFile("schema/flywheel-1.json");
    assert.ok(schema.$defs.ProductionTurn);
    assert.ok(schema.$defs.ProductionTurnBatch);
    if (!sibling) return;

    const authoritative = JSON.parse(readFileSync(sibling, "utf8"));
    for (const name of [
      "ProductionTurn", "ProductionTurnBatch", "RulebookRequest",
      "RulebookReceipt",
    ]) {
      assert.deepEqual(schema.$defs[name], authoritative.$defs[name]);
    }
  });

  it("is the Python authority's copy BYTE FOR BYTE", () => {
    // The two SDKs ship in unison: one contract file, vendored twice. Equal
    // definitions in a different order or spelling are already two files a
    // reviewer has to diff by hand, so the bytes are what is held equal.
    const sibling = pythonFile("schema/flywheel-1.json");
    if (!sibling) return;
    assert.equal(
      readFileSync(new URL("../schema/flywheel-1.json", import.meta.url), "utf8"),
      readFileSync(sibling, "utf8"),
      "schema/flywheel-1.json differs from the Python SDK's copy",
    );
  });

  it("declares the rulebook shapes this package sends and reads", () => {
    const request = schema.$defs.RulebookRequest;
    assert.equal(request.additionalProperties, false);
    assert.deepEqual(request.required, ["rules"]);
    assert.deepEqual(request.properties.rules,
      { type: "array", items: { type: "string" } });
    assert.deepEqual(
      Object.keys(rulebookRequestToWire(["Confirm the order number first."])),
      Object.keys(request.properties),
    );
    const receipt = schema.$defs.RulebookReceipt;
    assert.equal(receipt.additionalProperties, false);
    assert.deepEqual([...RULEBOOK_RECEIPT_KEYS], receipt.required);
    assert.deepEqual([...RULEBOOK_RECEIPT_KEYS], Object.keys(receipt.properties));
    assert.deepEqual([...RULEBOOK_RECEIPT_STATUSES], receipt.properties.status.enum);
  });
});

describe("null is not an empty list", () => {
  it("omits tool_calls entirely when none were reported", () => {
    // `null` means "not reported"; `[]` means "I observed zero", which is a
    // positive assertion. An agent that reports nothing must not assert zero.
    const wire = rolloutOutputToWire({ finalText: "done" });
    assert.equal("tool_calls" in wire, false);
  });

  it("sends an EMPTY list when zero calls were genuinely observed", () => {
    const wire = rolloutOutputToWire({ finalText: "done", toolCalls: [] });
    assert.deepEqual(wire.tool_calls, []);
  });

  it("always sends the omitted count, even at zero", () => {
    // Non-zero forbids the training grade, so a reader must be able to tell
    // "none omitted" from "the field was missing".
    assert.equal(rolloutOutputToWire({ finalText: "x" }).tool_calls_omitted_count, 0);
  });
});

describe("model-call count is an attestation", () => {
  it("preserves an independently observed nonnegative integer", () => {
    assert.equal(
      rolloutOutputToWire({ finalText: "done", llmCallCount: 3 }).llm_call_count,
      3,
    );
  });

  it("refuses coercion, fractions, and negative counts", () => {
    for (const value of ["1", true, 1.5, -1, Number.NaN]) {
      assert.throws(
        () => rolloutOutputToWire({ finalText: "done", llmCallCount: value }),
        /llm_call_count must be a nonnegative integer or null/,
      );
    }
  });
});

describe("an unknown outcome asserts nothing", () => {
  it("scrubs status_code and body from an unknown call", () => {
    // Leaving either would let a reward function read success out of a field
    // that only describes the transport, for a call whose result we never saw.
    const wire = rolloutOutputToWire({
      finalText: "x",
      toolCalls: [{ name: "t", outcome: "unknown", status_code: 500, body: "boom" }],
    });
    assert.equal(wire.tool_calls[0].status_code, null);
    assert.equal("body" in wire.tool_calls[0], false);
  });

  it("leaves a known outcome's status_code alone", () => {
    const wire = rolloutOutputToWire({
      finalText: "x",
      toolCalls: [{ name: "t", outcome: "failed", status_code: 500 }],
    });
    assert.equal(wire.tool_calls[0].status_code, 500);
  });
});

describe("the closed key set", () => {
  it("emits ONLY contract keys, whatever the caller passes", () => {
    // The closedness is structural: unknown fields are never copied, so an
    // agent cannot assert a field it has no way to know. Asserting the
    // OUTPUT is the honest test -- asserting a throw would have tested a
    // guard that does not exist and cannot fire.
    const wire = rolloutOutputToWire({
      finalText: "x", nope: 1, rollout_id: "sneaky", environment: "prod",
    });
    for (const key of Object.keys(wire)) {
      assert.ok(WIRE_KEYS.includes(key), `emitted a non-contract key: ${key}`);
    }
    assert.equal("nope" in wire, false);
    assert.equal("rollout_id" in wire, false);
  });

  it("refuses a tool call carrying an environment", () => {
    // The environment is the control plane's fact about the rollout, not the
    // agent's to assert.
    assert.throws(
      () => rolloutOutputToWire({
        finalText: "x",
        toolCalls: [{ name: "t", outcome: "ok", environment: "prod" }],
      }),
      ContractError,
    );
  });

  it("requires final_text", () => {
    assert.throws(() => rolloutOutputToWire({}), ContractError);
    assert.throws(() => rolloutOutputToWire({ finalText: 42 }), ContractError);
  });
});

describe("reading a claimed rollout", () => {
  it("keeps the server's field names", () => {
    const r = rolloutRequestFromWire({
      rollout_id: "r1", turn_input: "do it", llm_url: "https://gw/v1",
      deadline_ts: 123.5, lease_token: "lt",
    });
    assert.equal(r.rolloutId, "r1");
    assert.equal(r.turnInput, "do it");
    assert.equal(r.llmUrl, "https://gw/v1");
    assert.equal(r.deadlineTs, 123.5);
    assert.equal(r.leaseToken, "lt");
  });

  it("refuses a payload with no rollout_id", () => {
    assert.throws(() => rolloutRequestFromWire({ turn_input: "x" }), ContractError);
  });

  it("keeps the granted lease clock and metadata for the worker", () => {
    const request = rolloutRequestFromWire({
      rollout_id: "r1",
      turn_input: "do it",
      deadline_ts: 999,
      lease_token: "lease-1",
      lease_expires_ts: 123.5,
      metadata: { suite: "held-out" },
    });
    assert.equal(request.leaseExpiresTs, 123.5);
    assert.deepEqual(request.metadata, { suite: "held-out" });
  });

  it("names the task the rollout was claimed for (Python: current_task_id)", () => {
    const named = rolloutRequestFromWire({
      rollout_id: "r1", metadata: { task_id: "banking_knowledge:task_017" },
    });
    assert.equal(named.taskId, "banking_knowledge:task_017");
    assert.equal(rolloutRequestFromWire({ rollout_id: "r1" }).taskId, null);
    assert.equal(
      rolloutRequestFromWire({ rollout_id: "r1", metadata: { task_id: "a\nb" } }).taskId,
      null,
    );
  });
});

describe("checks, termination and seeds", () => {
  it("reach the wire in the schema's words", async () => {
    const {
      CHECK_ESTABLISHES, CHECK_STATUSES, MAX_REPORTED_CHECKS, TERMINATION_CLASSES,
    } = await import("../src/wire.js");
    const wire = rolloutOutputToWire({
      finalText: "x",
      checks: [
        { id: "db_state", status: "measured", value: 1, required: true,
          establishes: "state_reached" },
        { id: "judge", status: "unavailable" },
      ],
      termination: { class: "turn_limit", detail: "40 turns" },
      seeds: { environment: 7, sampling: "s-3" },
    });
    assert.deepEqual(wire.checks, [
      { id: "db_state", status: "measured", value: 1, required: true,
        establishes: "state_reached" },
      { id: "judge", status: "unavailable" },
    ]);
    assert.deepEqual(wire.termination, { class: "turn_limit", detail: "40 turns" });
    assert.deepEqual(wire.seeds, { environment: 7, sampling: "s-3" });

    const defs = schema.$defs;
    assert.deepEqual(defs.ReportedCheck.properties.status.enum, [...CHECK_STATUSES]);
    assert.deepEqual(
      defs.ReportedCheck.properties.establishes.enum.filter((e) => e !== null),
      [...CHECK_ESTABLISHES],
    );
    assert.deepEqual(defs.ReportedTermination.properties.class.enum, [...TERMINATION_CLASSES]);
    assert.equal(defs.RolloutOutput.properties.checks.maxItems, MAX_REPORTED_CHECKS);
  });

  it("an agent that states none of them sends none of them", () => {
    const wire = rolloutOutputToWire({ finalText: "x", checks: [], seeds: {} });
    for (const key of ["checks", "termination", "seeds"]) {
      assert.equal(key in wire, false);
    }
  });

  for (const [output, named] of [
    [{ checks: [{ id: "a", status: "passed" }] }, /checks\[0\]\.status/],
    [{ checks: [{ id: "", status: "measured" }] }, /checks\[0\]\.id/],
    [{ checks: [{ id: "a", status: "error", value: 0 }] }, /only a measured check has a value/],
    [{ checks: [{ id: "a", status: "measured", value: true }] }, /checks\[0\]\.value/],
    [{ checks: [{ id: "a", status: "measured", value: NaN }] }, /checks\[0\]\.value/],
    [{ checks: [{ id: "a", status: "measured", establishes: "won" }] }, /checks\[0\]\.establishes/],
    [{ checks: [{ id: "a", status: "measured", source: "human_label" }] }, /unknown key/],
    [{ termination: { class: "gave_up" } }, /termination\.class/],
    [{ termination: { class: "time_limit", corroborated_by: "mission_control_gateway" } }, /unknown key/],
    [{ termination: { class: "time_limit", attributed_to: "platform" } }, /unknown key/],
    [{ seeds: { environment: 1.5 } }, /seeds\.environment/],
    [{ seeds: { sampling: true } }, /seeds\.sampling/],
    [{ seeds: { environment: 2 ** 53 } }, /seeds\.environment/],
    [{ seeds: { environment: NaN } }, /seeds\.environment/],
    [{ seeds: { sampling: "s".repeat(129) } }, /seeds\.sampling/],
    [{ seeds: { sampling: "" } }, /seeds\.sampling/],
  ]) {
    it(`refuses ${JSON.stringify(output).slice(0, 70)} by name`, () => {
      assert.throws(
        () => rolloutOutputToWire({ finalText: "x", ...output }),
        (err) => err instanceof ContractError && named.test(err.message),
      );
    });
  }

  const rows = (n) => Array.from({ length: n }, (_, i) => (
    { id: String(i), status: "measured", value: i }));

  it("keeps the first checks a report carries and says how many it left", async () => {
    // One check too many used to refuse the list whole, so the episode lost
    // every check it ran. The first MAX_REPORTED_CHECKS are sent and the
    // report states the rest as `checks_dropped`, the field the stored
    // episode keeps. Mirrors `test_contract.py`.
    const { MAX_REPORTED_CHECKS } = await import("../src/wire.js");
    const checks = rows(MAX_REPORTED_CHECKS + 3);
    const wire = rolloutOutputToWire({ finalText: "x", checks });
    assert.deepEqual(wire.checks.map((r) => r.id),
      checks.slice(0, MAX_REPORTED_CHECKS).map((r) => r.id));
    assert.equal(wire.checks_dropped, 3);
    // A count the output already carries is added to, never replaced.
    assert.equal(
      rolloutOutputToWire({ finalText: "x", checks, checksDropped: 4 }).checks_dropped, 7);
    const declared = schema.$defs.RolloutOutput.properties.checks_dropped;
    assert.deepEqual([declared.type, declared.minimum], ["integer", 1]);
  });

  for (const dropped of [0, -1, true, "3", null, 1.5]) {
    it(`a report with nothing dropped does not say so (${JSON.stringify(dropped)})`, () => {
      const wire = rolloutOutputToWire({
        finalText: "x", checks: [{ id: "a", status: "measured" }],
        checksDropped: dropped,
      });
      assert.equal("checks_dropped" in wire, false);
    });
  }

  it("does not read a row past the limit", async () => {
    const { MAX_REPORTED_CHECKS, checksOverLimit, checksToWire } =
      await import("../src/wire.js");
    const checks = [...rows(MAX_REPORTED_CHECKS), { id: "", status: "?" }];
    assert.equal(checksToWire(checks).length, MAX_REPORTED_CHECKS);
    assert.equal(checksOverLimit(checks), 1);
    assert.equal(checksOverLimit(null), 0);
    assert.equal(checksOverLimit(checks.slice(0, 5)), 0);
  });

  it("sends the largest integer seed a JSON number carries exactly", async () => {
    const { seedsToWire } = await import("../src/wire.js");
    assert.deepEqual(
      seedsToWire({ environment: Number.MAX_SAFE_INTEGER, sampling: -3 }),
      { environment: Number.MAX_SAFE_INTEGER, sampling: -3 });
  });
});

describe("text the control plane's parser takes", () => {
  // A LONE SURROGATE is escaped by JSON.stringify and refused by the control
  // plane's parser: a 422 for the batch, then a record dropped by the split.
  const lone = "case-\ud800";
  const emoji = "case-\u{1F600}";
  const at = "2026-11-10T09:00:00Z";
  const outcome = { outcome_id: "o-1", outcome: "resolved", episode_id: "e-1", occurred_at: at };
  const feedback = { feedback_id: "f-1", signal: "accepted", episode_id: "e-1", turn_index: 0, occurred_at: at };

  it("refuses an id with a lone surrogate, and keeps an emoji", () => {
    for (const check of [productionIdentifier, productionTurnIdentifier]) {
      assert.equal(check(lone), null);
      assert.equal(check(emoji), emoji);
    }
    for (const field of ["outcome_id", "turn_id", "conversation_id", "episode_id"]) {
      assert.throws(() => productionOutcome({ ...outcome, [field]: lone }), ContractError, field);
      assert.equal(productionOutcome({ ...outcome, [field]: emoji })[field], emoji);
    }
    for (const field of ["feedback_id", "episode_id"]) {
      assert.throws(() => turnFeedback({ ...feedback, [field]: lone }), ContractError, field);
    }
  });

  it("refuses a note with a lone surrogate", () => {
    assert.throws(() => productionOutcome({ ...outcome, note: `x${lone}` }),
      /note must be well-formed Unicode text/);
    assert.equal(productionOutcome({ ...outcome, note: emoji }).note, emoji);
  });
});
