/**
 * `describe`: the operator says what the agent is, where nothing can read it.
 *
 * OpenClaw's `llm_input` carries no tools, so this plugin's own observation
 * never has a catalogue. These tests pin the Node end of the Python SDK's
 * `describe=`: the same rules, the same wire record, the same refusals (the
 * Python repository's `tests/test_describe_parity.py` holds the two equal
 * across one table), consent asked the same way, and a declaration that never
 * anchors an execution identity.
 */
import { testEnv } from "./support/home.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { CONFIG_SCHEMA, resolveConfig } from "../src/config.js";
import {
  applyDeclaration, MAX_PROMPT_CHARS, resolveDeclaration, SOURCE_TYPE,
} from "../src/declaration.js";
import { ConfigurationError } from "../src/errors.js";
import { register } from "../src/index.js";
import { turnDir, turnWire } from "../src/turns.js";

/** The three shapes an agent already sends its model, plus a declaration. */
const TOOLS = [
  { type: "function", function: {
    name: "search_orders", description: "Find orders.",
    parameters: { type: "object", properties: { email: { type: "string" } } } } },
  { name: "refund", description: "Refund an order.",
    input_schema: { type: "object", properties: { id: { type: "string" } } } },
  { name: "lookup", description: "Read one.", input_schema: {}, read_only: true },
  // OpenAI's legacy flat `functions` shape: the schema is `parameters`.
  { name: "legacy", parameters: { type: "object", properties: { q: { type: "string" } } } },
];

const declared = (spec) => applyDeclaration(resolveDeclaration(spec), {
  reflected: null, agentName: "acme-bot",
});

describe("a declaration registers what the operator said", () => {
  it("reads every tool shape through Python's parser", () => {
    const d = declared({ system_prompt: "You resolve orders.", tools: TOOLS, model: "gpt-4.1" });
    assert.deepEqual(d.tool_definitions.map((t) => t.name),
      ["search_orders", "refund", "lookup", "legacy"]);
    assert.deepEqual(d.tool_definitions[0].input_schema.properties, { email: { type: "string" } });
    assert.equal(d.tool_definitions[0].original_format, "openai_function");
    assert.equal(d.tool_definitions[1].original_format, "anthropic_tool");
    assert.deepEqual(d.tool_definitions[3].input_schema.properties, { q: { type: "string" } });
    assert.equal(d.tool_definitions[2].read_only, true);
    assert.equal("read_only" in d.tool_definitions[1], false, "undeclared stays undeclared");
    assert.deepEqual(d.discovered_model_config, { provider: "unknown", model_name: "gpt-4.1" });
    assert.equal(d.system_prompt, "You resolve orders.");
  });

  it("says who said it, and invents no framework", () => {
    const d = declared({ tools: [] });
    assert.equal(d.source_type, SOURCE_TYPE);
    assert.equal(d.source_type, "sdk_declared");
    assert.deepEqual(d, {
      agent_name: "acme-bot", framework: "custom", source_type: "sdk_declared",
      role: "standalone", tool_definitions: [],
    });
  });

  it("reads read_only beside any shape, never inside `function`", () => {
    const d = declared({ tools: [
      { type: "function", function: { name: "s", parameters: {} }, read_only: true }] });
    assert.equal(d.tool_definitions[0].read_only, true);
  });

  it("takes a model mapping, and leaves unset fields off the wire", () => {
    const d = declared({ model: { provider: "openai", model_name: "gpt-4.1", temperature: 0.2 } });
    assert.deepEqual(d.discovered_model_config,
      { provider: "openai", model_name: "gpt-4.1", temperature: 0.2 });
  });

  it("cuts the prompt at the registration bound, in code points", () => {
    const d = declared({ system_prompt: "😀".repeat(MAX_PROMPT_CHARS + 5) });
    assert.equal(Array.from(d.system_prompt).length, MAX_PROMPT_CHARS);
  });

  it("calls a function once, and names describe when it throws", () => {
    let calls = 0;
    const d = declared(() => { calls += 1; return { tools: TOOLS.slice(0, 1) }; });
    assert.equal(calls, 1);
    assert.deepEqual(d.tool_definitions.map((t) => t.name), ["search_orders"]);
    assert.throws(() => resolveDeclaration(() => { throw new TypeError("no prompt"); }),
      (err) => err instanceof ConfigurationError
        && err.message === "describe= raised TypeError: no prompt");
  });

  it("declares nothing when every value is null", () => {
    assert.equal(resolveDeclaration({ system_prompt: null, tools: null }), null);
    assert.equal(resolveDeclaration(null), null);
  });
});

describe("declared wins, and only where given", () => {
  const observed = () => ({
    agent_name: "support", framework: "openclaw", source_type: "sdk_runtime",
    role: "standalone", tool_definitions: null, system_prompt: "observed",
    discovered_model_config: { provider: "openai", model_name: "gpt-4o" },
    incomplete: ["tool_definitions"],
  });

  it("fills the tools the host cannot observe, and keeps the rest", () => {
    const d = applyDeclaration(resolveDeclaration({ tools: TOOLS.slice(1, 2) }), {
      reflected: observed(), agentName: "support",
    });
    assert.deepEqual(d.tool_definitions.map((t) => t.name), ["refund"]);
    assert.equal(d.system_prompt, "observed");
    assert.equal(d.framework, "openclaw");
    assert.equal(d.source_type, "sdk_declared");
    assert.equal("incomplete" in d, false, "the tools are no longer unknown");
  });

  it("drops each declared part from incomplete, and only that part", () => {
    const d = applyDeclaration(resolveDeclaration({ tools: [], model: "m" }), {
      reflected: { ...observed(), incomplete: [
        "system_prompt", "tool_definitions", "tool", "discovered_model_config"] },
      agentName: "support",
    });
    assert.deepEqual(d.incomplete, ["system_prompt"]);
  });

  it("returns the observation untouched when nothing was declared", () => {
    const o = observed();
    assert.equal(applyDeclaration(null, { reflected: o, agentName: "support" }), o);
  });
});

describe("a bad declaration is refused, naming the cause", () => {
  const fn = (extra) => ({ type: "function", function: { name: "x", ...extra } });
  const WHOLE = `describe['model']['max_tokens'] must be a whole number from 1 to ${Number.MAX_SAFE_INTEGER}`;
  const CASES = [
    [{ prompt: "typo" }, 'describe= got unknown key(s) ["prompt"]; it accepts ["model", "system_prompt", "tools"]'],
    // Key lists are JSON, sorted by code point, as Python renders and sorts
    // them: a quote, a non-BMP key and U+FFFF each rendered or sorted
    // differently before.
    [{ "it's": 1, "\u{1F600}": 1, "\uffff": 1 },
      'describe= got unknown key(s) ["it\'s", "\\uffff", "\\ud83d\\ude00"]'],
    [{ tools: [{ description: "no name" }] }, "describe['tools'][0] is not a tool"],
    // Python's str.strip(): U+0085 is whitespace there, so this is no name.
    [{ tools: [{ name: "\u0085" }] }, "describe['tools'][0] is not a tool"],
    // Coerced, a name or description became text no two languages agree on.
    [{ tools: [{ name: {} }] }, "describe['tools'][0]: 'name' must be a string, got object"],
    [{ tools: [{ name: 5 }] }, "describe['tools'][0]: 'name' must be a string, got number"],
    [{ tools: [fn({ description: ["a"] })] }, "describe['tools'][0]: 'description' must be a string, got array"],
    [{ tools: "search" }, "describe['tools'] must be a list"],
    [["not", "a", "mapping"], "describe= must be a mapping (or a callable returning one), got array"],
    [1.5, "describe= must be a mapping (or a callable returning one), got number"],
    // An async describe resolves to a Promise, not a declaration.
    [async () => ({ tools: [] }), "describe= must be a mapping (or a callable returning one), got Promise"],
    [{ system_prompt: 5 }, "describe['system_prompt'] must be a string"],
    [{ model: 5 }, "describe['model'] must be a model name"],
    [{ model: { provider: "openai", model: "gpt-4.1" } }, 'describe[\'model\'] got unknown key(s) ["model"]'],
    [{ model: { provider: "openai" } }, "describe['model'] needs a 'model_name' string"],
    [{ model: { model_name: "m", temperature: "0.2" } }, "describe['model']['temperature'] must be a number"],
    [{ model: { model_name: "m", temperature: Infinity } }, "describe['model']['temperature'] must be a finite number"],
    [{ model: { model_name: "m", max_tokens: 1.5 } }, WHOLE],
    [{ model: { model_name: "m", max_tokens: 0 } }, WHOLE],
    [{ model: { model_name: "m", max_tokens: 2 ** 53 } }, WHOLE],
    [{ model: { model_name: "m", provider: 3 } }, "describe['model']['provider'] must be a string"],
    [{ model: " " }, "describe['model'] must not be empty"],
    [{ model: "\u0085" }, "describe['model'] must not be empty"],
    [{ tools: [{ name: "x", input_schema: "{}" }] }, "describe['tools'][0]: the schema must be a JSON-schema mapping, got string"],
    [{ tools: [fn({ parameters: [] })] }, "describe['tools'][0]: the schema must be a JSON-schema mapping, got array"],
    [{ tools: [{ name: "x", read_only: "true" }] }, "describe['tools'][0]['read_only'] must be true or false"],
    [{ tools: [fn({ read_only: true })] }, "describe['tools'][0]: read_only goes beside 'function', not inside it"],
  ];
  for (const [spec, cause] of CASES) {
    it(cause, () => {
      assert.throws(() => resolveDeclaration(spec),
        (err) => err instanceof ConfigurationError && err.message.startsWith(cause),
        `expected a refusal starting ${JSON.stringify(cause)}`);
    });
  }
});

describe("consent is asked as the Python SDK asks it", () => {
  it("is on unless deliberately refused, from either side", () => {
    assert.equal(resolveConfig({}, {}).introspect, true);
    assert.equal(resolveConfig({}, { PERCEPTEYE_INTROSPECT: "yes please" }).introspect, true);
    assert.equal(resolveConfig({ introspect: false }, {}).introspect, false);
    assert.equal(resolveConfig({}, { PERCEPTEYE_INTROSPECT: "0" }).introspect, false);
    // Neither side overrides the other's refusal.
    assert.equal(resolveConfig({ introspect: true }, { PERCEPTEYE_INTROSPECT: "off" }).introspect, false);
  });

  it("transports the declaration untouched", () => {
    const spec = { tools: [] };
    assert.equal(resolveConfig({ describe: spec }, {}).describe, spec);
    assert.equal(resolveConfig({}, {}).describe, null);
  });

  it("reads a numeric 0 as off, for every switch the README says 0 turns off", () => {
    const off = resolveConfig(
      { capture: 0, applyPrompt: 0, applyModel: 0, introspect: 0 }, {});
    assert.deepEqual(
      [off.captureEnabled, off.applyPromptEnabled, off.applyModelEnabled, off.introspect],
      [false, false, false, false]);
  });
});

describe("the host's schema never refuses what declaration.js should judge", () => {
  // OpenClaw validates plugin config against this schema, and a value it
  // rejects SKIPS THE PLUGIN -- local capture included. So anything the host
  // could refuse here would turn "a bad declaration is a warning" into a
  // plugin that never loaded.
  it("declares no type for describe", () => {
    assert.equal("type" in CONFIG_SCHEMA.properties.describe, false);
  });

  it("lets every switch be a number, or null, as well", () => {
    for (const key of ["capture", "applyPrompt", "applyModel", "introspect"]) {
      assert.ok(CONFIG_SCHEMA.properties[key].type.includes("number"), key);
      assert.ok(CONFIG_SCHEMA.properties[key].type.includes("null"), key);
    }
    // And null means unset: the environment decides, as with no key at all.
    assert.equal(resolveConfig({ introspect: null }, { PERCEPTEYE_INTROSPECT: "0" }).introspect, false);
    assert.equal(resolveConfig({ capture: null }, {}).captureEnabled, true);
  });
});

// ── through register(), the path an operator actually gets ──────────────────

const SNAPSHOT = {
  adapterName: "customer-host",
  executionIdentityComplete: true,
  executionComponents: { customer_agent_code: "a".repeat(64) },
};
// The host observation `execution-identity.test.js` stamps a turn from: exact
// identity needs the adapter's tool list as well as the prompt and model.
const EVENT = {
  runId: "run-1", sessionId: "session-1", provider: "openai-compatible",
  model: "customer-model", systemPrompt: "You are a support agent.",
  tools: [{ name: "lookup", description: "Look up a record",
            parameters: { type: "object", properties: { id: { type: "string" } } } }],
};

function plugin(config, env = {}) {
  const root = mkdtempSync(join(tmpdir(), "pe-describe-"));
  const handlers = new Map();
  const warnings = [];
  const api = {
    on: (name, fn) => handlers.set(name, fn),
    logger: { info() {}, warn: (message) => warnings.push(message) },
  };
  const out = register(api, { mode: "production", ...config },
    testEnv({ PERCEPTEYE_CAPTURE_DIR: root, ...env }));
  const serveOneTurn = () => {
    handlers.get("message_received")({
      runId: "run-1", content: "help", sessionKey: "session-1" }, {});
    handlers.get("llm_input")(EVENT, { runId: "run-1", sessionKey: "session-1" });
    return turnWire(turnDir(root, "run-1"));
  };
  return { out, warnings, serveOneTurn };
}

describe("a declaration anchors no execution identity", () => {
  it("the same host observation that fingerprints a turn does not, once declared", () => {
    // The control: without a declaration this exact setup stamps the turn.
    assert.match(plugin({ executionSnapshot: SNAPSHOT }).serveOneTurn()
      .agent_fingerprint.execution_sha256, /^[0-9a-f]{64}$/);
    const p = plugin({ executionSnapshot: SNAPSHOT, describe: { tools: TOOLS } });
    assert.equal("agent_fingerprint" in p.serveOneTurn(), false);
    assert.equal(p.out.executionIdentity.enabled, false);
    assert.equal(p.out.executionIdentity.registrationFingerprint, null);
  });

  it("nor does a refused introspection, which says why", () => {
    const p = plugin({ executionSnapshot: SNAPSHOT }, { PERCEPTEYE_INTROSPECT: "0" });
    assert.equal("agent_fingerprint" in p.serveOneTurn(), false);
    assert.ok(p.warnings.some((w) => w.includes("introspection is off")));
  });

  it("says so when a declaration withholds an identity that was configured", () => {
    const p = plugin({ executionSnapshot: SNAPSHOT, describe: { tools: [] } });
    assert.ok(p.warnings.some((w) => w.includes("exact execution identity is withheld")));
    // The control: no declaration, no such line.
    assert.equal(plugin({ executionSnapshot: SNAPSHOT }).warnings.some(
      (w) => w.includes("withheld")), false);
  });
});

describe("with nothing observed, the plugin names its host", () => {
  it("passes its framework where Python, knowing nothing, says custom", () => {
    const d = applyDeclaration(resolveDeclaration({ tools: [] }), {
      reflected: null, agentName: "support", framework: "openclaw" });
    assert.equal(d.framework, "openclaw");
    assert.equal(declared({ tools: [] }).framework, "custom");   // the default
  });
});

describe("a declaration never costs the plugin load", () => {
  it("a bad one is dropped with the cause, and capture keeps running", () => {
    const p = plugin({ describe: { prompt: "typo" } });
    assert.ok(p.out, "the plugin must still load");
    assert.ok(p.warnings.some((w) => w.includes('describe= got unknown key(s) ["prompt"]')));
  });

  it("the opt-out wins over a declaration, with a warning", () => {
    const p = plugin({ describe: { tools: TOOLS } }, { PERCEPTEYE_INTROSPECT: "off" });
    assert.ok(p.warnings.some((w) => w.includes("it wins: the description declared")));
  });

  it("a typo still surfaces under the opt-out, before lifting it would", () => {
    const p = plugin({ describe: { prompt: "typo" } }, { PERCEPTEYE_INTROSPECT: "0" });
    assert.ok(p.warnings.some((w) => w.includes('unknown key(s) ["prompt"]')));
    // And the opt-out is still said: nothing at all is registered, not
    // "what was observed".
    assert.ok(p.warnings.some((w) => w.includes("registers no description at all")));
    assert.equal(p.warnings.some((w) => w.includes("registers only what was observed")), false);
  });

  it("a declaration that throws something else still costs nothing", () => {
    const p = plugin({ describe: { get tools() { throw new Error("boom"); } } });
    assert.ok(p.out, "the plugin must still load");
    assert.ok(p.warnings.some((w) => w.includes("describe could not be read (boom)")));
  });

  it("a function is not run for a description that will not be sent", () => {
    let calls = 0;
    plugin({ describe: () => { calls += 1; return { tools: [] }; } },
      { PERCEPTEYE_INTROSPECT: "0" });
    assert.equal(calls, 0);
  });
});
