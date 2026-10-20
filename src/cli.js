#!/usr/bin/env node
/**
 * `npx @percepteye/agent-flywheel <command>` -- the one thing this package
 * does from a terminal: give an agent its PerceptEye key.
 *
 *   login  [--agent-id ID] [--control-plane-url URL] [--no-browser]
 *   logout [--agent-id ID] [--control-plane-url URL]
 *
 * The agent id and control plane default exactly as the plugin resolves them
 * (`resolveConfig`: PERCEPTEYE_AGENT_ID, else `openclaw`; then
 * PERCEPTEYE_CONTROL_PLANE_URL, else the hosted control plane), so the key
 * `login` stores is the one the plugin looks for. The plugin itself never
 * prompts: it runs inside a gateway with no terminal, and reads the stored key
 * when the gateway next starts.
 */
import { realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "./config.js";
import { CredentialsError, credentialsPath, removeStored } from "./credentials.js";
import { LoginError, deviceLogin } from "./login.js";

const USAGE =
  "usage: npx @percepteye/agent-flywheel login  [--agent-id ID] " +
  "[--control-plane-url URL] [--no-browser]\n" +
  "       npx @percepteye/agent-flywheel logout [--agent-id ID] " +
  "[--control-plane-url URL]\n";

/**
 * Run one command. Resolves to the exit code; never calls `process.exit`
 * itself, so it can be driven by a test.
 */
export async function main(argv, {
  env = process.env, stdout = process.stdout, stderr = process.stderr,
  login = deviceLogin,
} = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        "agent-id": { type: "string" },
        "control-plane-url": { type: "string" },
        "no-browser": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    stderr.write(`agent-flywheel: ${err.message}\n${USAGE}`);
    return 2;
  }
  const [command] = parsed.positionals;
  if (parsed.values.help || !command) {
    (command ? stdout : stderr).write(USAGE);
    return command ? 0 : 2;
  }
  if (command !== "login" && command !== "logout") {
    stderr.write(`agent-flywheel: unknown command ${JSON.stringify(command)}\n${USAGE}`);
    return 2;
  }

  let config;
  try {
    // The plugin's own resolution of the agent id and control plane, so the
    // key lands where the plugin will look for it.
    config = resolveConfig({
      ...(parsed.values["agent-id"] ? { agentId: parsed.values["agent-id"] } : {}),
      ...(parsed.values["control-plane-url"]
        ? { controlPlaneUrl: parsed.values["control-plane-url"] } : {}),
      mode: "production",
    }, env);
  } catch (err) {
    stderr.write(`agent-flywheel: ${err.message}\n`);
    return 2;
  }
  const { agentId, controlPlaneUrl } = config;

  if (command === "logout") {
    try {
      if (!removeStored(controlPlaneUrl, agentId, env)) {
        stdout.write(
          `agent-flywheel: no key is stored for agent ${JSON.stringify(agentId)} ` +
          `on ${controlPlaneUrl} in ${credentialsPath(env)}.\n`,
        );
        return 0;
      }
    } catch (err) {
      if (!(err instanceof CredentialsError)) throw err;
      stderr.write(`agent-flywheel: ${err.message}\n`);
      return 1;
    }
    stdout.write(
      `agent-flywheel: forgot the key stored for agent ${JSON.stringify(agentId)} ` +
      `(${credentialsPath(env)}). The key itself stays valid until it is ` +
      "revoked in Mission Control (Settings).\n",
    );
    return 0;
  }

  try {
    await login({
      agentId, controlPlaneUrl, env, out: stderr,
      browser: !parsed.values["no-browser"],
    });
  } catch (err) {
    if (!(err instanceof LoginError) && !(err instanceof CredentialsError)) throw err;
    stderr.write(`agent-flywheel: ${err.message}\n`);
    return 1;
  }
  stderr.write(
    `agent-flywheel: restart OpenClaw to use it -- the plugin reads ` +
    `the stored key for agent ${JSON.stringify(agentId)} when the gateway ` +
    "starts, whenever PERCEPTEYE_API_KEY and the plugin's apiKey are unset.\n",
  );
  return 0;
}

/** Is this module the program being run? Through a symlink too: npx runs a
 *  bin from `node_modules/.bin`, a link to this file. */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Run when executed as the bin (npx, or `node src/cli.js`), not when imported.
if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(`agent-flywheel: ${err?.stack ?? err}\n`);
      process.exitCode = 1;
    },
  );
}
