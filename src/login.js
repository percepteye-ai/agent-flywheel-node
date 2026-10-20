/**
 * `npx @percepteye/agent-flywheel login`: get an agent a key without leaving
 * the terminal.
 *
 * The control plane's device login (RFC 8628) with the `flywheel-agent`
 * scope, owner ruling 2026-10-20 -- the same flow, endpoint and stored file as
 * the Python SDK's `agent-flywheel login`:
 *
 *  1. `POST /api/v2/auth/device/code` names this SDK (`agent-flywheel-node`)
 *     and the agent; the control plane answers a short code and a link.
 *  2. The person opens the link -- the browser is opened for them -- signs up
 *     or signs in, sees which program is asking, for which agent, and the code
 *     to compare, and clicks Approve. Nothing on the page shows a secret.
 *  3. This polls `POST /api/v2/auth/device/token` at the interval it is given
 *     until the approval lands, then receives a `pefw_` key bound to that one
 *     agent and stores it (`credentials.js`).
 *
 * The plugin itself never asks: it runs inside a gateway with no terminal of
 * its own. It reads the stored key the next time the gateway starts.
 */
import { spawn } from "node:child_process";
import { saveStored } from "./credentials.js";
import { SDK_UA } from "./http.js";
import { productionAgentIdentifier } from "./wire.js";

/** Who this SDK is to the device login; the approval page names it. */
export const CLIENT_ID = "agent-flywheel-node";
/** The one scope this client may ask for: a key bound to one agent. */
export const SCOPE = "flywheel-agent";
export const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/** Where the person creates a key by hand when device login is not offered. */
export const SIGN_UP_URL = "https://launch.percepteye.ai/signup";

const FLYWHEEL_SUFFIX = "/api/flywheel/v1";
const DEVICE_PATH = "/api/v2/auth/device";
/** RFC 8628 section 3.5: `slow_down` adds five seconds to the interval. */
const SLOW_DOWN_STEP_S = 5;
/** Cap on the wait between retries of a poll that could not connect. */
const MAX_RETRY_WAIT_S = 30;

export class LoginError extends Error {
  constructor(message) {
    super(message);
    this.name = "LoginError";
  }
}

/**
 * Where the device login is for the control plane at `controlPlaneUrl`: beside
 * the Flywheel API (`.../api/flywheel/v1` -> `.../api/v2/auth/device`), or at
 * the URL's origin when it is mounted elsewhere. The Python SDK's
 * `device_endpoint`, case for case.
 */
export function deviceEndpoint(controlPlaneUrl) {
  const url = new URL(String(controlPlaneUrl).trim());
  const path = url.pathname.replace(/\/+$/, "");
  const prefix = path.endsWith(FLYWHEEL_SUFFIX)
    ? path.slice(0, -FLYWHEEL_SUFFIX.length)
    : "";
  return `${url.protocol}//${url.host}${prefix}${DEVICE_PATH}`;
}

/**
 * Would opening a browser put a page in front of this person? Not over SSH,
 * and not on a Linux with no display.
 */
export function canOpenBrowser(env = process.env, platform = process.platform) {
  if (env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (platform === "linux" && !(env.DISPLAY || env.WAYLAND_DISPLAY)) return false;
  return true;
}

/** Open `url` in the person's browser; true if a launcher was started. */
export function openBrowser(url, platform = process.platform) {
  const [cmd, args] =
    platform === "darwin" ? ["open", [url]]
      : platform === "win32" ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function oauthError(response) {
  let body = {};
  try {
    body = await response.json();
  } catch { /* not JSON */ }
  if (body === null || typeof body !== "object") body = {};
  return {
    error: String(body.error ?? `http_${response.status}`),
    description: String(body.error_description ?? ""),
    interval: Number.isFinite(body.interval) ? body.interval : null,
  };
}

const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Run the device login for `agentId` and store the key it returns.
 *
 * Writes what the person needs to do to `out` (stderr by default) and resolves
 * to the stored entry. Rejects with a `LoginError` naming why when no key came
 * back: denied, expired, a control plane that does not offer this client.
 *
 * @param {object} opts
 * @param {string} opts.agentId
 * @param {string} opts.controlPlaneUrl
 * @param {object} [opts.env]
 * @param {{write: Function}} [opts.out]
 * @param {Function} [opts.fetchImpl]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {() => number} [opts.now]   milliseconds
 * @param {boolean} [opts.browser]    false prints the link only
 * @param {(url: string) => boolean} [opts.open]
 */
export async function deviceLogin({
  agentId, controlPlaneUrl, env = process.env, out = process.stderr,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now, browser = true, open = null,
}) {
  if (productionAgentIdentifier(agentId) === null) {
    throw new LoginError(
      `agent id ${JSON.stringify(agentId)} is not one an agent can register as: ` +
      "1-255 characters, no control characters, no leading or trailing " +
      "whitespace, no '/' or '\\', and not '.' or '..'",
    );
  }
  const base = deviceEndpoint(controlPlaneUrl);
  const headers = {
    "User-Agent": SDK_UA,
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  };
  const say = (line = "") => out.write(`${line}\n`);
  const post = (path, form) => fetchImpl(`${base}${path}`, {
    method: "POST", headers, body: new URLSearchParams(form).toString(),
  });

  let started;
  try {
    const response = await post("/code", {
      client_id: CLIENT_ID, scope: SCOPE, agent_id: agentId,
    });
    if (!response.ok) {
      const { error, description } = await oauthError(response);
      if (error === "invalid_client" || error === "invalid_scope" || response.status === 404) {
        throw new LoginError(
          `the control plane at ${controlPlaneUrl} does not offer device login ` +
          `for this SDK (${description || error}). Create a key in the ` +
          `dashboard instead (${SIGN_UP_URL}) and set PERCEPTEYE_API_KEY.`,
        );
      }
      throw new LoginError(`the control plane refused the login: ${description || error}`);
    }
    started = await response.json();
  } catch (err) {
    if (err instanceof LoginError) throw err;
    throw new LoginError(`could not reach the control plane at ${base}: ${err?.message ?? err}`);
  }

  const deviceCode = String(started.device_code);
  const link = String(started.verification_uri_complete ?? started.verification_uri);
  let interval = Math.max(1, Number(started.interval) || 5);
  const expiresIn = Math.max(1, Number(started.expires_in) || 600);
  const deadline = now() + expiresIn * 1000;

  say(`To connect ${agentId} to PerceptEye, approve this code in your browser:`);
  say();
  say(`    ${started.user_code}`);
  say();
  let opened = false;
  if (browser && (open !== null || canOpenBrowser(env))) {
    try {
      opened = Boolean((open ?? openBrowser)(link));
    } catch {
      opened = false;
    }
  }
  say(`${opened ? "Opened" : "Open"} ${link}`);
  say("Sign up or sign in there, check the code matches, and click Approve.");
  say(
    `Waiting for approval (the code expires in ${Math.floor(expiresIn / 60)} ` +
    "min; Ctrl-C to cancel)...",
  );

  let wait = interval;
  let token;
  for (;;) {
    await sleep(wait * 1000);
    if (now() >= deadline) {
      throw new LoginError("the code expired before it was approved; run login again");
    }
    let polled;
    try {
      polled = await post("/token", {
        grant_type: GRANT_TYPE, device_code: deviceCode, client_id: CLIENT_ID,
      });
    } catch {
      // Unreachable for a moment is not a refusal: keep the code alive and
      // try again, slower, until it expires.
      wait = Math.min(MAX_RETRY_WAIT_S, wait * 2);
      continue;
    }
    if (polled.ok) {
      token = await polled.json();
      break;
    }
    const { error, description, interval: told } = await oauthError(polled);
    if (error === "authorization_pending") {
      wait = interval;
      continue;
    }
    if (error === "slow_down") {
      interval = told ?? interval + SLOW_DOWN_STEP_S;
      wait = interval;
      continue;
    }
    if (error === "access_denied") {
      throw new LoginError("the login was denied in the browser; no key was issued");
    }
    if (error === "expired_token") {
      throw new LoginError("the code expired before it was approved; run login again");
    }
    if (polled.status >= 500 || polled.status === 429) {
      wait = Math.min(MAX_RETRY_WAIT_S, Math.max(interval, wait * 2));
      continue;
    }
    throw new LoginError(`no key was issued: ${description || error}`);
  }

  const key = typeof token?.access_token === "string" ? token.access_token : "";
  if (!key) throw new LoginError("the control plane approved the login but sent no key");
  const at = Math.floor(now() / 1000) * 1000;
  const cred = {
    control_plane_url: controlPlaneUrl,
    agent_id: typeof token.agent_id === "string" && token.agent_id ? token.agent_id : agentId,
    api_key: key,
    org_id: token.org_id ?? null,
    org_name: token.org_name ?? null,
    key_id: token.flywheel_key_id ?? null,
    created_at: isoSeconds(at),
    expires_at: Number.isFinite(token.expires_in)
      ? isoSeconds(at + token.expires_in * 1000)
      : null,
    client: SDK_UA,
  };
  const path = saveStored(cred, env);
  say(
    `Approved: a key for ${cred.agent_id}${cred.org_name ? ` in ${cred.org_name}` : ""}, ` +
    `saved to ${path}.`,
  );
  return { ...cred, path };
}
