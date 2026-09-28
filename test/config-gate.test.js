/**
 * The capture kill switch, and the config schema that rejected its own settings.
 *
 * `openclaw.plugin.json` promises "Set false/0/off to disable local capture
 * entirely". `resolveConfig` computed `captureEnabled` for exactly that — and
 * NOTHING read it. `trajectory.js` gates on the trajectory directory alone, so
 * a customer who set PERCEPTEYE_CAPTURE=0 kept being recorded. A promise about
 * somebody's data that the code does not keep is the worst kind of defect
 * here, because the person it misleads is the one who tried to opt out.
 *
 * And `index.js` exported `configSchema: {additionalProperties: false,
 * properties: {}}` — not merely failing to READ the settings but REJECTING
 * them: a customer following the manifest and setting `apiKey` would have had
 * it refused by the schema the module itself publishes.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import plugin, { register, PLUGIN_ID } from "../src/index.js";
import { CONFIG_SCHEMA, resolveConfig } from "../src/config.js";
import { PRODUCTION } from "../src/mode.js";

/** A host stub that records what the plugin subscribed to. */
function fakeApi() {
  const hooks = [];
  return { hooks, on: (name, fn) => hooks.push([name, fn]), logger: { info() {}, warn() {} } };
}

test("capture off via the environment registers no hooks at all", () => {
  const api = fakeApi();
  const out = register(api, {}, { PERCEPTEYE_CAPTURE: "0" });
  assert.equal(out, null, "register must return nothing when capture is off");
  assert.equal(api.hooks.length, 0, "no hook may be subscribed");
});

test("capture off via plugin config registers no hooks", () => {
  const api = fakeApi();
  assert.equal(register(api, { capture: false }), null);
  assert.equal(api.hooks.length, 0);
});

test("every documented off value is honoured", () => {
  for (const value of ["0", "false", "no", "off", "OFF", " False "]) {
    assert.equal(
      resolveConfig({ capture: value }).captureEnabled, false,
      `capture=${JSON.stringify(value)} must disable capture`,
    );
  }
});

test("capture stays ON by default, and a typo does not silently disable it", () => {
  assert.equal(resolveConfig({}).captureEnabled, true);
  // The manifest says false/0/off. Anything else is a typo, and a typo must
  // not quietly switch capture off and leave an operator believing it is on.
  assert.equal(resolveConfig({ capture: "flase" }).captureEnabled, true);
  const api = fakeApi();
  assert.notEqual(register(api, {}), null);
  assert.ok(api.hooks.length >= 1, "the recorder must be subscribed");
});

test("the module's config schema is the manifest's, not a second one", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(
    plugin.configSchema, manifest.configSchema,
    "the schema the module publishes and the schema the host reads must be " +
    "the same object — they had already diverged, and the module's rejected " +
    "every setting the manifest documents",
  );
  assert.deepEqual(plugin.configSchema, CONFIG_SCHEMA);
});

test("the schema accepts the settings the manifest tells customers to set", () => {
  // The regression that matters: `additionalProperties: false` with no
  // properties refuses apiKey, which is the first thing the manifest documents.
  for (const key of [
    "apiKey", "agentId", "controlPlaneUrl", "capture", "executionSnapshot",
    "rules",
  ]) {
    assert.ok(
      key in plugin.configSchema.properties,
      `${key} is documented in the manifest and must be accepted`,
    );
  }
  // `rules` is typed by nobody but the control plane: a type here would let
  // the host refuse the whole plugin load -- local capture included -- over a
  // malformed rule list the control plane would have refused and named.
  assert.equal("type" in plugin.configSchema.properties.rules, false);
  const startup = plugin.configSchema.properties.executionSnapshot
    .properties.startupObservation;
  assert.deepEqual(
    startup.required,
    ["systemPrompt", "tools", "provider", "model"],
  );
  assert.equal(startup.additionalProperties, false);
  assert.equal(
    Object.hasOwn(startup.properties, "execution_sha256"), false,
    "a caller-authored final digest is not a startup-observation input",
  );
});

test("resolveConfig transports an optional startup observation without inventing one", () => {
  assert.equal(resolveConfig({}).executionSnapshot, null);
  const startupObservation = {
    systemPrompt: "Use the registered tools.",
    tools: [{ name: "lookup", parameters: { type: "object" } }],
    provider: "gateway",
    model: "policy",
  };
  const executionSnapshot = {
    adapterName: "openclaw-exact",
    executionIdentityComplete: true,
    executionComponents: { host_code: "a".repeat(64) },
    startupObservation,
  };
  assert.equal(
    resolveConfig({ executionSnapshot }).executionSnapshot,
    executionSnapshot,
  );
});

test("agent ids are exact wire identifiers, never trimmed or path-cleaned", () => {
  for (const agentId of [" agent ", "../agent", ".", "..", "bad\u0000id", "x".repeat(256)]) {
    assert.throws(
      () => resolveConfig({ agentId }),
      /agentId must be a non-empty, control-free identifier/,
    );
  }
  assert.equal(resolveConfig({ agentId: "顧客 agent #1" }).agentId, "顧客 agent #1");
  assert.equal(resolveConfig({ agentId: "😀".repeat(255) }).agentId, "😀".repeat(255));
});

test("the plugin id is one value, not two", () => {
  assert.equal(plugin.id, PLUGIN_ID);
});


test("config from the HOST turns capture off", () => {
  // OpenClaw hands validated `plugins.entries.<id>.config` over on
  // `api.pluginConfig` (dist/types-DaHgOqFX.d.ts:12076), not as a second
  // argument to register(). Reading only the argument honoured the
  // environment variable and ignored the customer's OpenClaw config — the
  // half the manifest documents most prominently.
  const api = fakeApi();
  api.pluginConfig = { capture: false };
  assert.equal(register(api), null, "api.pluginConfig must be read");
  assert.equal(api.hooks.length, 0);
});

test("host config carrying an api key does not disable capture", () => {
  const api = fakeApi();
  api.pluginConfig = { apiKey: "pefw_x", agentId: "coder" };
  assert.notEqual(register(api), null);
  assert.ok(api.hooks.length >= 1);
});

test("an explicit argument still wins, so the gate stays testable", () => {
  const api = fakeApi();
  api.pluginConfig = { capture: true };
  assert.equal(register(api, { capture: false }), null);
});


test("the transport calls no route the control plane does not serve", async () => {
  // The complete route set the control plane's flywheel API serves, read from
  // its own route declarations plus the policy routes it mounts. Vendored as
  // a list because this package must not import the control plane — the same
  // reason schema/flywheel-1.json is a copy — and asserted here so a new
  // transport method calling a route that does not exist is caught at test
  // time rather than as a 404 in a customer's process.
  //
  // `POST /rollouts/{id}/artifacts` was such a method. It shipped, it was
  // tested against a stub, and the route has never existed.
  const SERVED = new Set([
    "GET /health",
    "POST /agents",
    "POST /agents/{id}/rulebook",
    "GET /agents/{id}/capture",
    "POST /rollouts/claim",
    "POST /rollouts/{id}/heartbeat",
    "POST /rollouts/{id}/result",
    "POST /rollouts/{id}/abandon",
    "POST /turns",
    "GET /rollouts/{id}",
    "GET /rollouts",
    "GET /policy/current",
    "GET /prompt/current",
  ]);

  const src = readFileSync(new URL("../src/transport.js", import.meta.url), "utf8");
  // Every `request("METHOD", "<path>"` the transport makes, with template
  // interpolations normalised back to the server's own path parameter.
  const calls = [...src.matchAll(/request\(\s*"(GET|POST)",\s*[`"]([^`"]+)[`"]/g)]
    .map(([, method, path]) => `${method} ${path.replace(/\$\{[^}]+\}/g, "{id}")}`);
  // Opaque rollout ids are now encoded by one helper before they enter a URL;
  // keep those helper-backed calls in the same complete route inventory.
  for (const match of src.matchAll(
    /request\(\s*"POST",\s*rolloutPath\([^,]+,\s*"(heartbeat|result|abandon)"\)/g,
  )) {
    calls.push(`POST /rollouts/{id}/${match[1]}`);
  }

  assert.ok(calls.length >= 8, `expected the transport's calls, found ${calls.length}`);
  const unserved = calls.filter((c) => !SERVED.has(c));
  assert.deepEqual(
    unserved, [],
    `transport calls routes the control plane does not serve: ${unserved.join(", ")}`,
  );
});


// ── THE HOST HYDRATES SCHEMA DEFAULTS INTO api.pluginConfig ────────────────
//
// The defect these cover: `mode`, `capture` and `agentId` each declared a
// `default` in the schema. OpenClaw validates `plugins.entries.<id>.config`
// with `validateJsonSchemaValue({..., applyDefaults: true})`
// (dist/loader-D8d2EvVh.js:1381-1412 -> dist/schema-validator-BRkrm3P2.js:239)
// and hands the RESULT over as `api.pluginConfig`, so a customer with NO
// config block at all was given `{agentId:"openclaw", capture:true,
// mode:"training"}` as EXPLICIT config — which outranks the environment. Every
// documented env switch was therefore inert: PERCEPTEYE_AGENT_MODE=production
// on a gateway serving real users still claimed rollouts and started
// unattended turns, PERCEPTEYE_CAPTURE=0 still recorded, and three fleets
// distinguished by PERCEPTEYE_AGENT_ID all reported as "openclaw".
//
// Every existing test stayed green because none of them ever fed `register`
// the config the host actually produces — they pass `{}`, or an
// `api.pluginConfig` written by hand.

/**
 * `validateJsonSchemaValue({..., applyDefaults: true})`, in the one respect
 * that bit us: a missing key with a schema `default` becomes present.
 *
 * Reproduced rather than imported. This package must not depend on the host
 * (the same reason `schema/flywheel-1.json` is a vendored copy), and the
 * assertion below is about what the schema DECLARES, which is knowable here.
 */
function hydrateAsHostWould(schema, value = {}) {
  const out = { ...value };
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (!Object.hasOwn(out, key) && Object.hasOwn(prop ?? {}, "default")) {
      out[key] = prop.default;
    }
  }
  return out;
}

test("no schema property declares a `default` — the host would make it explicit", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  );
  for (const [label, schema] of [
    ["openclaw.plugin.json", manifest.configSchema],
    ["src/config.js CONFIG_SCHEMA", CONFIG_SCHEMA],
  ]) {
    const withDefaults = Object.entries(schema.properties ?? {})
      .filter(([, prop]) => Object.hasOwn(prop ?? {}, "default"))
      .map(([key]) => key);
    assert.deepEqual(
      withDefaults, [],
      `${label} declares a default for ${withDefaults.join(", ")}. The host ` +
      `hydrates it into api.pluginConfig as an EXPLICIT value, which beats ` +
      `the environment — resolveConfig is the only place a default belongs`,
    );
  }
});

test("the config the host builds from an EMPTY config block leaves every env switch working", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  );
  // Exactly what OpenClaw hands a customer who wrote no `config` block.
  const supplied = hydrateAsHostWould(manifest.configSchema, {});
  const config = resolveConfig(supplied, {
    PERCEPTEYE_AGENT_MODE: "production",
    PERCEPTEYE_CAPTURE: "0",
    PERCEPTEYE_AGENT_ID: "support-bot",
  });
  assert.equal(config.mode, PRODUCTION, "PERCEPTEYE_AGENT_MODE must decide the mode");
  assert.equal(
    config.modeSource, "environment",
    "a hydrated default must not be reported as the customer's own config",
  );
  assert.equal(config.captureEnabled, false, "PERCEPTEYE_CAPTURE=0 must disable capture");
  assert.equal(config.agentId, "support-bot", "PERCEPTEYE_AGENT_ID must name the agent");
});

test("PERCEPTEYE_AGENT_MODE=production keeps the rollout driver unregistered under the host's own calling convention", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  );
  const api = fakeApi();
  // The host calls `register(api)` with ONE argument
  // (loader-D8d2EvVh.js:761) and puts the validated config here.
  api.pluginConfig = hydrateAsHostWould(manifest.configSchema, {});
  const out = register(api, {}, {
    PERCEPTEYE_AGENT_MODE: "production",
    PERCEPTEYE_CAPTURE_DIR: join(tmpdir(), "percepteye-config-gate-test"),
  });
  assert.equal(out.mode, PRODUCTION);
  assert.equal(out.rollouts, null, "production must not construct the rollout driver");
  const subscribed = api.hooks.map(([name]) => name);
  for (const hook of ["session_start", "gateway_start", "cron_changed", "session_end"]) {
    assert.ok(
      !subscribed.includes(hook),
      `${hook} is a rollout hook and must not be subscribed in production; ` +
      `subscribed: ${subscribed.join(", ")}`,
    );
  }
});

test("production is NOT inert without a trajectory dir, and the description no longer says it is", () => {
  // `plugin.description` is what `openclaw plugins list` prints, and it read
  // "Inert unless PERCEPTEYE_TRAJECTORY_DIR is set" — the README's "no file,
  // no writes ... that is what lets you leave it installed permanently" said
  // the same. Both were INVERTED once production mode gained turn capture:
  // production is the mode that writes with that variable unset, and what it
  // writes is the END USER'S message text.
  const root = mkdtempSync(join(tmpdir(), "percepteye-inert-"));
  try {
    const api = fakeApi();
    // No PERCEPTEYE_TRAJECTORY_DIR anywhere in this env, deliberately.
    register(api, {}, {
      PERCEPTEYE_AGENT_MODE: "production", PERCEPTEYE_CAPTURE_DIR: root,
    });
    const received = api.hooks.find(([name]) => name === "message_received");
    assert.ok(received, "production subscribes the end user's message");
    received[1]({ runId: "run1", content: "my account number is 12345", sessionKey: "s" }, {});
    assert.ok(
      readdirSync(root).length > 0,
      "production capture writes the served turn to disk with no trajectory dir set",
    );
    assert.ok(
      !/\binert\b/i.test(plugin.description),
      `the description a customer reads claims inertness while the plugin ` +
      `writes their users' messages: ${JSON.stringify(plugin.description)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
