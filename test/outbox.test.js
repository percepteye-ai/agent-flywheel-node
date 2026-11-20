/**
 * AN OUTCOME IS NEVER SILENTLY DROPPED.
 *
 * The incident these assertions exist for: every rollout on one OPSD queue
 * came back `abandoned` / `deadline_exceeded` with zero inference calls. Only
 * the control plane's reaper writes `abandoned`, and its result route sets
 * `reported` unconditionally for an ordinary rollout -- so the SDK's report
 * never landed, and NOTHING said so. Not the row, not the disk, not the log.
 * Which failure fired was never determined, and nothing here depends on
 * knowing: the identical silence was the defect.
 *
 * Each test below is written against the OBSERVABLE consequence -- a file that
 * exists, a second attempt that happens, a name an operator can find -- rather
 * than against an internal event or a log line. A log line was what the Python
 * SDK already had when the queue went dark.
 */
import "./support/home.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync,
  utimesSync, writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LeaseLost, TransportError } from "../src/errors.js";
import {
  CLAIM_STALE_MS, MAX_AGE_MS, OUTBOX_SCHEMA, createOutbox, outboxDir, pathSegment,
  spoolName,
} from "../src/outbox.js";
import {
  ContractError, MAX_REPORTED_CHECKS, rolloutOutputToWire,
} from "../src/wire.js";

const tmp = () => mkdtempSync(join(tmpdir(), "percepteye-outbox-"));

const ROLLOUT = { rolloutId: "r-1", leaseToken: "lease-abc" };
const OUTPUT = { finalText: "the answer", success: true };

/** Every `*.json` still in the retry set, and every retired file beside it. */
const listing = (dir) => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};
const retryable = (dir) => listing(dir).filter((n) => n.endsWith(".json"));

const http = (status) => new TransportError(
  `POST /rollouts/r-1/result -> HTTP ${status}: nope`, { statusCode: status },
);

describe("spool before send", () => {
  it("writes the outcome to disk BEFORE the first network call", async () => {
    const dir = tmp();
    let onDiskWhenSent = null;
    const outbox = createOutbox({
      dir,
      send: async () => {
        // THE WHOLE PROPERTY, observed at the only moment it can be: a process
        // killed here must still deliver, which is only true if the file is
        // already there.
        onDiskWhenSent = retryable(dir);
        throw new Error("killed mid-POST");
      },
    });
    await outbox.deliver(ROLLOUT, OUTPUT);
    assert.deepEqual(onDiskWhenSent, [spoolName("r-1")],
      "the result was not durable at the moment the POST was made");
  });

  it("removes the copy once the control plane has it", async () => {
    const dir = tmp();
    const outbox = createOutbox({ dir, send: async () => ({ ok: true }) });
    assert.equal(await outbox.deliver(ROLLOUT, OUTPUT), true);
    assert.deepEqual(listing(dir), [],
      "a delivered result must not be redelivered forever");
  });

  it("holds a transiently refused result and says where", async () => {
    const dir = tmp();
    const warns = [];
    const outbox = createOutbox({
      dir, logger: { warn: (m) => warns.push(String(m)) },
      send: async () => { throw http(503); },
    });
    assert.equal(await outbox.deliver(ROLLOUT, OUTPUT), false);
    assert.deepEqual(retryable(dir), [spoolName("r-1")]);
    const path = join(dir, spoolName("r-1"));
    assert.ok(warns.some((w) => w.includes(path)),
      `no warning named the held file. Got: ${warns.join(" | ")}`);
    const record = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(record.schema, OUTBOX_SCHEMA);
    assert.equal(record.rollout_id, "r-1");
    assert.equal(record.attempts, 1);
    assert.match(record.last_error, /503/);
    assert.deepEqual(record.output, OUTPUT);
  });
});

describe("restart recovery", () => {
  it("delivers a result THIS process never produced", async () => {
    // The producing process is gone. A second one over the same directory is
    // the only thing that can still deliver, and it has no lease token.
    const dir = tmp();
    const sent = [];
    const first = createOutbox({ dir, send: async () => { throw http(503); } });
    await first.deliver(ROLLOUT, OUTPUT);

    const second = createOutbox({
      dir, send: async (rollout, output) => { sent.push([rollout, output]); },
    });
    assert.equal(await second.drain(), 1,
      "a result the producing process could not deliver was left on disk forever");
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0].rolloutId, "r-1");
    assert.equal(sent[0][0].leaseToken, null,
      "a lease that outlived its process is already reaped; claiming one is a lie");
    assert.deepEqual(sent[0][1], OUTPUT);
    assert.deepEqual(listing(dir), []);
  });

  it("carries the attempt count across processes", async () => {
    const dir = tmp();
    const first = createOutbox({ dir, send: async () => { throw http(503); } });
    await first.deliver(ROLLOUT, OUTPUT);
    const second = createOutbox({ dir, send: async () => { throw http(503); } });
    await second.drain();
    const record = JSON.parse(readFileSync(join(dir, spoolName("r-1")), "utf8"));
    assert.equal(record.attempts, 2,
      "the second process did not pick the held result up at all");
  });
});

describe("no bearer credential on disk", () => {
  it("never writes the lease token into the spooled record", async () => {
    // The outbox sits under the same home the customer's own agent can read --
    // it runs as this uid, so no file mode fences it out.
    const dir = tmp();
    const outbox = createOutbox({ dir, send: async () => { throw http(503); } });
    await outbox.deliver(ROLLOUT, OUTPUT);
    const raw = readFileSync(join(dir, spoolName("r-1")), "utf8");
    assert.equal(raw.includes("lease-abc"), false,
      `the lease token reached disk: ${raw}`);
  });

  it("still uses the token for a redelivery inside this process", async () => {
    // Keeping it in memory must not cost the one redelivery that could ever
    // have used it.
    const dir = tmp();
    const seen = [];
    let fail = true;
    const outbox = createOutbox({
      dir,
      send: async (rollout) => {
        seen.push(rollout.leaseToken);
        if (fail) throw http(503);
      },
    });
    await outbox.deliver(ROLLOUT, OUTPUT);
    fail = false;
    await outbox.drain();
    assert.deepEqual(seen, ["lease-abc", "lease-abc"]);
  });

  it("drops a token left on disk by an older SDK rather than re-reading it", async () => {
    const dir = tmp();
    const outbox = createOutbox({ dir, send: async () => { throw http(503); } });
    await outbox.deliver(ROLLOUT, OUTPUT);
    const path = join(dir, spoolName("r-1"));
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.lease_token = "a-token-from-an-older-sdk";
    writeFileSync(path, JSON.stringify(record), "utf8");

    const next = createOutbox({ dir, send: async () => { throw http(503); } });
    await next.drain();
    assert.equal(readFileSync(path, "utf8").includes("a-token-from-an-older-sdk"),
      false, "an old credential was read back in and written out again");
  });
});

describe("a permanent refusal is RETIRED, never destroyed", () => {
  for (const status of [400, 404, 409, 422]) {
    it(`keeps the work after HTTP ${status} and names why`, async () => {
      const dir = tmp();
      const warns = [];
      const outbox = createOutbox({
        dir, logger: { warn: (m) => warns.push(String(m)) },
        send: async () => { throw http(status); },
      });
      assert.equal(await outbox.deliver(ROLLOUT, OUTPUT), false);
      const kept = `${spoolName("r-1")}.refused-${status}`;
      assert.deepEqual(retryable(dir), [],
        "a refusal redelivery cannot fix must leave the retry set");
      assert.ok(listing(dir).includes(kept), `expected ${kept}, got ${listing(dir)}`);
      const record = JSON.parse(readFileSync(join(dir, kept), "utf8"));
      assert.deepEqual(record.output, OUTPUT,
        "the agent's work product must survive the refusal");
      assert.match(record.last_error, new RegExp(String(status)));
      assert.ok(warns.some((w) => w.includes(join(dir, kept))),
        `no warning named where the result was kept. Got: ${warns.join(" | ")}`);
    });
  }

  it("retires a lost lease WITHOUT deleting the result", async () => {
    // 410 is the one status that guarantees the row is unrecoverable -- which
    // makes it exactly the case where the local copy is the last one there is.
    const dir = tmp();
    const outbox = createOutbox({
      dir, send: async () => { throw new LeaseLost("lease lost"); },
    });
    assert.equal(await outbox.deliver(ROLLOUT, OUTPUT), false);
    const kept = `${spoolName("r-1")}.refused-lease-lost`;
    assert.ok(listing(dir).includes(kept), `got ${listing(dir)}`);
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, kept), "utf8")).output, OUTPUT);
  });

  it("KEEPS RETRYING a 401, because a reissued key delivers it", async () => {
    const dir = tmp();
    const outbox = createOutbox({ dir, send: async () => { throw http(401); } });
    await outbox.deliver(ROLLOUT, OUTPUT);
    assert.deepEqual(retryable(dir), [spoolName("r-1")],
      "an expired credential is fixable; retiring it throws the work away");
  });

  it("treats a failure with no status as transient", async () => {
    // A network blip that retired a rollout's only copy would be a worse
    // failure than the one the split exists to handle.
    const dir = tmp();
    const outbox = createOutbox({
      dir, send: async () => { throw new TransportError("connect ECONNREFUSED"); },
    });
    await outbox.deliver(ROLLOUT, OUTPUT);
    assert.deepEqual(retryable(dir), [spoolName("r-1")]);
  });
});

describe("retired names are uniquified", () => {
  it("does not clobber an earlier retired record for the same rollout", async () => {
    // A retried task, or a restart that re-spools the same id. A plain rename
    // would destroy the first retired record -- the same silent loss this
    // module exists to end, one layer down.
    const dir = tmp();
    const outbox = createOutbox({ dir, send: async () => { throw http(422); } });
    await outbox.deliver(ROLLOUT, { finalText: "first attempt" });
    await outbox.deliver(ROLLOUT, { finalText: "second attempt" });
    const retired = listing(dir).filter((n) => n.includes("refused-422"));
    assert.equal(retired.length, 2, `expected two kept copies, got ${listing(dir)}`);
    const texts = retired
      .map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")).output.finalText)
      .sort();
    assert.deepEqual(texts, ["first attempt", "second attempt"]);
  });
});

describe("the delivery mechanism cannot become the outage", () => {
  it("quarantines a poisoned file and still delivers the ones behind it", async () => {
    const dir = tmp();
    const outbox = createOutbox({ dir, send: async () => { throw http(503); } });
    await outbox.deliver({ rolloutId: "r-zzz", leaseToken: "t" }, OUTPUT);
    // Sorts BEFORE r-zzz, so a drain that dies on it never reaches the good one.
    writeFileSync(join(dir, "r-aaa.json"), "{ not json at all", "utf8");

    const sent = [];
    const next = createOutbox({
      dir, send: async (rollout) => { sent.push(rollout.rolloutId); },
    });
    assert.equal(await next.drain(), 1,
      "one unreadable file stopped the results behind it");
    assert.deepEqual(sent, ["r-zzz"],
      "one unreadable file stopped the results behind it");
    assert.ok(listing(dir).includes("r-aaa.json.unreadable"),
      `the poisoned file was not quarantined by name: ${listing(dir)}`);
  });

  it("quarantines a record whose envelope no outbox writes", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "r-b.json"),
      JSON.stringify({ schema: "something/else", rollout_id: "r-b" }), "utf8");
    const next = createOutbox({ dir, send: async () => {} });
    assert.equal(await next.drain(), 0);
    assert.deepEqual(retryable(dir), [],
      "a record nobody can send must leave the retry set, not be retried forever");
    assert.ok(listing(dir).includes("r-b.json.unreadable"));
  });

  it("leaves a record a NEWER SDK spooled exactly where it is (ND-H16)", async () => {
    // OUTBOX_SCHEMA's promise: a future SDK's file is left alone rather than
    // half-read. It was renamed out as .unreadable, so the SDK that wrote it
    // -- after a downgrade and upgrade -- never found its own result again.
    // This used to be pinned the other way round.
    const dir = tmp();
    const body = JSON.stringify({ schema: "percepteye.outbox/v99", rollout_id: "r-b" });
    writeFileSync(join(dir, "r-b.json"), body, "utf8");
    const sent = [];
    const warns = [];
    const next = createOutbox({
      dir, send: async (r) => { sent.push(r); }, logger: { warn: (m) => warns.push(m) },
    });
    assert.equal(await next.drain(), 0);
    assert.equal(await next.drain(), 0);
    assert.deepEqual(sent, []);
    assert.deepEqual(listing(dir), ["r-b.json"]);
    assert.equal(readFileSync(join(dir, "r-b.json"), "utf8"), body);
    assert.equal(warns.filter((w) => w.includes("newer SDK")).length, 1,
      "named once, not on every pass");
  });

  it("stops retrying a result nobody has been able to deliver for a week", async () => {
    const dir = tmp();
    let clock = 1_000_000;
    const outbox = createOutbox({
      dir, now: () => clock, send: async () => { throw http(503); },
    });
    await outbox.deliver(ROLLOUT, OUTPUT);
    clock += MAX_AGE_MS + 1;
    assert.equal(await outbox.drain(), 0);
    assert.deepEqual(retryable(dir), [],
      "an unbounded retry set makes every claim drag a longer drain behind it");
    const kept = `${spoolName("r-1")}.stale`;
    assert.ok(listing(dir).includes(kept), `got ${listing(dir)}`);
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, kept), "utf8")).output, OUTPUT);
  });

  it("does not let a drain resend a result this process is still delivering", async () => {
    // The file is on disk for the whole of the POST -- that is the point of
    // spooling first -- so a concurrent drain can see it and send it again
    // underneath its owner.
    const dir = tmp();
    const sent = [];
    const outbox = createOutbox({
      dir,
      send: async (rollout) => {
        sent.push(rollout.rolloutId);
        await new Promise((resolve) => { setTimeout(resolve, 30); });
      },
    });
    const delivering = outbox.deliver(ROLLOUT, OUTPUT);
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    assert.equal(await outbox.drain(), 0,
      "the drain resent a result its owner was still posting");
    await delivering;
    assert.deepEqual(sent, ["r-1"], "the same result was posted twice");
  });

  it("survives a logger that throws", async () => {
    const dir = tmp();
    const outbox = createOutbox({
      dir,
      logger: { warn: () => { throw new Error("a host logger that raises"); } },
      send: async () => { throw http(503); },
    });
    assert.equal(await outbox.deliver(ROLLOUT, OUTPUT), false);
    assert.deepEqual(retryable(dir), [spoolName("r-1")],
      "telemetry must never be able to lose the outcome it is describing");
  });
});

describe("an outcome the wire cannot carry", () => {
  it("reports what CAN be carried and names what went with it", async () => {
    // One unrepresentable field used to take every other field down silently:
    // a grader reading the row saw an empty rollout and no reason.
    const dir = tmp();
    const sent = [];
    const outbox = createOutbox({
      dir, send: async (_r, output) => { sent.push(output); },
    });
    const ok = await outbox.deliver(ROLLOUT, {
      finalText: "the real answer",
      success: true,
      // `environment` is refused outright by the contract: it is the control
      // plane's fact about the rollout, not the agent's to assert.
      toolCalls: [{ name: "exec", outcome: "ok", environment: "prod" }],
      checks: [{ id: "balance_restored", status: "measured", value: 1 }],
      termination: { class: "completed" },
      seeds: { environment: 7 },
    });
    assert.equal(ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].finalText, "the real answer",
      "the answer survives even when a sibling field does not");
    assert.ok(sent[0].exclusion,
      "an outcome the wire cannot carry was sent unchanged, so nothing landed at all");
    assert.equal(sent[0].exclusion.reason, "flywheel_crash");
    assert.match(sent[0].exclusion.detail, /environment/);
    assert.match(sent[0].exclusion.detail, /dropped by the salvage:.*toolCalls/);
    for (const part of ["checks", "termination", "seeds"]) {
      assert.match(sent[0].exclusion.detail,
        new RegExp(`dropped by the salvage:.*${part}`), part);
    }
  });

  it("drops one malformed evidence part and keeps the outcome", async () => {
    // The checks, the termination and the seeds are statements ABOUT an
    // outcome. A check row the wire refuses used to send the whole result
    // down the salvage: reward and tool calls dropped, the episode a crash.
    const dir = tmp();
    const sent = [];
    const warns = [];
    const outbox = createOutbox({
      dir, logger: { warn: (m) => warns.push(String(m)) },
      send: async (_r, output) => { sent.push(output); },
    });
    const output = {
      finalText: "the real answer", success: true, reward: 0.75,
      toolCalls: [{ name: "exec", outcome: "ok" }],
      checks: [{ id: "balance_restored", status: "measured", value: NaN }],
      termination: { class: "completed" },
      seeds: { environment: 7 },
    };
    assert.equal(await outbox.deliver(ROLLOUT, output), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].exclusion, undefined);
    assert.equal(sent[0].reward, 0.75);
    assert.equal(sent[0].toolCalls.length, 1);
    assert.equal(sent[0].checks, undefined);
    assert.deepEqual(sent[0].termination, { class: "completed" });
    assert.deepEqual(sent[0].seeds, { environment: 7 });
    assert.ok(warns.some((w) => w.includes("checks")), warns.join(" | "));
    assert.ok(output.checks, "the caller's object was mutated");
    // ...AND THE STORED EPISODE SAYS SO. A warning reaches the process that
    // ran the agent and nobody who reads the episode: without the count, an
    // episode whose checks could not be sent reads as one that ran none.
    assert.equal(sent[0].checksDropped, 1);
    assert.equal(rolloutOutputToWire(sent[0]).checks_dropped, 1);
    assert.ok(warns.some((w) => w.includes("says 1 checks are missing")), warns.join(" | "));
  });

  it("claims no missing checks when another evidence part is unsendable", async () => {
    const sent = [];
    const outbox = createOutbox({
      dir: tmp(), logger: { warn() {} },
      send: async (_r, output) => { sent.push(output); },
    });
    await outbox.deliver(ROLLOUT, {
      finalText: "done", checks: [{ id: "a", status: "measured" }],
      termination: { class: "gave_up" },
    });
    const wire = rolloutOutputToWire(sent[0]);
    assert.deepEqual(wire.checks, [{ id: "a", status: "measured" }]);
    assert.equal("termination" in wire, false);
    assert.equal("checks_dropped" in wire, false);
  });

  it("says out loud that a report carries only the first checks", async () => {
    // Over the limit is not a refusal: the first rows go, the count goes
    // with them, and whoever stated too many is told once per report.
    const sent = [];
    const warns = [];
    const outbox = createOutbox({
      dir: tmp(), logger: { warn: (m) => warns.push(String(m)) },
      send: async (_r, output) => { sent.push(output); },
    });
    const checks = Array.from({ length: MAX_REPORTED_CHECKS + 2 },
      (_, i) => ({ id: String(i), status: "measured" }));
    assert.equal(await outbox.deliver(ROLLOUT, { finalText: "done", reward: 1, checks }), true);
    const wire = rolloutOutputToWire(sent[0]);
    assert.equal(wire.checks.length, MAX_REPORTED_CHECKS);
    assert.equal(wire.checks_dropped, 2);
    assert.equal(wire.reward, 1);
    assert.equal("exclusion" in wire, false);
    assert.equal(warns.filter((w) => w.includes("says 2 were not")).length, 1,
      warns.join(" | "));
  });

  it("the salvage says the checks it could not carry", async () => {
    // When something besides the evidence is unsendable the report is
    // rebuilt from the two always-sendable fields, and it carries no check.
    const sent = [];
    const outbox = createOutbox({
      dir: tmp(), logger: { warn() {} },
      send: async (_r, output) => { sent.push(output); },
    });
    await outbox.deliver(ROLLOUT, {
      finalText: "done", llmCallCount: -1,
      checks: [{ id: "a", status: "measured" }, { id: "b", status: "error" }],
    });
    const wire = rolloutOutputToWire(sent[0]);
    assert.equal(wire.exclusion.reason, "flywheel_crash");
    assert.equal("checks" in wire, false);
    assert.equal(wire.checks_dropped, 2);
  });

  it("retires a contract refusal rather than retrying the same bytes forever", async () => {
    const dir = tmp();
    const outbox = createOutbox({
      dir, send: async () => { throw new ContractError("report is not an object"); },
    });
    assert.equal(await outbox.deliver(ROLLOUT, OUTPUT), false);
    assert.deepEqual(retryable(dir), []);
    assert.ok(listing(dir).includes(`${spoolName("r-1")}.refused-contract`),
      `got ${listing(dir)}`);
  });
});

describe("the outbox directory", () => {
  it("is keyed by agent, so two installs cannot replay each other", () => {
    const env = { PERCEPTEYE_HOME: "/tmp/home" };
    assert.notEqual(outboxDir("alpha", env), outboxDir("beta", env));
    assert.equal(outboxDir("alpha", env), "/tmp/home/outbox/alpha");
    // `agentId` allows dots (config.js), so a filter that stripped them would
    // put two agents in one outbox -- which is what keying by agent is for.
    assert.notEqual(outboxDir("a.b", env), outboxDir("ab", env));
  });

  it("gives two rollout ids two filenames, never one", () => {
    // A "clean it up" filter would map `a.b` and `ab` onto one path, and the
    // second result would silently overwrite the first.
    assert.notEqual(spoolName("a.b"), spoolName("ab"));
    assert.notEqual(spoolName("a/b"), spoolName("a-b"));
    assert.equal(spoolName("a/b").includes("/"), false,
      "a rollout id must never be able to escape the outbox directory");
    assert.notEqual(spoolName(".."), "...json");
    assert.equal(spoolName("..").includes(".."), false,
      "a dot segment is a directory, not a filename");
  });

  it("holds a result whose rollout id is not a tidy filename", async () => {
    // Rollout ids are opaque and control-plane-authored. One that cannot be a
    // filename must not mean an outcome that cannot be held.
    const dir = tmp();
    const id = "org/7:rollout #1";
    const outbox = createOutbox({ dir, send: async () => { throw http(503); } });
    assert.equal(await outbox.deliver({ rolloutId: id, leaseToken: "t" }, OUTPUT),
      false);
    assert.deepEqual(retryable(dir), [spoolName(id)]);
    const sent = [];
    const next = createOutbox({
      dir, send: async (rollout) => { sent.push(rollout.rolloutId); },
    });
    assert.equal(await next.drain(), 1);
    assert.deepEqual(sent, [id], "the exact id must survive the round trip");
  });
});

describe("deliver never throws into the host hook", () => {
  it("names the rollout when its result cannot even be prepared", async () => {
    // THE CONTRACT deliver() documents about itself: "NEVER THROWS, and its
    // caller depends on that". onAgentEnd's own catch was removed when
    // delivery moved into the outbox, so an exception escaping here leaves the
    // host hook -- which is precisely how an outcome was lost before the
    // outbox existed. Building the record is the part that touches
    // caller-supplied data, so it is the part that can throw.
    const dir = tmp();
    const warns = [];
    const outbox = createOutbox({
      dir, logger: { warn: (m) => warns.push(String(m)) },
      send: async () => ({ ok: true }),
    });
    const hostile = {
      ...OUTPUT,
      get finalText() { throw new Error("output getter exploded"); },
    };

    let landed;
    await assert.doesNotReject(
      async () => { landed = await outbox.deliver(ROLLOUT, hostile); },
      "deliver threw into the host hook instead of naming the failure",
    );
    assert.equal(landed, false, "an undeliverable result must not report success");
    assert.ok(
      warns.some((w) => w.includes("r-1") && w.includes("neither spooled nor reported")),
      `the failure did not name the rollout: ${JSON.stringify(warns)}`,
    );
  });
});

/** A record as this SDK spools it, for a file "another process" left. */
const spooled = (rolloutId, extra = {}) => JSON.stringify({
  schema: OUTBOX_SCHEMA, rollout_id: rolloutId, first_seen_ts: Date.now(),
  attempts: 0, last_error: null, output: { finalText: rolloutId }, ...extra,
});
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

describe("one sender per file (ND-C8)", () => {
  it("makes a second delivery of an id wait for the first, so neither loses the other", async () => {
    // Without it the second delivery wrote the file, failed and held it --
    // and the first one's success then deleted that file: a held result gone.
    const dir = tmp();
    let active = 0;
    let most = 0;
    const sent = [];
    const outbox = createOutbox({
      dir,
      send: async (_r, output) => {
        active += 1;
        most = Math.max(most, active);
        sent.push(output.finalText);
        await sleep(output.finalText === "first" ? 30 : 0);
        active -= 1;
        if (output.finalText === "second") throw http(503);
      },
    });
    const one = outbox.deliver(ROLLOUT, { finalText: "first" });
    await sleep(5);
    const two = outbox.deliver(ROLLOUT, { finalText: "second" });
    assert.deepEqual([await one, await two], [true, false]);
    assert.equal(most, 1, "two sends of one id ran at once");
    assert.deepEqual(sent, ["first", "second"]);
    assert.deepEqual(retryable(dir), [spoolName("r-1")],
      "the held second result was deleted by the first one's success");
    assert.equal(
      JSON.parse(readFileSync(join(dir, spoolName("r-1")), "utf8")).output.finalText, "second");
  });

  it("writes through a temp file of its own, not a shared fixed name", async () => {
    // `${path}.tmp` was every writer's temp file; a stray one (here a
    // directory in its place) stopped the result being spooled at all.
    const dir = tmp();
    mkdirSync(join(dir, `${spoolName("r-1")}.tmp`), { recursive: true });
    const outbox = createOutbox({ dir, send: async () => { throw http(503); } });
    await outbox.deliver(ROLLOUT, OUTPUT);
    assert.ok(retryable(dir).includes(spoolName("r-1")), `not spooled: ${listing(dir)}`);
    assert.deepEqual(listing(dir).filter((n) => /\.\d+\.[0-9a-f]+\.tmp$/.test(n)), [],
      "a temp file was left behind");
  });

  it("leaves a file another process is sending to that process", async () => {
    const dir = tmp();
    writeFileSync(join(dir, spoolName("r-9")), spooled("r-9"));
    writeFileSync(join(dir, `${spoolName("r-9")}.claim`), "4242.abc");
    const sent = [];
    const outbox = createOutbox({ dir, send: async (r) => { sent.push(r.rolloutId); } });
    assert.equal(await outbox.drain(), 0);
    assert.deepEqual(sent, [], "a result another process holds was sent a second time");
    assert.ok(retryable(dir).includes(spoolName("r-9")));
  });

  it("takes over a claim left by a process that died holding it", async () => {
    const dir = tmp();
    writeFileSync(join(dir, spoolName("r-9")), spooled("r-9"));
    const claim = join(dir, `${spoolName("r-9")}.claim`);
    writeFileSync(claim, "4242.abc");
    const old = (Date.now() - CLAIM_STALE_MS - 60_000) / 1000;
    utimesSync(claim, old, old);
    const sent = [];
    const outbox = createOutbox({ dir, send: async (r) => { sent.push(r.rolloutId); } });
    assert.equal(await outbox.drain(), 1);
    assert.deepEqual(sent, ["r-9"]);
    assert.deepEqual(listing(dir), [], "a claim or the record was left behind");
  });

  it("spools beside a file another process is sending, never over it", async () => {
    const dir = tmp();
    writeFileSync(join(dir, spoolName("r-1")), spooled("r-1"));
    writeFileSync(join(dir, `${spoolName("r-1")}.claim`), "4242.abc");
    const outbox = createOutbox({ dir, send: async () => { throw http(503); } });
    assert.equal(await outbox.deliver(ROLLOUT, { finalText: "mine" }), false);
    const texts = retryable(dir)
      .map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")).output.finalText).sort();
    assert.deepEqual(texts, ["mine", "r-1"], "one process's result overwrote the other's");
  });

  it("sends each held result once when several processes drain one outbox", async () => {
    const dir = tmp();
    const ids = Array.from({ length: 12 }, (_, i) => `r-${String(i).padStart(2, "0")}`);
    for (const id of ids) writeFileSync(join(dir, spoolName(id)), spooled(id));
    const log = join(tmp(), "sent.log");
    const module = new URL("../src/outbox.js", import.meta.url).href;
    const script = `
      import { appendFileSync } from "node:fs";
      const { createOutbox } = await import(${JSON.stringify(module)});
      const outbox = createOutbox({ dir: ${JSON.stringify(dir)}, send: async (r) => {
        appendFileSync(${JSON.stringify(log)}, r.rolloutId + "\\n");
        await new Promise((ok) => setTimeout(ok, 5));
      } });
      await outbox.drain();`;
    await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script],
        { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => { err += d; });
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err))));
    })));
    const sent = readFileSync(log, "utf8").trim().split("\n").sort();
    assert.deepEqual(sent, ids, "a held result was sent more than once, or not at all");
    assert.deepEqual(listing(dir), []);
  });
});

describe("a drain is bounded (ND-H16)", () => {
  it("stops the pass at the first outage instead of failing every file", async () => {
    const dir = tmp();
    for (const id of ["r-a", "r-b", "r-c"]) writeFileSync(join(dir, spoolName(id)), spooled(id));
    let calls = 0;
    const outbox = createOutbox({ dir, send: async () => { calls += 1; throw http(503); } });
    assert.equal(await outbox.drain(), 0);
    assert.equal(calls, 1, "every held result was tried against a control plane that is down");
    assert.equal(retryable(dir).length, 3);
    calls = 0;
    const offline = createOutbox({
      dir, send: async () => { calls += 1; throw new TransportError("connect ECONNREFUSED"); },
    });
    await offline.drain();
    assert.equal(calls, 1);
  });

  it("carries on past a refusal of one result", async () => {
    const dir = tmp();
    for (const id of ["r-a", "r-b"]) writeFileSync(join(dir, spoolName(id)), spooled(id));
    const sent = [];
    const outbox = createOutbox({
      dir, send: async (r) => { sent.push(r.rolloutId); if (r.rolloutId === "r-a") throw http(422); },
    });
    assert.equal(await outbox.drain(), 1);
    assert.deepEqual(sent, ["r-a", "r-b"]);
  });

  it("retires a record whose first_seen_ts is not a number", async () => {
    const dir = tmp();
    writeFileSync(join(dir, spoolName("r-n")), spooled("r-n", { first_seen_ts: "yesterday" }));
    const sent = [];
    const outbox = createOutbox({ dir, send: async (r) => { sent.push(r.rolloutId); } });
    await outbox.drain();
    assert.deepEqual(sent, []);
    assert.ok(listing(dir).includes(`${spoolName("r-n")}.stale`), `got ${listing(dir)}`);
  });

  it("skips a directory named *.json without leaving a file per pass", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "odd.json"));
    const warns = [];
    const outbox = createOutbox({
      dir, send: async () => {}, logger: { warn: (m) => warns.push(m) },
    });
    for (let i = 0; i < 3; i += 1) await outbox.drain();
    assert.deepEqual(listing(dir), ["odd.json"]);
    assert.deepEqual(warns, [], "a directory was treated as a spooled result on every pass");
  });

  it("never leaves an empty file when a retirement cannot be moved", async () => {
    // A directory where the record should be: nothing can be spooled there,
    // the 422 is retired, and the move reserved an empty name it then could
    // not fill.
    const dir = tmp();
    mkdirSync(join(dir, spoolName("r-1")));
    const outbox = createOutbox({ dir, send: async () => { throw http(422); } });
    assert.equal(await outbox.deliver(ROLLOUT, OUTPUT), false);
    const empty = listing(dir).filter((n) => {
      const st = statSync(join(dir, n));
      return st.isFile() && st.size === 0;
    });
    assert.deepEqual(empty, [], "a 0-byte reservation was left behind");
  });
});

describe("a lease token outlives no failure (ND-H16)", () => {
  it("drops it when the result could not even be prepared", async () => {
    const dir = tmp();
    const seen = [];
    const outbox = createOutbox({ dir, send: async (r) => { seen.push(r.leaseToken); } });
    const hostile = { get finalText() { throw new Error("boom"); } };
    assert.equal(await outbox.deliver(ROLLOUT, hostile), false);
    writeFileSync(join(dir, spoolName("r-1")), spooled("r-1"));
    await outbox.drain();
    assert.deepEqual(seen, [null], "the token of a result that never existed was kept");
  });

  it("drops it when the held result goes stale", async () => {
    const dir = tmp();
    let clock = 1_000_000;
    const seen = [];
    let fail = true;
    const outbox = createOutbox({
      dir, now: () => clock,
      send: async (r) => { seen.push(r.leaseToken); if (fail) throw http(503); },
    });
    await outbox.deliver(ROLLOUT, OUTPUT);
    clock += MAX_AGE_MS + 1;
    await outbox.drain();
    fail = false;
    writeFileSync(join(dir, spoolName("r-1")), spooled("r-1", { first_seen_ts: clock }));
    await outbox.drain();
    assert.deepEqual(seen, ["lease-abc", null]);
  });
});

describe("every id is a file name (ND-H16)", () => {
  it("names an id with a lone surrogate instead of throwing, and keeps two apart", async () => {
    assert.notEqual(spoolName("a\ud800"), spoolName("a\udc00"));
    assert.notEqual(spoolName("a\ud800"), spoolName("a\ufffd"));
    const dir = tmp();
    const outbox = createOutbox({ dir, send: async () => { throw http(503); } });
    assert.equal(await outbox.deliver({ rolloutId: "r\ud800" }, OUTPUT), false);
    assert.deepEqual(retryable(dir), [spoolName("r\ud800")]);
  });

  it("gives ids differing only by case names a case-insensitive disk keeps apart", () => {
    const folded = (id) => spoolName(id).toLowerCase();
    assert.notEqual(folded("R-1"), folded("r-1"));
    assert.notEqual(folded("Ab"), folded("aB"));
    assert.equal(spoolName("r-1"), "r-1.json", "a lowercase id keeps its plain name");
    assert.equal(pathSegment("AB") === pathSegment("AB").toLowerCase(), false);
  });

  it("finds an outbox an older SDK left under an agent id with a capital", () => {
    const home = mkdtempSync(join(tmpdir(), "percepteye-outbox-home-"));
    const env = { PERCEPTEYE_HOME: home };
    const legacy = join(home, "outbox", "MyAgent");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "r-1.json"), spooled("r-1"));
    const now = outboxDir("MyAgent", env);
    assert.notEqual(now, legacy);
    assert.deepEqual(listing(now), ["r-1.json"], "the held result was orphaned");
  });
});
