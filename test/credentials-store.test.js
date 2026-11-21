import { testEnv } from "./support/home.js";
/**
 * The credentials store under concurrency, a hostile filesystem and a
 * foreign timestamp (ND-M5) -- the parts the device-flow tests in
 * login.test.js do not reach.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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
    const writers = 4;
    const script = `
      const { saveStored } = await import(${JSON.stringify(module)});
      const me = process.argv[1];
      for (let i = 0; i < 10; i += 1) {
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
    assert.equal(agents.length, writers * 10, `lost ${writers * 10 - agents.length} keys`);
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

  it("never removes a fresh lock another writer took meanwhile", (t) => {
    // Between judging a lock stale and renaming it aside, another writer
    // takes the stale lock over and creates a FRESH one; the rename then
    // moves the fresh lock. It must be put back, and this writer must wait
    // for it, not take the lock while the other believes it holds it. The
    // Python SDK's test_a_stale_takeover_never_removes_a_fresh_lock_taken_meanwhile.
    // Mutation: remove whatever was moved aside unchecked -> this writer
    // takes the lock at once and never sees the fresh one, red.
    const env = testEnv();
    const lock = join(env.PERCEPTEYE_HOME, LOCK_FILENAME);
    writeFileSync(lock, "99999 0 deadbeef\n");
    const old = (Date.now() - LOCK_STALE_MS - 5_000) / 1000;
    utimesSync(lock, old, old);
    const fresh = "4242 1 c0ffee\n";
    const { renameSync, statSync: realStat } = fs;
    let raced = false;
    let seen = null;
    fs.renameSync = (src, dst) => {
      if (src === lock && !raced) {
        raced = true;
        fs.unlinkSync(lock);
        writeFileSync(lock, fresh);
      }
      return renameSync(src, dst);
    };
    fs.statSync = (path, ...rest) => {
      if (raced && seen === null && path === lock) {
        // The next look at the lock after the takeover: record what holds
        // it, then let the other writer release it.
        seen = readFileSync(lock, "utf8");
        fs.unlinkSync(lock);
      }
      return realStat(path, ...rest);
    };
    syncBuiltinESMExports();
    t.after(() => {
      fs.renameSync = renameSync;
      fs.statSync = realStat;
      syncBuiltinESMExports();
    });
    saveStored(cred("a"), env);
    assert.equal(seen, fresh, "the other writer's fresh lock was removed");
    assert.deepEqual(loadStored(env).map((c) => c.agent_id), ["a"]);
    assert.deepEqual(
      readdirSync(env.PERCEPTEYE_HOME).filter((n) => n.includes(".stale-")), [],
      "left aside");
  });

  it("releases only a lock that still holds its own nonce", (t) => {
    // A writer whose lock was taken over (it outlived the stale age) must not
    // remove the next holder's on its way out. The Python SDK's
    // test_a_writer_releases_only_a_lock_that_still_holds_its_nonce.
    // Mutation: unlink the lock unchecked at release -> it is gone, red.
    const env = testEnv();
    const lock = join(env.PERCEPTEYE_HOME, LOCK_FILENAME);
    const theirs = "4242 1 c0ffee\n";
    const { renameSync } = fs;
    fs.renameSync = (src, dst) => {
      if (String(src).endsWith(".tmp")) {
        fs.unlinkSync(lock);
        writeFileSync(lock, theirs);
      }
      return renameSync(src, dst);
    };
    syncBuiltinESMExports();
    t.after(() => { fs.renameSync = renameSync; syncBuiltinESMExports(); });
    saveStored(cred("a"), env);
    assert.equal(readFileSync(lock, "utf8"), theirs);
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
