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
 *  2. The person opens the link -- the browser is opened for them when the
 *     link is a web page (`linkRefusal`) -- signs up
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
import { SIGN_UP_URL } from "./config.js";
import { CredentialsError, saveStored } from "./credentials.js";
import { SDK_UA } from "./http.js";
import { productionAgentIdentifier } from "./wire.js";

/** Who this SDK is to the device login; the approval page names it. */
export const CLIENT_ID = "agent-flywheel-node";
/** The one scope this client may ask for: a key bound to one agent. */
export const SCOPE = "flywheel-agent";
export const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/**
 * Where the person creates a key by hand when device login is not offered:
 * `config.js`'s, the one every other missing-key message names. This module
 * kept its own copy, and it went stale (`/signup`).
 */
export { SIGN_UP_URL };

const FLYWHEEL_SUFFIX = "/api/flywheel/v1";
const DEVICE_PATH = "/api/v2/auth/device";
/** RFC 8628 section 3.5: `slow_down` adds five seconds to the interval. */
const SLOW_DOWN_STEP_S = 5;
/** Cap on the wait between retries of a poll that could not connect. */
const MAX_RETRY_WAIT_S = 30;
/** Deadline on ONE request to the device endpoints, its body included. */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * ANSI escape sequences (CSI, OSC, and two-character ESC forms) and every
 * other C0/C1 control character. A string the control plane sends is printed
 * to the person's terminal; a server (or anything between) must not be able
 * to move the cursor, rewrite the code shown, set the window title, or plant a
 * hyperlink there. The Python SDK's `_TERMINAL_CONTROL`.
 */
const TERMINAL_CONTROL = new RegExp(
  "\\u001b\\[[0-?]*[ -/]*[@-~]"
  + "|\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)?"
  + "|\\u001b[@-_]"
  + "|[\\u0000-\\u001f\\u007f-\\u009f]",
  "g",
);

export class LoginError extends Error {
  constructor(message) {
    super(message);
    this.name = "LoginError";
  }
}

/** `text` with every terminal control sequence and control character
 * removed: what is safe to print of a string the control plane sent. */
export function printable(text) {
  return String(text).replace(TERMINAL_CONTROL, "");
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

const isLoopback = (host) => {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
};

/**
 * Why the login link the control plane sent must not be opened, or `null`
 * when it may. The Python SDK's `link_refusal`, refusal for refusal.
 *
 * The SCHEME is checked, not the origin: the control plane builds the link
 * from its public dashboard address (`MC_APP_BASE_URL`), which need not be the
 * API's host, so an origin match would refuse real logins. What a browser
 * hand-off must never get is a scheme that opens something other than a web
 * page (`file:`, `smb:`, an app's own handler): `https` always; `http` only
 * when the control plane is itself spoken to over `http` or the link is to
 * this machine. Any whitespace or control character is refused outright -- no
 * real link carries one, and a launcher may split on it.
 */
export function linkRefusal(link, controlPlaneUrl) {
  if (typeof link !== "string" || /[\s\u0000-\u001f\u007f-\u009f]/u.test(link)) {
    return "it contains whitespace or a control character";
  }
  let url;
  try {
    url = new URL(link);
  } catch {
    return "it is not a URL";
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "https" && scheme !== "http") {
    return `its scheme ${JSON.stringify(scheme || "(none)")} is not a web page (https)`;
  }
  if (!url.hostname) return "it names no host";
  if (scheme === "http") {
    let plane = "";
    try { plane = new URL(String(controlPlaneUrl).trim()).protocol; } catch { /* none */ }
    if (plane !== "http:" && !isLoopback(url.hostname)) {
      return "it is plain http to another machine while the control plane is " +
        "spoken to over https";
    }
  }
  return null;
}

/**
 * Open `url` in the person's browser; true if a launcher was started.
 *
 * NO SHELL ANYWHERE. Windows used `cmd /c start "" <url>`, and cmd reads `&`,
 * `|`, `^` and `%VAR%` in its arguments: a link's own query string
 * (`?a=1&b=2`) was cut at the `&` and the rest run as a command. Windows now
 * hands the URL to `rundll32 url.dll,FileProtocolHandler`, an executable,
 * with no shell. macOS `open` takes `--` before it, so the URL can never be
 * read as an option. `xdg-open` refuses `--` (it reports any argument starting
 * with `-` as an unexpected option), so on Linux the URL goes alone -- which
 * is safe only because nothing reaches here that is not an `http(s)://` URL
 * free of whitespace and control characters: this refuses anything else
 * itself, whoever calls it.
 */
export function openBrowser(url, platform = process.platform, spawnImpl = spawn) {
  if (typeof url !== "string" || !/^https?:\/\/[^\s\u0000-\u001f\u007f-\u009f]+$/iu.test(url)) {
    return false;
  }
  const [cmd, args] =
    platform === "darwin" ? ["open", ["--", url]]
      : platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawnImpl(cmd, args, { stdio: "ignore", detached: true, shell: false });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** A response body as JSON, or `null` when it is not JSON at all. */
async function jsonOf(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function oauthError(response) {
  let body = await jsonOf(response);
  if (body === null || typeof body !== "object" || Array.isArray(body)) body = {};
  const told = body.interval;
  return {
    error: printable(body.error ?? `http_${response.status}`),
    description: printable(body.error_description ?? ""),
    interval: typeof told === "number" && Number.isFinite(told) && told >= 1
      ? Math.floor(told) : null,
  };
}

/** A JSON object answer, or a `LoginError` naming `what` was not one. */
async function jsonObject(response, what) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new LoginError(`the control plane's ${what} was not JSON`);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new LoginError(`the control plane's ${what} was not a JSON object`);
  }
  return body;
}

/** A string field of an answer, or a `LoginError` naming it. */
function textField(body, name, what, { required }) {
  const value = body[name];
  if ((value === undefined || value === null) && !required) return null;
  if (typeof value !== "string" || !value) {
    throw new LoginError(
      `the control plane's ${what} has no usable ${JSON.stringify(name)} ` +
      `(got ${printable(JSON.stringify(value) ?? String(value)).slice(0, 80)})`,
    );
  }
  return value;
}

/** Whole seconds from an answer, `null` when absent, or a `LoginError` for
 * anything that is not a finite positive number. */
function secondsField(body, name, what) {
  const value = body[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || !(value > 0)) {
    throw new LoginError(
      `the control plane's ${what} has an unusable ${JSON.stringify(name)} ` +
      `(got ${printable(JSON.stringify(value) ?? String(value)).slice(0, 80)})`,
    );
  }
  return Math.floor(value);
}

const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Run the device login for `agentId` and store the key it returns.
 *
 * Writes what the person needs to do to `out` (stderr by default) and resolves
 * to the stored entry. Rejects with a `LoginError` naming why when no key came
 * back: denied, expired, a control plane that does not offer this client, an
 * answer that is not what the device flow sends, a key for another agent, a
 * file that could not be written.
 *
 * Every string the control plane sent is printed with its terminal control
 * removed (`printable`), and the link is opened only if `linkRefusal` allows
 * it; a refused link is printed with the reason and not opened.
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
 * @param {number} [opts.timeoutMs]   per-request deadline
 */
export async function deviceLogin({
  agentId, controlPlaneUrl, env = process.env, out = process.stderr,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now, browser = true, open = null, timeoutMs = REQUEST_TIMEOUT_MS,
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
  // ONE deadline per request, covering its body: a control plane that
  // accepted the connection and never answered held the login forever.
  const post = (path, form) => fetchImpl(`${base}${path}`, {
    method: "POST", headers, body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const what = "device code answer";

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
    started = await jsonObject(response, what);
  } catch (err) {
    if (err instanceof LoginError) throw err;
    throw new LoginError(`could not reach the control plane at ${base}: ${err?.message ?? err}`);
  }

  const deviceCode = textField(started, "device_code", what, { required: true });
  const userCode = printable(textField(started, "user_code", what, { required: true }));
  const link = textField(started, "verification_uri_complete", what, { required: false })
    ?? textField(started, "verification_uri", what, { required: true });
  let interval = Math.max(1, secondsField(started, "interval", what) ?? 5);
  const expiresIn = secondsField(started, "expires_in", what) ?? 600;
  const deadline = now() + expiresIn * 1000;

  say(`To connect ${agentId} to PerceptEye, approve this code in your browser:`);
  say();
  say(`    ${userCode}`);
  say();
  const refused = linkRefusal(link, controlPlaneUrl);
  const shown = printable(link);
  let opened = false;
  if (refused === null && browser && (open !== null || canOpenBrowser(env))) {
    try {
      opened = Boolean((open ?? openBrowser)(link));
    } catch {
      opened = false;
    }
  }
  if (refused !== null) {
    say(`The control plane sent a login link this SDK will not open (${refused}): ${shown}`);
  } else {
    say(`${opened ? "Opened" : "Open"} ${shown}`);
  }
  say("Sign up or sign in there, check the code matches, and click Approve.");
  say(
    `Waiting for approval (the code expires in ${Math.floor(expiresIn / 60)} ` +
    "min; Ctrl-C to cancel)...",
  );

  const expired = () => new LoginError("the code expired before it was approved; run login again");
  let wait = interval;
  let token;
  for (;;) {
    // Never sleep past the code's life: a long `slow_down` or retry wait
    // would otherwise hold the person past an expiry already due.
    const remaining = deadline - now();
    if (remaining <= 0) throw expired();
    await sleep(Math.min(wait * 1000, remaining));
    if (now() >= deadline) throw expired();
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
      try {
        token = await jsonObject(polled, "token answer");
      } catch (err) {
        if (err instanceof LoginError) throw err;
        throw new LoginError(`the control plane's token answer could not be read: ${err?.message ?? err}`);
      }
      break;
    }
    const { error, description, interval: told } = await oauthError(polled);
    if (error === "authorization_pending") {
      wait = interval;
      continue;
    }
    if (error === "slow_down") {
      // Never below one second: an `interval` of 0 spun this loop.
      interval = Math.max(1, told ?? interval + SLOW_DOWN_STEP_S);
      wait = interval;
      continue;
    }
    if (error === "access_denied") {
      throw new LoginError("the login was denied in the browser; no key was issued");
    }
    if (error === "expired_token") throw expired();
    if (polled.status >= 500 || polled.status === 429) {
      wait = Math.min(MAX_RETRY_WAIT_S, Math.max(interval, wait * 2));
      continue;
    }
    throw new LoginError(`no key was issued: ${description || error}`);
  }

  const tokenWhat = "token answer";
  const key = typeof token.access_token === "string" ? token.access_token : "";
  if (!key.trim()) throw new LoginError("the control plane approved the login but sent no key");
  const grantedTo = textField(token, "agent_id", tokenWhat, { required: false });
  if (grantedTo !== null && grantedTo !== agentId) {
    // Stored under the agent the server NAMED, it would silently replace
    // another agent's key; under the one asked for, it would be a key that
    // opens a different agent. Neither: refuse it.
    throw new LoginError(
      `the control plane issued a key for agent ${JSON.stringify(printable(grantedTo))}, ` +
      `not the ${JSON.stringify(agentId)} this login asked for; nothing was stored`,
    );
  }
  const expiresInKey = secondsField(token, "expires_in", tokenWhat);
  const at = Math.floor(now() / 1000) * 1000;
  const expiresAtMs = expiresInKey === null ? null : at + expiresInKey * 1000;
  if (expiresAtMs !== null && !Number.isFinite(new Date(expiresAtMs).getTime())) {
    throw new LoginError(
      `the control plane's ${tokenWhat} has an unusable "expires_in" (${expiresInKey})`);
  }
  const cred = {
    control_plane_url: controlPlaneUrl,
    agent_id: agentId,
    api_key: key,
    org_id: textField(token, "org_id", tokenWhat, { required: false }),
    org_name: textField(token, "org_name", tokenWhat, { required: false }),
    key_id: textField(token, "flywheel_key_id", tokenWhat, { required: false }),
    created_at: isoSeconds(at),
    expires_at: expiresAtMs === null ? null : isoSeconds(expiresAtMs),
    client: SDK_UA,
  };
  let path;
  try {
    path = saveStored(cred, env);
  } catch (err) {
    if (err instanceof CredentialsError) {
      throw new LoginError(`the key was issued but could not be stored: ${err.message}`);
    }
    throw err;
  }
  say(
    `Approved: a key for ${cred.agent_id}` +
    `${cred.org_name ? ` in ${printable(cred.org_name)}` : ""}, saved to ${path}.`,
  );
  return { ...cred, path };
}
