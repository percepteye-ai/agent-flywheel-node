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
import { readFileSync } from "node:fs";
import { test } from "node:test";

import plugin, { register, PLUGIN_ID } from "../src/index.js";
import { CONFIG_SCHEMA, resolveConfig } from "../src/config.js";

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
  for (const key of ["apiKey", "agentId", "controlPlaneUrl", "capture"]) {
    assert.ok(
      key in plugin.configSchema.properties,
      `${key} is documented in the manifest and must be accepted`,
    );
  }
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
  // The flywheel sub-app's complete route set, read from
  // MissionControl/mission_control/api/flywheel.py (@app decorators) plus the
  // policy router it mounts (api/policy_current.py:453,493). Vendored as a
  // list because this package must not import the control plane — the same
  // reason schema/flywheel-1.json is a copy — and asserted here so a new
  // transport method calling a route that does not exist is caught at test
  // time rather than as a 404 in a customer's process.
  //
  // `POST /rollouts/{id}/artifacts` was such a method. It shipped, it was
  // tested against a stub, and the route has never existed.
  const SERVED = new Set([
    "GET /health",
    "POST /agents",
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

  assert.ok(calls.length >= 8, `expected the transport's calls, found ${calls.length}`);
  const unserved = calls.filter((c) => !SERVED.has(c));
  assert.deepEqual(
    unserved, [],
    `transport calls routes the control plane does not serve: ${unserved.join(", ")}`,
  );
});
