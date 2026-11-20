import { testEnv } from "./support/home.js";
/**
 * The credentials store under concurrency, a hostile filesystem and a
 * foreign timestamp (ND-M5) -- the parts the device-flow tests in
 * login.test.js do not reach.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  CredentialsError, LOCK_FILENAME, LOCK_STALE_MS, credentialsPath, expired, loadStored,
  loginHint, parseTime, saveStored, shellQuote,
} from "../src/credentials.js";

const CP = "https://cp.test/api/flywheel/v1";
const cred = (agent) => ({
  control_plane_url: CP, agent_id: agent, api_key: `pefw_${agent}`,
  created_at: "2026-01-01T00:00:00Z", expires_at: null,
});

describe("the credentials store", () => {
  it("loses no login's key when several write at once", async () => {
    // Read-modify-write with no lock: two logins each read the file, each
    // added its own key, and the second rename dropped the first one's.
    const env = testEnv();
    const module = new URL("../src/credentials.js", import.meta.url).href;
    const writers = 6;
    const script = `
      const { saveStored } = await import(${JSON.stringify(module)});
      const me = process.argv[1];
      for (let i = 0; i < 15; i += 1) {
        saveStored({ control_plane_url: ${JSON.stringify(CP)}, agent_id: me + "-" + i,
          api_key: "pefw_x", created_at: null, expires_at: null }, process.env);
      }`;
    await Promise.all(Array.from({ length: writers }, (_, w) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, `w${w}`], {
        env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"],
      });
      let err = "";
      child.stderr.on("data", (d) => { err += d; });
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err))));
    })));
    const agents = loadStored(env).map((c) => c.agent_id);
    assert.equal(agents.length, writers * 15, `lost ${writers * 15 - agents.length} keys`);
    assert.equal(existsSync(join(env.PERCEPTEYE_HOME, LOCK_FILENAME)), false,
      "the lock was left behind");
  });

  it("takes over a lock left by a process that died holding it", () => {
    const env = testEnv();
    const lock = join(env.PERCEPTEYE_HOME, LOCK_FILENAME);
    writeFileSync(lock, "99999\n");
    const old = (Date.now() - LOCK_STALE_MS - 5_000) / 1000;
    utimesSync(lock, old, old);
    saveStored(cred("a"), env);
    assert.deepEqual(loadStored(env).map((c) => c.agent_id), ["a"]);
  });

  it("keeps the directory that holds keys 0700", (t) => {
    if (process.platform === "win32") return t.skip("no POSIX modes");
    const env = testEnv();
    chmodSync(env.PERCEPTEYE_HOME, 0o755);
    saveStored(cred("a"), env);
    assert.equal(statSync(env.PERCEPTEYE_HOME).mode & 0o777, 0o700);
  });

  it("names a filesystem failure instead of throwing a raw one", () => {
    const env = testEnv();
    const file = join(env.PERCEPTEYE_HOME, "not-a-dir");
    writeFileSync(file, "");
    assert.throws(() => saveStored(cred("a"), { PERCEPTEYE_HOME: file }),
      (err) => err instanceof CredentialsError && err.message.includes(file));
  });

  it("refuses a file whose credentials are not a list, rather than overwrite it", () => {
    const env = testEnv();
    const path = credentialsPath(env);
    mkdirSync(env.PERCEPTEYE_HOME, { recursive: true });
    const body = JSON.stringify({ version: 1, credentials: { a: 1 } });
    writeFileSync(path, body);
    assert.throws(() => saveStored(cred("a"), env), CredentialsError);
    assert.equal(readFileSync(path, "utf8"), body);
  });

  it("reads an expires_at with no offset as UTC, as the Python SDK does", () => {
    const tz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      assert.equal(parseTime("2026-01-01T00:00:00"), Date.UTC(2026, 0, 1));
      const at = Date.UTC(2026, 0, 1);
      assert.equal(expired({ expires_at: "2026-01-01T00:00:00" }, at - 1), false);
      assert.equal(expired({ expires_at: "2026-01-01T00:00:00" }, at), true);
    } finally {
      if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
    }
    assert.equal(parseTime("2026-01-01T02:00:00+02:00"), Date.UTC(2026, 0, 1));
    assert.equal(parseTime("2026-01-01T00:00:00.123456Z"), Date.UTC(2026, 0, 1) + 123);
  });

  it("treats an expires_at it cannot read as passed", () => {
    for (const bad of ["garbage", "2026-02-30T00:00:00Z", "tomorrow"]) {
      assert.equal(expired({ expires_at: bad }, 0), true, bad);
    }
    assert.equal(expired({ expires_at: null }, Date.now()), false);
  });

  it("quotes an agent id in the command it tells a person to paste", () => {
    assert.equal(shellQuote("my-agent.1"), "my-agent.1");
    assert.equal(shellQuote("a b"), "'a b'");
    assert.equal(shellQuote("it's"), "'it'\"'\"'s'");
    assert.equal(shellQuote(""), "''");
    assert.match(loginHint("$(touch /tmp/x)"), /--agent-id '\$\(touch \/tmp\/x\)'`/);
  });
});
