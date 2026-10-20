import { testEnv, testHome } from "./support/home.js";
/**
 * `npx @percepteye/agent-flywheel login`: a key for one agent, without
 * leaving the terminal -- and the plugin finding it on its next start.
 *
 * What each test pins, and the defect it exists to catch:
 *
 *  - THE DEVICE FLOW against the control plane's own error vocabulary: the
 *    code and link are shown, the interval honoured (`slow_down` raises it for
 *    every later poll), and the key that comes back is stored for (control
 *    plane, agent) in a 0600 file. Denied, expired and a control plane that
 *    does not offer this client each end in a sentence naming the cause, and
 *    nothing stored.
 *  - ONE RULE FOR WHICH KEY: config `apiKey`, then PERCEPTEYE_API_KEY, then
 *    the key stored for THIS agent on THIS control plane -- never another
 *    agent's, never an expired one.
 *  - `register` USES A STORED KEY AND SAYS SO, once, naming the file.
 *  - NO BODY CARRIES A KEY (owner ruling R2b).
 *  - THE BIN resolves the agent and control plane as the plugin does, so the
 *    key lands where the plugin looks for it.
 */
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveConfig } from "../src/config.js";
import {
  CredentialsError, credentialsPath, loadStored, removeStored, saveStored,
  storedKeyFor,
} from "../src/credentials.js";
import { ControlPlaneClient, REDACTED_KEY } from "../src/http.js";
import { deviceEndpoint, deviceLogin, LoginError } from "../src/login.js";
import { main } from "../src/cli.js";
import { register } from "../src/index.js";

const CP = "https://cp.test/api/flywheel/v1";
const DEVICE = "https://cp.test/api/v2/auth/device";
const AGENT = "my-agent";
const KEY = `pefw_${"K".repeat(43)}`;

function sink() {
  const chunks = [];
  return { write: (c) => { chunks.push(String(c)); return true; }, text: () => chunks.join("") };
}

/** A scripted device-login half of a control plane. */
function controlPlane(polls, { codeStatus = 200, codeBody = null, interval = 5 } = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(init.body));
    requests.push({ url, form, headers: init.headers });
    if (url.endsWith("/code")) {
      assert.equal(form.client_id, "agent-flywheel-node");
      assert.equal(form.scope, "flywheel-agent");
      if (codeStatus !== 200) return Response.json(codeBody ?? {}, { status: codeStatus });
      return Response.json({
        device_code: "dev-123", user_code: "BCDF-GHJK",
        verification_uri: "https://cp.test/device",
        verification_uri_complete: "https://cp.test/device#user_code=BCDF-GHJK",
        expires_in: 600, interval,
      });
    }
    assert.ok(url.endsWith("/token"));
    const step = polls.shift();
    if (step instanceof Error) throw step;
    return Response.json(step[1], { status: step[0] });
  };
  return { fetchImpl, requests };
}

const granted = (over = {}) => [200, {
  access_token: KEY, token_type: "Bearer", expires_in: 180 * 86400,
  scope: "flywheel-agent", org_id: "org-1", org_name: "Acme",
  agent_id: AGENT, flywheel_key_id: "key-1", ...over,
}];
const pending = () => [400, { error: "authorization_pending" }];

async function run(cp, opts = {}) {
  const out = sink();
  const sleeps = [];
  const opened = [];
  const env = opts.env ?? testEnv();
  const cred = await deviceLogin({
    agentId: opts.agentId ?? AGENT, controlPlaneUrl: CP, env, out,
    fetchImpl: cp.fetchImpl, sleep: async (ms) => { sleeps.push(ms / 1000); },
    now: () => 0, open: (url) => { opened.push(url); return true; },
  });
  return { cred, out: out.text(), sleeps, opened, env };
}

describe("the device flow", () => {
  it("finds the device login beside the Flywheel API, as the Python SDK does", () => {
    assert.equal(deviceEndpoint(CP), DEVICE);
    assert.equal(deviceEndpoint(`${CP}/`), DEVICE);
    assert.equal(deviceEndpoint("https://mc.example.com/prefix/api/flywheel/v1"),
      "https://mc.example.com/prefix/api/v2/auth/device");
    assert.equal(deviceEndpoint("https://mc.example.com/somewhere/else"),
      "https://mc.example.com/api/v2/auth/device");
  });

  it("shows the code, waits its interval, and stores the key 0600", async () => {
    const cp = controlPlane([
      pending(), [400, { error: "slow_down", interval: 10 }], pending(), granted(),
    ]);
    const { cred, out, sleeps, opened, env } = await run(cp);
    assert.match(out, /BCDF-GHJK/);
    assert.deepEqual(opened, ["https://cp.test/device#user_code=BCDF-GHJK"]);
    assert.deepEqual(sleeps, [5, 5, 10, 10]);
    assert.equal(cp.requests[0].url, `${DEVICE}/code`);
    assert.equal(cp.requests[0].form.agent_id, AGENT);
    assert.match(cp.requests[0].headers["User-Agent"], /^agent-flywheel-node\//);
    assert.equal(cred.api_key, KEY);

    const path = credentialsPath(env);
    assert.match(out, new RegExp(`saved to ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const doc = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(doc.version, 1);
    assert.equal(doc.credentials.length, 1);
    const [entry] = doc.credentials;
    assert.equal(entry.control_plane_url, CP);
    assert.equal(entry.agent_id, AGENT);
    assert.equal(entry.api_key, KEY);
    assert.equal(entry.key_id, "key-1");
    assert.match(entry.expires_at, /Z$/);
    assert.deepEqual(readdirSync(env.PERCEPTEYE_HOME).filter((f) => f.endsWith(".tmp")), []);
  });

  it("retries a poll that cannot reach the control plane", async () => {
    const { cred, sleeps } = await run(controlPlane([new TypeError("fetch failed"), granted()]));
    assert.equal(cred.api_key, KEY);
    assert.deepEqual(sleeps, [5, 10]);
  });

  for (const [step, said] of [
    [[400, { error: "access_denied" }], /denied/],
    [[400, { error: "expired_token" }], /expired/],
    [[400, { error: "invalid_grant", error_description: "no longer an admin" }], /no longer an admin/],
  ]) {
    it(`says why no key came back (${step[1].error}) and stores nothing`, async () => {
      const env = testEnv();
      await assert.rejects(run(controlPlane([step]), { env }), (err) =>
        err instanceof LoginError && said.test(err.message));
      assert.deepEqual(loadStored(env), []);
    });
  }

  it("names a control plane that does not offer this client", async () => {
    const cp = controlPlane([], { codeStatus: 400, codeBody: { error: "invalid_client" } });
    await assert.rejects(run(cp), /does not offer device login/);
  });

  it("refuses an agent id no agent could register as, before any request", async () => {
    for (const bad of ["", "a/b", " pad", "..", "x".repeat(256)]) {
      const cp = controlPlane([]);
      await assert.rejects(run(cp, { agentId: bad }), /agent id/);
      assert.deepEqual(cp.requests, []);
    }
  });
});

describe("which key", () => {
  const store = (env, over = {}) => saveStored({
    control_plane_url: CP, agent_id: AGENT, api_key: KEY,
    expires_at: "2999-01-01T00:00:00Z", ...over,
  }, env);

  it("config apiKey, then PERCEPTEYE_API_KEY, then the stored key", () => {
    const env = testEnv({ PERCEPTEYE_CONTROL_PLANE_URL: CP, PERCEPTEYE_AGENT_ID: AGENT });
    store(env);
    const stored = loadStored(env);
    const fromConfig = resolveConfig({ apiKey: "pefw_cfg" }, { ...env, PERCEPTEYE_API_KEY: "pefw_env" }, stored);
    assert.deepEqual([fromConfig.apiKey, fromConfig.apiKeySource], ["pefw_cfg", "config"]);
    const fromEnv = resolveConfig({}, { ...env, PERCEPTEYE_API_KEY: "pefw_env" }, stored);
    assert.deepEqual([fromEnv.apiKey, fromEnv.apiKeySource], ["pefw_env", "environment"]);
    const fromStore = resolveConfig({}, env, stored);
    assert.deepEqual([fromStore.apiKey, fromStore.apiKeySource], [KEY, "stored"]);
    assert.equal(fromStore.contributing, true);
    // Nothing handed in: exactly the answer resolveConfig always gave.
    assert.equal(resolveConfig({}, env).apiKey, null);
  });

  it("opens only its own agent, on its own control plane, until it expires", () => {
    const env = testEnv();
    store(env);
    const stored = loadStored(env);
    assert.equal(storedKeyFor(stored, CP, "another").cred, null);
    assert.equal(storedKeyFor(stored, "https://other.test/api/flywheel/v1", AGENT).cred, null);
    assert.equal(storedKeyFor(stored, `${CP}/`, AGENT).cred.api_key, KEY);
    store(env, { expires_at: "2001-01-01T00:00:00Z" });
    const expired = storedKeyFor(loadStored(env), CP, AGENT);
    assert.equal(expired.cred, null);
    assert.match(expired.refusal, /expired on 2001-01-01/);
  });

  it("replaces that agent's key on a second login and keeps the others", () => {
    const env = testEnv();
    store(env, { api_key: "pefw_old" });
    store(env, { agent_id: "second", api_key: "pefw_second" });
    store(env);
    assert.deepEqual(
      loadStored(env).map((c) => [c.agent_id, c.api_key]).sort(),
      [[AGENT, KEY], ["second", "pefw_second"]],
    );
    assert.equal(removeStored(CP, AGENT, env), true);
    assert.equal(removeStored(CP, AGENT, env), false);
  });

  it("neither reads nor overwrites a file from a newer SDK", () => {
    const home = testHome();
    const env = { PERCEPTEYE_HOME: home };
    const newer = { version: 2, credentials: [{ control_plane_url: CP, agent_id: AGENT, api_key: KEY }] };
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "credentials.json"), JSON.stringify(newer));
    assert.throws(() => loadStored(env), (e) => e instanceof CredentialsError && /version 2/.test(e.message));
    assert.throws(() => store(env), /Upgrade/);
    assert.deepEqual(JSON.parse(readFileSync(join(home, "credentials.json"), "utf8")), newer);
  });
});

describe("the plugin uses a stored key, and says so", () => {
  const fakeApi = () => {
    const lines = [];
    return {
      lines, on() {},
      logger: { info: (m) => lines.push(m), warn: (m) => lines.push(m) },
    };
  };

  it("registers with the key login stored for its agent", () => {
    const env = testEnv({ PERCEPTEYE_CONTROL_PLANE_URL: CP, PERCEPTEYE_AGENT_MODE: "production" });
    saveStored({ control_plane_url: CP, agent_id: "openclaw", api_key: KEY }, env);
    const api = fakeApi();
    register(api, {}, env);
    const said = api.lines.filter((l) => l.includes("using the key stored for agent"));
    assert.equal(said.length, 1, api.lines.join("\n"));
    assert.ok(said[0].includes(credentialsPath(env)));
    assert.ok(said[0].includes("logout --agent-id openclaw"));
  });

  it("names an expired stored key and the command that replaces it", () => {
    const env = testEnv({ PERCEPTEYE_CONTROL_PLANE_URL: CP, PERCEPTEYE_AGENT_MODE: "production" });
    saveStored({
      control_plane_url: CP, agent_id: "openclaw", api_key: KEY,
      expires_at: "2001-01-01T00:00:00Z",
    }, env);
    const api = fakeApi();
    register(api, {}, env);
    assert.ok(api.lines.some((l) => /expired on 2001-01-01/.test(l) && /login --agent-id openclaw/.test(l)),
      api.lines.join("\n"));
    assert.ok(!api.lines.some((l) => l.includes("using the key stored")));
  });

  it("never reads the file when a key is already named or capture is off", () => {
    const env = testEnv({ PERCEPTEYE_CONTROL_PLANE_URL: CP, PERCEPTEYE_AGENT_MODE: "production" });
    mkdirSync(env.PERCEPTEYE_HOME, { recursive: true });
    writeFileSync(credentialsPath(env), "not json");
    for (const [config, extra] of [[{ apiKey: "pefw_cfg" }, {}], [{}, { PERCEPTEYE_CAPTURE: "0" }]]) {
      const api = fakeApi();
      register(api, config, { ...env, ...extra });
      assert.ok(!api.lines.some((l) => l.includes("ignoring stored keys")), api.lines.join("\n"));
    }
    const api = fakeApi();
    register(api, {}, env);
    assert.ok(api.lines.some((l) => l.includes("ignoring stored keys")), api.lines.join("\n"));
  });
});

describe("no body carries a key", () => {
  it("redacts every minted key and the client's own, whatever its shape", async () => {
    const sent = [];
    const envKey = "env-key-of-any-shape-0123456789";
    const client = new ControlPlaneClient(CP, envKey, {
      fetchImpl: async (url, init) => { sent.push(init.body); return Response.json({}); },
    });
    const other = `pefw_${"z".repeat(43)}`;
    await client.request("POST", "/rollouts/r1/report", {
      jsonBody: { output: `$ cat credentials.json\n${other}`, env: `PERCEPTEYE_API_KEY=${envKey}` },
    });
    assert.ok(!sent[0].includes(other));
    assert.ok(!sent[0].includes(envKey));
    const body = JSON.parse(sent[0]);
    assert.ok(body.output.endsWith(REDACTED_KEY));
    assert.equal(body.env, `PERCEPTEYE_API_KEY=${REDACTED_KEY}`);
  });
});

describe("the bin", () => {
  it("logs in for the plugin's own agent id and control plane by default", async () => {
    const env = testEnv({ PERCEPTEYE_CONTROL_PLANE_URL: CP });
    const calls = [];
    const err = sink();
    const code = await main(["login", "--no-browser"], {
      env, stdout: sink(), stderr: err,
      login: async (opts) => { calls.push(opts); return {}; },
    });
    assert.equal(code, 0);
    assert.equal(calls[0].agentId, "openclaw");
    assert.equal(calls[0].controlPlaneUrl, CP);
    assert.equal(calls[0].browser, false);
    assert.match(err.text(), /restart OpenClaw/);
  });

  it("forgets locally on logout, and says the key stays valid until revoked", async () => {
    const env = testEnv({ PERCEPTEYE_CONTROL_PLANE_URL: CP });
    saveStored({ control_plane_url: CP, agent_id: AGENT, api_key: KEY }, env);
    const out = sink();
    assert.equal(await main(["logout", "--agent-id", AGENT], { env, stdout: out, stderr: sink() }), 0);
    assert.match(out.text(), /forgot the key/);
    assert.match(out.text(), /revoked/);
    assert.deepEqual(loadStored(env), []);
  });

  it("exits non-zero with the cause when no key came back", async () => {
    const err = sink();
    const code = await main(["login", "--agent-id", AGENT], {
      env: testEnv(), stdout: sink(), stderr: err,
      login: async () => { throw new LoginError("the login was denied in the browser"); },
    });
    assert.equal(code, 1);
    assert.match(err.text(), /denied in the browser/);
  });

  it("refuses an unknown command and an invalid agent id", async () => {
    assert.equal(await main(["frobnicate"], { env: testEnv(), stdout: sink(), stderr: sink() }), 2);
    assert.equal(await main(["login", "--agent-id", "a/b"], { env: testEnv(), stdout: sink(), stderr: sink() }), 2);
  });
});
