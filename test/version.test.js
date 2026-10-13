/**
 * One version, three places that publish it.
 *
 * `package.json` is what npm installs, `openclaw.plugin.json` is what
 * `openclaw plugins list` and `doctor` print (the host reads the manifest, not
 * the package), and `X-Percepteye-Sdk` is what the control plane files a bug
 * report against. They were three hand-typed copies of "0.1.0" with nothing
 * holding them equal, so `npm version patch` would have moved exactly one.
 *
 * The user-agent copy is now DERIVED (src/http.js reads package.json), which
 * is the mechanism. The manifest's copy cannot be -- the host parses it as
 * static JSON before any code runs -- so this test is its mechanism.
 *
 * The DESCRIPTION is the same situation one field over, and it had already
 * drifted, so it is held here too.
 */
import "./support/home.js";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { SDK_UA, SDK_VERSION } from "../src/http.js";

const read = (name) =>
  JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));

const pkg = read("package.json");
const manifest = read("openclaw.plugin.json");

describe("the package version has one source", () => {
  it("is a version at all", () => {
    assert.match(pkg.version, /^\d+\.\d+\.\d+/);
  });

  it("is what the OpenClaw manifest publishes to `plugins list`", () => {
    assert.equal(
      manifest.version,
      pkg.version,
      "openclaw.plugin.json.version must equal package.json.version -- the " +
      "host reports the manifest's, so a customer would read the version " +
      "they did not install",
    );
  });

  it("is what every request tells the control plane", () => {
    assert.equal(SDK_VERSION, pkg.version);
    assert.equal(SDK_UA, `agent-flywheel-node/${pkg.version}`);
  });

  it("the two hand-typed descriptions are the SAME description", () => {
    // The same defect one field over, and it had already opened: the manifest
    // said production mode "does capture the turns you serve and apply your
    // approved system prompt" while package.json still said "an observe-only
    // install", which stopped being true two features ago. npm shows one and
    // `openclaw plugins list` shows the other, so a customer reads whichever
    // copy nobody remembered to edit. Nothing held them equal; this does.
    assert.equal(
      manifest.description,
      pkg.description,
      "openclaw.plugin.json.description must equal package.json.description " +
      "-- they are two copies of one sentence and they had already diverged",
    );
  });

  it("is derived, not retyped, in the user agent", () => {
    // The assertion above is satisfied by a hard-coded literal for as long as
    // nobody bumps the version -- which is precisely the window in which the
    // defect is invisible. So assert the DERIVATION: the shipped source must
    // not contain a version literal at all.
    const source = readFileSync(new URL("../src/http.js", import.meta.url), "utf8");
    const ua = source.match(/^\s*export const SDK_UA =.*$/m)?.[0];
    assert.ok(ua, "SDK_UA is no longer declared where this test can read it");
    assert.doesNotMatch(
      ua,
      /\d+\.\d+\.\d+/,
      "SDK_UA carries a hard-coded version; derive it from package.json",
    );
  });
});
