/**
 * The one HTTP client, with retry semantics that READ THE RESPONSE.
 *
 * A port of `percepteye_agent_flywheel/_http.py`, kept deliberately
 * line-for-line in behaviour because the two are one contract with one server.
 * Its docstring records what it was written against: a previous SDK whose
 * retry helper returned the response without reading its status -- so a 503
 * was indistinguishable from success -- and whose only recovery from an
 * unexpected error was a blanket sleep inside a bare `except` that also
 * swallowed real bugs.
 *
 * Zero dependencies. `fetch` and `AbortController` are builtins in Node 22+,
 * which `engines` already requires, so this adds nothing to a customer's tree.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CONTRACT_VERSION } from "./wire.js";
import { LeaseLost, TransportError } from "./errors.js";

/** Transient. Retry these, honouring Retry-After when present. */
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Node's fetch rejects with a TypeError whose `cause.code` names the syscall
 * failure. These are the codes where the connection was NEVER ESTABLISHED, so
 * the server cannot have seen the request.
 *
 * A TIMEOUT IS NOT IN THIS SET, and that is the whole point of the
 * distinction: a read timeout may have been fully processed by the server, so
 * resending it performs the operation twice. Python names the same split with
 * `_NEVER_SENT = (httpx.ConnectError, httpx.ConnectTimeout)`.
 */
const NEVER_SENT_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET",
  "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL",
]);

/**
 * ONE version, read from the file npm publishes it in.
 *
 * This was a hand-typed literal beside two other copies of the same number
 * (package.json and openclaw.plugin.json). `npm version patch` rewrites
 * package.json and nothing else, so the literal would go on announcing the
 * previous release to the control plane and a bug reported against 0.1.1
 * would be attributed server-side to 0.1.0. npm puts package.json in every
 * tarball whether or not `files` names it, so this read cannot miss.
 *
 * The manifest's copy cannot be derived -- the host reads it as static JSON
 * before any of this runs -- so it is held equal by a test instead
 * (test/version.test.js).
 */
export const SDK_VERSION = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
).version;

export const SDK_UA = `percepteye-agent-flywheel-node/${SDK_VERSION}`;

function neverSent(err) {
  // An AbortError is our own timeout firing. The request was in flight; the
  // server may have completed it. Ambiguous, never "never sent".
  if (err?.name === "AbortError" || err?.name === "TimeoutError") return false;
  const code = err?.cause?.code ?? err?.code;
  return typeof code === "string" && NEVER_SENT_CODES.has(code);
}

/**
 * Exponential with FULL JITTER, capped at 8s. The jitter is load-bearing: a
 * fleet of agents that all retry on the same schedule reconverges into exactly
 * the spike that caused the backoff.
 */
function backoffMs(attempt) {
  return Math.random() * Math.min(8000, 500 * 2 ** (attempt - 1));
}

function retryAfterMs(response) {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : null;
}

async function detail(response) {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return "";
  }
  try {
    const body = JSON.parse(text);
    if (body && typeof body === "object" && !Array.isArray(body)) {
      for (const key of ["detail", "error", "message", "reason"]) {
        if (key in body) return String(body[key]).slice(0, 300);
      }
    }
    return String(text).slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ControlPlaneClient {
  /**
   * @param {string} baseUrl
   * @param {string} apiKey
   * @param {{timeoutMs?: number, maxAttempts?: number, fetchImpl?: Function}} [opts]
   */
  constructor(baseUrl, apiKey, opts = {}) {
    if (!baseUrl) throw new TransportError("control-plane base URL is required");
    if (!apiKey) {
      // NO "dev-key" DEFAULT. A previous SDK defaulted a missing key to a
      // literal placeholder, so a misconfigured deployment ran happily and
      // reported nothing at all.
      throw new TransportError(
        "an API key is required; refusing to start with no credential",
      );
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this._timeoutMs = opts.timeoutMs ?? 30_000;
    this._maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
    this._fetch = opts.fetchImpl ?? globalThis.fetch;
    this._headers = {
      Authorization: `Bearer ${apiKey}`,
      "Contract-Version": CONTRACT_VERSION,
      "X-Percepteye-Sdk": SDK_UA,
      Accept: "application/json",
    };
  }

  /**
   * Send one request, retrying transient failures.
   *
   * `retryIfAmbiguous: false` narrows retries to failures where the request
   * PROVABLY never reached the server. Use it for any call whose server side
   * has a side effect and no replay protection -- retrying a request that MAY
   * have been processed performs it twice.
   */
  async request(method, path, opts = {}) {
    const {
      jsonBody, idempotencyKey, timeoutMs, retryIfAmbiguous = true,
      headers: requestHeaders = null,
    } = opts;
    const url = `${this.baseUrl}${path}`;
    const headers = { ...this._headers };

    // Per-request evidence such as the current rollout lease belongs beside
    // the client-owned authentication and contract headers, never in place of
    // them. Header names are case-insensitive, so protect the whole set by its
    // lowercase spelling rather than only the exact casing used above.
    const protectedHeaders = new Set([
      ...Object.keys(this._headers).map((name) => name.toLowerCase()),
      "content-type",
      "idempotency-key",
    ]);
    if (requestHeaders !== null && requestHeaders !== undefined) {
      if (
        typeof requestHeaders !== "object"
        || Array.isArray(requestHeaders)
      ) {
        throw new TransportError("request headers must be an object");
      }
      for (const [name, value] of Object.entries(requestHeaders)) {
        if (protectedHeaders.has(name.toLowerCase())) {
          throw new TransportError(
            `request header ${JSON.stringify(name)} is owned by the control-plane client`,
          );
        }
        if (typeof value !== "string") {
          throw new TransportError(
            `request header ${JSON.stringify(name)} must be a string`,
          );
        }
        headers[name] = value;
      }
    }
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    if (jsonBody !== undefined) headers["Content-Type"] = "application/json";

    let lastErr = null;

    for (let attempt = 1; attempt <= this._maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        timeoutMs ?? this._timeoutMs,
      );
      let response;
      try {
        response = await this._fetch(url, {
          method,
          headers,
          body: jsonBody === undefined ? undefined : JSON.stringify(jsonBody),
          signal: controller.signal,
        });
      } catch (err) {
        lastErr = `${err?.name ?? "Error"}: ${err?.message ?? err}`;
        if (attempt === this._maxAttempts || !(retryIfAmbiguous || neverSent(err))) break;
        await sleep(backoffMs(attempt));
        continue;
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 410) {
        throw new LeaseLost((await detail(response)) || "lease lost");
      }

      // 429 retries EVEN WHEN ambiguous retries are off: it is the server
      // explicitly telling us it did not do the work. Python has the same
      // asymmetry (`status == 429 or (status in RETRY and retry_if_ambiguous)`).
      if (response.status === 429
          || (RETRY_STATUS.has(response.status) && retryIfAmbiguous)) {
        lastErr = `HTTP ${response.status}: ${await detail(response)}`;
        if (attempt === this._maxAttempts) break;
        await sleep(retryAfterMs(response) ?? backoffMs(attempt));
        continue;
      }

      if (response.status >= 400) {
        // Terminal. A 4xx that is not 408/429 will not become a 2xx by being
        // sent again; retrying only delays the error.
        throw new TransportError(
          `${method} ${path} -> HTTP ${response.status}: ${await detail(response)}`,
        );
      }

      const text = await response.text();
      if (!text) return {};
      let body;
      try {
        body = JSON.parse(text);
      } catch (err) {
        throw new TransportError(
          `${method} ${path} -> HTTP ${response.status} with unparseable body: ${err.message}`,
        );
      }
      return body && typeof body === "object" && !Array.isArray(body)
        ? body
        : { data: body };
    }

    throw new TransportError(
      `${method} ${path} failed after ${this._maxAttempts} attempts: ${lastErr}`,
    );
  }
}
