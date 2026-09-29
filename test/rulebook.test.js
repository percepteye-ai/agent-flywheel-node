/**
 * An agent declares the workflow rules its Product follows: the wire call, and
 * BOTH lanes that make it.
 *
 * The rules reach the control plane on their own route
 * (`POST /agents/{id}/rulebook`), once per start, after the agent registers,
 * in production (`registerTurnCapture`, after the verdict read) and in
 * training (`registerRolloutDriver`) alike. A refused, slow or undeliverable
 * declaration costs the rules and nothing else -- never the registration, the
 * verdict read, the approved serving policy, a claim, or the plugin load --
 * and says why in `rulebookRefusal`, naming the control plane's own cause, or
 * the reason they were never sent at all.
 *
 * The rules and products here are deliberately generic and obviously fake.
 * The golden idempotency keys were derived by the Python SDK's rule
 * (`json.dumps(sort_keys=True)`, sha256, first 32 hex characters) under
 * Python itself, so this suite pins the cross-SDK key without needing Python
 * to run; the Python package's parity test drives this build to prove it live.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { PLUGIN_ID, register } from "../src/index.js";
import { createTurnCapture, registerTurnCapture } from "../src/capture.js";
import { TransportError } from "../src/errors.js";
import { ControlPlaneClient } from "../src/http.js";
import { registerRolloutDriver } from "../src/rollout.js";
import { AttachTransport, declareRulebook } from "../src/transport.js";
import { ContractError, RULEBOOK_RECEIPT_KEYS } from "../src/wire.js";

const schema = JSON.parse(
  readFileSync(new URL("../schema/flywheel-1.json", import.meta.url), "utf8"),
);

/**
 * DELIBERATELY AWKWARD: a curly apostrophe and an em dash, an escaped quote,
 * German, an astral emoji and CJK, and backslashes -- the shapes where
 * `JSON.stringify` and Python's `json.dumps` part ways.
 */
const RULES = [
  "Before issuing a refund, confirm the order number with the customer.",
  "Quote prices in the customer\u2019s currency \u2014 never convert them silently.",
  "Escalate to a human when the customer writes \"close my account\".",
  "F\u00fcr R\u00fcckfragen immer die Ticketnummer nennen \u{1f4e6} und " +
    "\u9867\u5ba2\u540d\u3092\u78ba\u8a8d\u3059\u308b\u3002",
  "A path such as C:\\temp\\notes is text to quote, never a file to open.",
];

/** An agent id that must be percent-encoded, as Python's `quote` encodes it. */
const AGENT = "support-bot (EU)";
const AGENT_PATH = "/agents/support-bot%20%28EU%29/rulebook";

/** Derived by the Python SDK's rule, under Python, over `{"rules": ...}`. */
const PYTHON_KEY = "rulebook-support-bot%20%28EU%29-bdbe3d2b3d22140d5ef4bc107802d085";
const PYTHON_RETRACTION_KEY =
  "rulebook-support-bot%20%28EU%29-af4fc1e3a66777e55c55972accbc0279";

/** What httpx 0.28 sends for `json={"rules": RULES}`, read off the wire. */
const PYTHON_BODY =
  "{\"rules\":[\"Before issuing a refund, confirm the order number with the " +
  "customer.\",\"Quote prices in the customer\u2019s currency \u2014 never " +
  "convert them silently.\",\"Escalate to a human when the customer writes " +
  "\\\"close my account\\\".\",\"F\u00fcr R\u00fcckfragen immer die " +
  "Ticketnummer nennen \u{1f4e6} und \u9867\u5ba2\u540d\u3092\u78ba\u8a8d" +
  "\u3059\u308b\u3002\",\"A path such as C:\\\\temp\\\\notes is text to " +
  "quote, never a file to open.\"]}";

const RECEIPT = {
  status: "registered",
  product_id: "prod-demo-1",
  version_id: "11111111-2222-3333-4444-555555555555",
  version: 2,
  content_sha256: "a".repeat(64),
  parent_sha256: "b".repeat(64),
  rule_count: RULES.length,
};

/** Records requests instead of making them -- the Python suite's `_Client`. */
function recordingClient(reply = RECEIPT) {
  const calls = [];
  return {
    calls,
    request: async (method, path, opts) => {
      calls.push({ method, path, ...opts });
      return reply;
    },
  };
}

/** The REAL client over a scripted `fetch`, so `http.js` is in the path. */
function realClient(respond) {
  const seen = [];
  const client = new ControlPlaneClient("https://cp.example/api/flywheel/v1", "pefw_k", {
    maxAttempts: 1,
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return respond(url, init);
    },
  });
  return { client, seen };
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

/** The control plane's two refusals, as FastAPI serialises them. */
const INVALID = {
  detail: {
    error: "rulebook_invalid",
    cause: "rule_too_short",
    index: 2,
    detail: "rule 2 is 11 characters; a rule is at least 24",
  },
};
const UNATTRIBUTED = {
  detail: {
    error: "rulebook_unattributed",
    status: "ambiguous_shared_agent",
    detail: "agent 'support-bot (EU)' is attributed to no Product " +
      "(ambiguous_shared_agent: " +
      "exactly one active Product must declare the agent in its Flywheel " +
      "spec), so its rules would belong to no Product and nothing was " +
      "registered.",
  },
};

async function settle() {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
}

// ── the wire call ─────────────────────────────────────────────────────────

describe("the declaration on the wire", () => {
  it("posts the closed RulebookRequest to the agent's own route, under the key Python derives", async () => {
    const c = recordingClient();
    const out = await new AttachTransport(c, { agentId: AGENT }).registerRulebook(RULES);
    assert.equal(c.calls.length, 1);
    const [call] = c.calls;
    assert.equal(call.method, "POST");
    assert.equal(call.path, AGENT_PATH);
    assert.deepEqual(call.jsonBody, { rules: RULES });
    const request = schema.$defs.RulebookRequest;
    assert.deepEqual(Object.keys(call.jsonBody), request.required);
    assert.deepEqual(Object.keys(call.jsonBody), Object.keys(request.properties));
    assert.equal(call.idempotencyKey, PYTHON_KEY,
      "the two SDKs must send one key for one declaration");
    // Replayable: the server answers the same rules `unchanged`, so the
    // client's ambiguous-retry default stays on.
    assert.equal(call.retryIfAmbiguous, undefined);
    assert.deepEqual(out, { receipt: RECEIPT, refusal: null });
  });

  it("sends [] as a retraction, under its own key -- never as nothing", async () => {
    const c = recordingClient({ ...RECEIPT, status: "retracted", rule_count: 0 });
    await new AttachTransport(c, { agentId: AGENT }).registerRulebook([]);
    assert.deepEqual(c.calls[0].jsonBody, { rules: [] });
    assert.equal(c.calls[0].idempotencyKey, PYTHON_RETRACTION_KEY);
  });

  it("puts the same body BYTES and headers on the wire as the Python SDK, through the real client", async () => {
    const { client, seen } = realClient(() => json(200, RECEIPT));
    const out = await new AttachTransport(client, { agentId: AGENT })
      .registerRulebook(RULES);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, `https://cp.example/api/flywheel/v1${AGENT_PATH}`);
    assert.equal(seen[0].init.method, "POST");
    assert.equal(seen[0].init.body, PYTHON_BODY);
    assert.equal(seen[0].init.headers["Idempotency-Key"], PYTHON_KEY);
    assert.equal(seen[0].init.headers["Content-Type"], "application/json");
    assert.deepEqual(out, { receipt: RECEIPT, refusal: null });
  });

  it("reads the receipt as the contract declares it, whatever else the answer carried", async () => {
    const c = recordingClient({ ...RECEIPT, ref: { uri: "gs://internal" } });
    const { receipt } = await new AttachTransport(c, { agentId: AGENT })
      .registerRulebook(RULES);
    assert.deepEqual(Object.keys(receipt), [...RULEBOOK_RECEIPT_KEYS]);
    assert.equal("ref" in receipt, false);
  });

  it("refuses what cannot be a list of rules BEFORE sending anything, as Python does", async () => {
    for (const [rules, message] of [
      ["Always confirm the order number first.",
        "rules must be a list of strings, one rule per string; got str " +
        "(a single string is one rule: pass it inside a list)"],
      [{ rules: [] }, "rules must be a list of strings, one rule per string; got dict"],
      [["Confirm the order number first, always.", 7], "rule 1 must be a string; got int"],
      [[null], "rule 0 must be a string; got NoneType"],
    ]) {
      const c = recordingClient();
      await assert.rejects(
        new AttachTransport(c, { agentId: AGENT }).registerRulebook(rules),
        (err) => err instanceof ContractError && err.message === message,
      );
      assert.equal(c.calls.length, 0, "a malformed declaration reached the wire");
    }
  });

  it("names a 2xx receipt it cannot read as unknown, never as registered or refused", async () => {
    for (const [reply, detail] of [
      [{ ...RECEIPT, status: "maybe" }, "RulebookReceipt carries invalid field(s): ['status']"],
      [{ status: "registered" },
        "RulebookReceipt missing required field(s): ['product_id', 'version_id', " +
        "'version', 'content_sha256', 'parent_sha256', 'rule_count']"],
      [{ ...RECEIPT, version: 0, content_sha256: "A".repeat(64) },
        "RulebookReceipt carries invalid field(s): ['version', 'content_sha256']"],
      [{}, "RulebookReceipt missing required field(s): ['status', 'product_id', " +
        "'version_id', 'version', 'content_sha256', 'parent_sha256', 'rule_count']"],
    ]) {
      const out = await new AttachTransport(recordingClient(reply), { agentId: AGENT })
        .registerRulebook(RULES);
      assert.deepEqual(out, {
        receipt: null,
        refusal: "the control plane answered this agent's rules with a receipt " +
          `this SDK cannot read (${detail}), so whether they are in force is ` +
          "unknown.",
      });
    }
  });

  for (const [label, status, body, names] of [
    ["a rule the wire rule refuses", 422, INVALID,
      ["HTTP 422", "rulebook_invalid", "rule_too_short", "\"index\":2"]],
    ["an agent attributed to no single Product", 409, UNATTRIBUTED,
      ["HTTP 409", "rulebook_unattributed", "\"status\":\"ambiguous_shared_agent\""]],
  ]) {
    it(`surfaces ${label} as a refusal naming the control plane's cause, never a throw`, async () => {
      const { client, seen } = realClient(() => json(status, body));
      const out = await new AttachTransport(client, { agentId: AGENT })
        .registerRulebook(RULES);
      assert.equal(seen.length, 1, "a 4xx refusal is terminal, not retried");
      assert.equal(out.receipt, null);
      assert.match(out.refusal, /^this agent's rules were not registered: /);
      for (const name of names) {
        assert.ok(out.refusal.includes(name),
          `the refusal must name ${name}: ${out.refusal}`);
      }
      assert.ok(!out.refusal.includes("[object Object]"),
        `the control plane's cause was flattened away: ${out.refusal}`);
    });
  }

  it("keeps as much of the control plane's answer as Python keeps, counted in characters", async () => {
    // 265 characters, 415 UTF-16 units: a cut by units dropped the end of the
    // answer that Python's `text[:300]` keeps (and could halve an emoji).
    const refused = {
      error: "rulebook_invalid", cause: "rule_json_text", index: 0,
      detail: `rule 0 reads as JSON text ${"\u{1f4e6}".repeat(150)} END-OF-DETAIL`,
    };
    const { client } = realClient(() => json(422, { detail: refused }));
    const out = await new AttachTransport(client, { agentId: AGENT })
      .registerRulebook(RULES);
    assert.equal(out.refusal,
      `this agent's rules were not registered: POST ${AGENT_PATH} -> HTTP 422: ` +
      `${JSON.stringify(refused)}. The rulebook in force, if any, is unchanged.`);
  });

  it("fails open when the control plane cannot be reached", async () => {
    const { client } = realClient(() => {
      throw Object.assign(new TypeError("fetch failed"),
        { cause: { code: "ECONNREFUSED" } });
    });
    const out = await new AttachTransport(client, { agentId: AGENT })
      .registerRulebook(RULES);
    assert.equal(out.receipt, null);
    assert.match(out.refusal, /ECONNREFUSED|fetch failed/);
  });
});

// ── the one step both lanes take ──────────────────────────────────────────

describe("declareRulebook", () => {
  const logger = () => {
    const lines = [];
    return { lines, info: (m) => lines.push(["info", m]), warn: (m) => lines.push(["warn", m]) };
  };

  it("sends NOTHING when no rules are configured -- which is not a retraction", async () => {
    for (const rules of [null, undefined]) {
      let called = 0;
      const refusal = await declareRulebook({
        transport: { registerRulebook: async () => { called += 1; return {}; } },
        rules, pluginId: PLUGIN_ID,
      });
      assert.equal(refusal, null);
      assert.equal(called, 0, `rules=${rules} must send nothing`);
    }
  });

  it("returns and logs the refusal, and never rejects, whatever the transport does", async () => {
    for (const transport of [
      { registerRulebook: () => { throw new Error("socket closed"); } },
      { registerRulebook: async () => { throw new Error("socket closed"); } },
      {},
    ]) {
      const log = logger();
      const refusal = await declareRulebook({
        transport, rules: RULES, pluginId: PLUGIN_ID, logger: log,
      });
      assert.match(refusal, /^this agent's rules were not registered: /);
      assert.deepEqual(log.lines, [["warn", `[${PLUGIN_ID}] ${refusal}`]]);
    }
  });

  it("says what the control plane did when it registered them", async () => {
    const log = logger();
    const refusal = await declareRulebook({
      transport: new AttachTransport(recordingClient(), { agentId: AGENT }),
      rules: RULES, pluginId: PLUGIN_ID, logger: log,
    });
    assert.equal(refusal, null);
    assert.equal(log.lines.length, 1);
    assert.equal(log.lines[0][0], "info");
    assert.match(log.lines[0][1], /registered \(version 2, 5 rule\(s\)\)/);
  });
});

// ── production: capture.js registerTurnCapture ────────────────────────────

/** A production control plane: registration, the verdict read, the rules. */
function productionTransport({ registerFails = false, rulebook = null } = {}) {
  const tr = new AttachTransport(recordingClient(), { agentId: "a1" });
  const calls = [];
  const declared = [];
  return {
    calls,
    declared,
    async register() {
      calls.push("register");
      if (registerFails) throw new Error("422 unsupported_contract_version");
      return {};
    },
    async registerRulebook(rules) {
      calls.push("registerRulebook");
      declared.push(rules);
      return rulebook ? rulebook(rules) : tr.registerRulebook(rules);
    },
    async captureCurrent() {
      calls.push("captureCurrent");
      return { capture: { turns: true } };
    },
    async reportTurns() { return {}; },
  };
}

function wireProduction(tr, config = {}, { makeTransport = () => tr, prepare = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pe-rulebook-prod-"));
  const turns = createTurnCapture({ root });
  prepare?.(turns);
  const warns = [];
  const infos = [];
  const api = { on() {}, logger: { info: (m) => infos.push(m), warn: (m) => warns.push(m) },
                config: {} };
  const out = registerTurnCapture(api, {
    config: { apiKey: "k", agentId: "a1", ...config },
    turns,
    pluginId: PLUGIN_ID,
    logger: api.logger,
    env: { PERCEPTEYE_CAPTURE_DIR: root },
    makeTransport,
  });
  return { out, warns, infos, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("the production lane declares the rules after registering", () => {
  it("registers, reads the verdict, THEN declares the rules", async () => {
    const tr = productionTransport();
    const { out, cleanup } = wireProduction(tr, { rules: RULES });
    try {
      await out.rulebook;
      assert.deepEqual(tr.calls, ["register", "captureCurrent", "registerRulebook"]);
      assert.deepEqual(tr.declared, [RULES]);
      assert.equal(out.rulebookRefusal, null);
      assert.equal(out.uploader.mayUpload, true);
    } finally { cleanup(); }
  });

  it("a rules value that is no list of strings is named and sends nothing", async () => {
    // The config schema types nothing (a wrong type would fail the plugin
    // load), so a single string arrives here. Python's serve()/attach()
    // refuse it at startup; a plugin may not throw, so it is dropped with the
    // same cause, logged and on the handle.
    const sent = [];
    const tr = productionTransport({ rulebook: (rules) => {
      const real = new AttachTransport({ request: async (...a) => { sent.push(a); return RECEIPT; } },
        { agentId: "a1" });
      return real.registerRulebook(rules);
    } });
    const { out, warns, cleanup } = wireProduction(tr, {
      rules: "Always confirm the order number first.",
    });
    try {
      await out.rulebook;
      assert.deepEqual(sent, []);
      assert.match(out.rulebookRefusal, /a single string is one rule: pass it inside a list/);
      assert.ok(warns.some((w) => w.includes(out.rulebookRefusal)));
      assert.equal(out.uploader.mayUpload, true);
    } finally { cleanup(); }
  });

  it("declares nothing when no rules are configured", async () => {
    const tr = productionTransport();
    const { out, cleanup } = wireProduction(tr);
    try {
      await out.rulebook;
      assert.deepEqual(tr.calls, ["register", "captureCurrent"]);
      assert.equal(out.rulebookRefusal, null);
    } finally { cleanup(); }
  });

  it("a REFUSED declaration costs the rules, never the verdict read, and says why", async () => {
    const refusing = new AttachTransport({
      request: async (method, path) => {
        throw new TransportError(
          `${method} ${path} -> HTTP 409: ${JSON.stringify(UNATTRIBUTED.detail)}`,
          { statusCode: 409 },
        );
      },
    }, { agentId: "a1" });
    const tr = productionTransport({ rulebook: (r) => refusing.registerRulebook(r) });
    const { out, warns, cleanup } = wireProduction(tr, { rules: RULES });
    try {
      await out.rulebook;
      assert.deepEqual(tr.calls, ["register", "captureCurrent", "registerRulebook"]);
      assert.match(out.rulebookRefusal, /rulebook_unattributed/);
      assert.ok(warns.some((w) => w.includes(out.rulebookRefusal)),
        "the refusal must reach the operator's log");
      assert.equal(out.uploader.mayUpload, true,
        "a refused rulebook swallowed the verdict read with it");
    } finally { cleanup(); }
  });

  it("still declares the rules when the REGISTRATION is refused", async () => {
    // The rulebook belongs to the Product that declares the agent, not to the
    // agent row, so a registration intake dislikes does not refuse it.
    const tr = productionTransport({ registerFails: true });
    const { out, cleanup } = wireProduction(tr, { rules: RULES });
    try {
      await out.rulebook;
      assert.deepEqual(tr.calls, ["register", "captureCurrent", "registerRulebook"]);
      assert.equal(out.rulebookRefusal, null);
    } finally { cleanup(); }
  });

  it("the startup chain never waits on the rules -- a route that does not answer holds back nothing", async () => {
    // `started` is what the serving-policy read waits on (index.js), so a
    // rulebook route that is slow or down must not be on it: the approved
    // prompt and model would wait out four 30s attempts behind rules a
    // teacher reads, not this install.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tr = productionTransport({ rulebook: async (r) => {
      await gate;
      return new AttachTransport(recordingClient(), { agentId: "a1" }).registerRulebook(r);
    } });
    const { out, cleanup } = wireProduction(tr, { rules: RULES });
    try {
      await out.started;
      assert.equal(out.uploader.mayUpload, true,
        "the verdict read waited on the rules");
      await settle();
      assert.deepEqual(tr.calls, ["register", "captureCurrent", "registerRulebook"]);
      assert.equal(out.rulebookRefusal, null, "the declaration has not settled yet");
      release();
      await out.rulebook;
      assert.equal(out.rulebookRefusal, null);
    } finally { release(); cleanup(); }
  });

  it("never rejects -- a transport that THROWS on the declaration still settles the chain", async () => {
    const rejections = [];
    const onUnhandled = (err) => rejections.push(err);
    process.on("unhandledRejection", onUnhandled);
    const tr = productionTransport();
    tr.registerRulebook = () => { throw new Error("socket closed"); };
    const { out, cleanup } = wireProduction(tr, { rules: RULES });
    try {
      await out.rulebook;
      await settle();
      assert.deepEqual(rejections, []);
      assert.match(out.rulebookRefusal, /socket closed/);
      assert.equal(out.uploader.mayUpload, true);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      cleanup();
    }
  });
});

describe("the production lane names rules it could never send", () => {
  // Nothing registers on these paths, so `declareRulebook` is never reached;
  // the refusal is named at once, with the cause that stopped the lane -- the
  // Python SDK's `Attachment.rulebook_refusal` names the same paths.
  it("with no API key: said on the handle and in the startup line", () => {
    const { out, infos, cleanup } = wireProduction(null, { apiKey: undefined, rules: RULES });
    try {
      assert.equal(out.transport, null);
      assert.equal(out.started, null);
      assert.equal(out.rulebook, null);
      assert.equal(out.rulebookRefusal,
        "no API key is configured, so the configured rules were never sent " +
        "to the control plane.");
      assert.ok(infos.some((l) => l.includes("No API key is configured") &&
        l.includes("the configured rules were never sent")),
        `the operator was not told: ${infos.join(" | ")}`);
    } finally { cleanup(); }
  });

  it("with no API key and no rules: nothing was owed, so nothing is named", () => {
    const { out, infos, cleanup } = wireProduction(null, { apiKey: undefined });
    try {
      assert.equal(out.rulebookRefusal, null);
      assert.ok(!infos.some((l) => l.includes("rules")),
        `a line named rules nobody configured: ${infos.join(" | ")}`);
    } finally { cleanup(); }
  });

  it("with no API key, a value that is no list of strings is named as THAT", () => {
    // It would be refused once a key is set too, so the key is not its cause.
    const { out, cleanup } = wireProduction(null, {
      apiKey: undefined, rules: "Always confirm the order number first.",
    });
    try {
      assert.match(out.rulebookRefusal, /^this agent's rules were not registered: /);
      assert.match(out.rulebookRefusal, /a single string is one rule: pass it inside a list/);
      assert.ok(!out.rulebookRefusal.includes("API key"));
    } finally { cleanup(); }
  });

  it("with a control-plane client that would not build: said, with its cause", () => {
    const { out, warns, infos, cleanup } = wireProduction(null, { rules: RULES }, {
      makeTransport: () => { throw new TransportError("control-plane base URL is required"); },
    });
    try {
      assert.equal(out.uploader, null);
      assert.equal(out.started, null);
      assert.equal(out.rulebook, null);
      assert.equal(out.rulebookRefusal,
        "the control plane could not be set up for this install " +
        "(control-plane base URL is required), so the configured rules were " +
        "never sent to the control plane.");
      assert.ok(warns.some((w) => w.includes(`Local recording to ${out.root} is unaffected.`) &&
        w.includes("the configured rules were never sent")),
        `the operator was not told: ${warns.join(" | ")}`);
      assert.ok(!infos.some((l) => l.includes("No API key")),
        `an install with a key was told it has none: ${infos.join(" | ")}`);
    } finally { cleanup(); }
  });

  it("a setup failure AFTER the uploader was built does not claim the rules went unsent", async () => {
    // The uploader exists, so the chain below still registers and declares:
    // "never sent" would be false, in the log and on the handle.
    const tr = productionTransport();
    const { out, warns, cleanup } = wireProduction(tr, { rules: RULES }, {
      prepare: (turns) => { turns.gateModelContent = () => { throw new Error("gate broke"); }; },
    });
    try {
      assert.ok(out.uploader, "the uploader was built");
      assert.equal(out.rulebookRefusal, null);
      assert.ok(warns.some((w) => w.includes("gate broke")));
      assert.ok(!warns.some((w) => w.includes("never sent")),
        `a warning claimed the rules went unsent: ${warns.join(" | ")}`);
      await out.rulebook;
      assert.deepEqual(tr.declared, [RULES]);
      assert.equal(out.rulebookRefusal, null);
    } finally { cleanup(); }
  });
});

// ── training: rollout.js registerRolloutDriver ────────────────────────────

function trainingApi({ conversationAccess = true } = {}) {
  const logs = [];
  return {
    logs,
    on() {},
    logger: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)) },
    config: { plugins: { entries: {
      [PLUGIN_ID]: { hooks: { allowConversationAccess: conversationAccess } } } } },
    session: { workflow: { enqueueNextTurnInjection: async () => ({ enqueued: true }) } },
  };
}

function trainingTransport({ registerFails = false, rulebook = null } = {}) {
  const inner = new AttachTransport(recordingClient(), { agentId: "support" });
  const order = [];
  const declared = [];
  return {
    order,
    declared,
    agentId: "support",
    leaseMs: 60_000,
    async health() {
      order.push("health");
      return { contract_versions_supported: ["flywheel/1"] };
    },
    async register() {
      order.push("register");
      if (registerFails) throw new Error("registration refused");
      return {};
    },
    registerRulebook(rules) {
      order.push("registerRulebook");
      declared.push(rules);
      return rulebook ? rulebook(rules) : inner.registerRulebook(rules);
    },
    async claim() { order.push("claim"); return { rollouts: [] }; },
    async report() {}, async abandon() {}, async heartbeat() {},
  };
}

function wireTraining(transport, config = {}, api = trainingApi()) {
  const driver = registerRolloutDriver(api, {
    config: { mode: "training", apiKey: "key", agentId: "support", ...config },
    transport,
    pluginId: PLUGIN_ID,
    logger: api.logger,
    env: { PERCEPTEYE_HOME: mkdtempSync(join(tmpdir(), "pe-rulebook-train-")) },
  });
  return { driver, api };
}

describe("the training lane declares the rules after registering", () => {
  it("health, registration, then the rules -- once", async () => {
    const tr = trainingTransport();
    const { driver } = wireTraining(tr, { rules: RULES });
    await driver.rulebook;
    assert.deepEqual(tr.order, ["health", "register", "registerRulebook"]);
    assert.deepEqual(tr.declared, [RULES]);
    assert.equal(driver.rulebookRefusal, null);
    await driver.onSessionStart({ sessionKey: "s1" });
    assert.equal(tr.order.filter((c) => c === "registerRulebook").length, 1,
      "a claim must not declare the rules again");
  });

  it("declares nothing when no rules are configured", async () => {
    const tr = trainingTransport();
    const { driver } = wireTraining(tr);
    await driver.rulebook;
    await driver.onSessionStart({ sessionKey: "s1" });
    assert.deepEqual(tr.order, ["health", "register", "claim"]);
    assert.equal(driver.rulebookRefusal, null);
  });

  it("no claim waits on the declaration", async () => {
    // A control plane that never answers the rules must not hold a lease back.
    const tr = trainingTransport({ rulebook: () => new Promise(() => {}) });
    const { driver } = wireTraining(tr, { rules: RULES });
    await driver.onSessionStart({ sessionKey: "s1" });
    assert.ok(tr.order.includes("claim"),
      `the first claim waited on the rules: ${tr.order.join(", ")}`);
  });

  it("a refused declaration is named on the driver, and the lane still claims", async () => {
    const { client } = realClient(() => json(422, INVALID));
    const real = new AttachTransport(client, { agentId: "support" });
    const tr = trainingTransport({ rulebook: (r) => real.registerRulebook(r) });
    const { driver, api } = wireTraining(tr, { rules: RULES });
    await driver.rulebook;
    assert.match(driver.rulebookRefusal, /rulebook_invalid/);
    assert.match(driver.rulebookRefusal, /rule_too_short/);
    assert.ok(api.logs.some((l) => l.includes(driver.rulebookRefusal)));
    await driver.onSessionStart({ sessionKey: "s1" });
    assert.ok(tr.order.includes("claim"));
  });

  it("still declares the rules when the REGISTRATION is refused, as production does", async () => {
    const tr = trainingTransport({ registerFails: true });
    const { driver } = wireTraining(tr, { rules: RULES });
    await driver.rulebook;
    assert.deepEqual(tr.order, ["health", "register", "registerRulebook"]);
  });

  it("a lane that never registers says the rules were never sent either", () => {
    const tr = trainingTransport();
    const api = trainingApi({ conversationAccess: false });
    const { driver } = wireTraining(tr, { rules: RULES }, api);
    assert.equal(driver, null);
    assert.deepEqual(tr.order, []);
    assert.ok(api.logs.includes(
      `[${PLUGIN_ID}] this install registers only to claim rollouts, and it ` +
      "claims none, so the configured rules were never sent to the control plane."),
      `the operator was not told: ${api.logs.join(" | ")}`);
  });

  it("a lane with no injection API says so too, and names a malformed value as malformed", () => {
    const tr = trainingTransport();
    const api = trainingApi();
    delete api.session;
    const { driver } = wireTraining(tr, { rules: "Always confirm the order number first." }, api);
    assert.equal(driver, null);
    assert.ok(api.logs.some((l) => l.includes(
      "a single string is one rule: pass it inside a list")),
      `the malformed value was not named: ${api.logs.join(" | ")}`);
  });

  it("a lane that never registers and has no rules names none", () => {
    const api = trainingApi({ conversationAccess: false });
    const { driver } = wireTraining(trainingTransport(), {}, api);
    assert.equal(driver, null);
    assert.ok(!api.logs.some((l) => l.includes("rules")),
      `a line named rules nobody configured: ${api.logs.join(" | ")}`);
  });
});

// ── end to end, from the host's entry point ───────────────────────────────

/**
 * `register()` with the real config, transport and HTTP client, against a
 * scripted `globalThis.fetch` (the client captures it at construction; there
 * is no other seam through `register`, as policy.test.js explains).
 */
async function throughRegister({ mode, rulebookStatus = 200, rulebookBody = RECEIPT }) {
  const root = mkdtempSync(join(tmpdir(), "pe-rulebook-e2e-"));
  const realFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    requests.push({ method: init.method, path, body: init.body ?? null });
    if (path.endsWith("/rulebook")) return json(rulebookStatus, rulebookBody);
    if (path.endsWith("/health")) {
      return json(200, { contract_versions_supported: ["flywheel/1"] });
    }
    return json(200, {});
  };
  try {
    const api = trainingApi();
    const out = register(api, { apiKey: "pefw_x", agentId: "support", rules: RULES }, {
      PERCEPTEYE_AGENT_MODE: mode, PERCEPTEYE_CAPTURE_DIR: root,
      PERCEPTEYE_HOME: root,
    });
    await (mode === "production" ? out.capture.rulebook : out.rollouts.rulebook);
    return { out, requests };
  } finally {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
}

describe("from register(), the path an operator actually gets", () => {
  it("production: the approved serving policy is read while the rules are still in flight", async () => {
    // The consumer that waits on the startup chain is `registerServingPolicy`
    // (index.js passes it `capture.started`). A rulebook route that has not
    // answered must not stand between this install and its approved prompt.
    const root = mkdtempSync(join(tmpdir(), "pe-rulebook-e2e-"));
    const realFetch = globalThis.fetch;
    const requests = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    globalThis.fetch = async (url, init) => {
      const path = new URL(url).pathname;
      requests.push(`${init.method} ${path}`);
      if (path.endsWith("/rulebook")) { await gate; return json(200, RECEIPT); }
      return json(200, {});
    };
    try {
      const out = register(trainingApi(), { apiKey: "pefw_x", agentId: "support", rules: RULES }, {
        PERCEPTEYE_AGENT_MODE: "production", PERCEPTEYE_CAPTURE_DIR: root,
      });
      await out.capture.started;
      for (let i = 0; i < 50 && !requests.includes("GET /api/flywheel/v1/policy/current"); i += 1) {
        await settle();
      }
      assert.ok(requests.includes("POST /api/flywheel/v1/agents/support/rulebook"),
        `the rules were never sent: ${requests.join(", ")}`);
      assert.ok(requests.includes("GET /api/flywheel/v1/policy/current"),
        `the serving-policy read waited on the rules: ${requests.join(", ")}`);
      release();
      await out.capture.rulebook;
      assert.equal(out.capture.rulebookRefusal, null);
    } finally {
      release();
      globalThis.fetch = realFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });


  for (const mode of ["production", "training"]) {
    it(`${mode}: the configured rules reach the rulebook route after the registration`, async () => {
      const { out, requests } = await throughRegister({ mode });
      const paths = requests.map((r) => `${r.method} ${r.path}`);
      const rulebook = paths.indexOf("POST /api/flywheel/v1/agents/support/rulebook");
      assert.ok(rulebook >= 0, `no declaration was sent: ${paths.join(", ")}`);
      assert.ok(paths.indexOf("POST /api/flywheel/v1/agents") < rulebook,
        "the rules must follow the registration");
      assert.equal(requests[rulebook].body, JSON.stringify({ rules: RULES }));
      const handle = mode === "production" ? out.capture : out.rollouts;
      assert.equal(handle.rulebookRefusal, null);
    });

    it(`${mode}: a refusal from the control plane lands on the handle, named`, async () => {
      const { out } = await throughRegister({
        mode, rulebookStatus: 409, rulebookBody: UNATTRIBUTED,
      });
      const handle = mode === "production" ? out.capture : out.rollouts;
      assert.match(handle.rulebookRefusal, /rulebook_unattributed/);
      assert.match(handle.rulebookRefusal, /ambiguous_shared_agent/);
    });
  }
});
