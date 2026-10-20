/**
 * Every message a missing key causes says where a key comes from.
 *
 * They used to name only the variable: "set PERCEPTEYE_API_KEY". That says
 * what is missing and not where it comes from, and a developer who installed
 * the plugin and never opened the dashboard had no way to learn that a key is
 * one sign-up away. The message is read at the one moment the developer needs
 * the answer, so the answer is in it.
 *
 * The URL is the Python SDK's `SIGN_UP_URL` too, byte for byte; that
 * package's `tests/test_missing_key_names_sign_up.py` drives this module and
 * compares.
 */
import "./support/home.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createTurnCapture, registerTurnCapture } from "../src/capture.js";
import { GET_A_KEY, PLUGIN_ID, SIGN_UP_URL, resolveConfig } from "../src/config.js";
import { NO_KEY_REASON } from "../src/policy.js";
import { driveVerdict } from "../src/rollout.js";

describe("the sign-up link", () => {
  it("is on the default control plane's own origin", () => {
    const origin = new URL(resolveConfig({}, {}).controlPlaneUrl).origin;
    assert.equal(new URL(SIGN_UP_URL).origin, origin);
    assert.ok(GET_A_KEY.includes(SIGN_UP_URL));
  });

  it("is named when the approved pair cannot be read for want of a key", () => {
    assert.ok(NO_KEY_REASON.includes(SIGN_UP_URL), NO_KEY_REASON);
  });

  it("is named when training mode has no key to claim with", () => {
    const verdict = driveVerdict({ mode: "training", apiKey: null }, { config: {} }, PLUGIN_ID);
    assert.equal(verdict.canDrive, false);
    assert.ok(verdict.reason.includes(SIGN_UP_URL), verdict.reason);
  });

  it("is named in the production startup line when nothing can upload", () => {
    const root = mkdtempSync(join(tmpdir(), "pe-sign-up-"));
    try {
      const infos = [];
      const api = { on() {}, logger: { info: (m) => infos.push(m), warn() {} }, config: {} };
      registerTurnCapture(api, {
        config: { apiKey: undefined, agentId: "a1" },
        turns: createTurnCapture({ root }),
        pluginId: PLUGIN_ID,
        logger: api.logger,
        env: { PERCEPTEYE_CAPTURE_DIR: root },
        makeTransport: () => null,
      });
      assert.ok(infos.some((l) => l.includes("No API key is configured")
        && l.includes(SIGN_UP_URL)), infos.join(" | "));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
