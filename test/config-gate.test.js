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
