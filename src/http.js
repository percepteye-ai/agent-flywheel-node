/**
 * The one HTTP client, with retry semantics that READ THE RESPONSE.
 *
 * A port of `agent_flywheel/_http.py`, kept deliberately
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
export const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Node's fetch rejects with a TypeError whose `cause.code` names the syscall
 * failure. These are the codes where the connection was NEVER ESTABLISHED, so
 * the server cannot have seen the request.
 *
 * A TIMEOUT IS NOT IN THIS SET, and that is the whole point of the
 * distinction: a read timeout may have been fully processed by the server, so
 * resending it performs the operation twice. Python names the same split with
 * `_NEVER_SENT = (httpx.ConnectError, httpx.ConnectTimeout)`.
 *
 * NOR IS `ECONNRESET`. A reset arrives on a connection that WAS established --
 * an idle keep-alive socket the server closed, or one it dropped after the
 * request was written and possibly processed -- and the code alone cannot tell
 * the two apart. Listing it here reported "provably never sent" for a request
 * the control plane may have performed.
 */
const NEVER_SENT_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN",
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

export const SDK_UA = `agent-flywheel-node/${SDK_VERSION}`;

/**
 * Might a request answered with this status have been PERFORMED? A 4xx is the
 * server refusing it and a 503 the server saying it was not handled -- the
 * control plane's own store failures answer 503 and register nothing. Any
 * other 5xx may come after the work was done: a 500 raised after a commit, a
 * 502 or 504 from a proxy whose upstream finished and lost the answer. Read by
 * `TransportError.ambiguous`; the Python client's `_may_have_performed`.
 */
function mayHavePerformed(status) {
  return status >= 500 && status !== 503;
}

function neverSent(err) {
  // An AbortError is our own timeout firing. The request was in flight; the
  // server may have completed it. Ambiguous, never "never sent".
  if (err?.name === "AbortError" || err?.name === "TimeoutError") return false;
  const code = err?.cause?.code ?? err?.code;
  return typeof code === "string" && NEVER_SENT_CODES.has(code);
}

/**
 * Ceiling on ONE backoff sleep, and therefore on a server-supplied
 * `Retry-After`: the Python client's `_MAX_BACKOFF_S`. Honouring an uncapped
 * header let a proxy answering `Retry-After: 3600` -- not necessarily the
 * control plane at all -- park one request for an hour, once per attempt.
 */
export const MAX_BACKOFF_MS = 8000;

/**
 * Exponential with FULL JITTER, capped. The jitter is load-bearing: a fleet of
 * agents that all retry on the same schedule reconverges into exactly the
 * spike that caused the backoff.
 */
export function backoffMs(attempt) {
  return Math.random() * Math.min(MAX_BACKOFF_MS, 500 * 2 ** (attempt - 1));
}

/** The server's own backoff, capped at the same ceiling as our jitter. */
export function retryAfterMs(response) {
  const raw = response.headers?.get?.("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds)
    ? Math.max(0, Math.min(MAX_BACKOFF_MS, seconds * 1000))
    : null;
}

/**
 * The first 300 CODE POINTS, as Python's `text[:300]` keeps them. A UTF-16
 * `.slice` kept fewer characters wherever an emoji or other astral character
 * came first -- so the same answer read shorter here -- and could cut one in
 * half.
 *
 * ITERATES NO FURTHER THAN IT KEEPS: spreading a whole string into one array
 * entry per character to keep 300 cost heap in proportion to the string. What
 * bounds how much of an error BODY is read off the wire at all is not this
 * function -- it is handed a string already in memory -- but `detail`'s
 * `MAX_ERROR_BODY_BYTES`.
 */
export function cut(text) {
  let out = "";
  let kept = 0;
  for (const character of text) {
    if (kept === 300) break;
    out += character;
    kept += 1;
  }
  return out;
}

/**
 * How much of a REFUSAL's body is read: enough for any refusal the control
 * plane writes, and a hard stop for an HTML error page or a proxy's dump of
 * megabytes, which every refused or retried attempt would otherwise buffer
 * whole into the gateway's heap to keep 300 characters of it.
 */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** At most `limit` bytes of `response`'s body, decoded; the rest is never
 * downloaded. A response with no stream (a test double) is read whole. */
export async function readCapped(response, limit) {
  const stream = response.body;
  if (!stream || typeof stream.getReader !== "function") return response.text();
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, limit));
}

async function detail(response) {
  let text = "";
  try {
    text = await readCapped(response, MAX_ERROR_BODY_BYTES);
  } catch {
    return "";
  }
  try {
    const body = JSON.parse(text);
    if (body && typeof body === "object" && !Array.isArray(body)) {
      for (const key of ["detail", "error", "message", "reason"]) {
        if (!(key in body)) continue;
        // A STRUCTURED detail is rendered, not flattened. The control plane
        // answers many refusals with an object -- `{error, cause, index,
        // detail}` for a refused rule, `{error, status, detail}` for an agent
        // attributed to no Product -- and `String()` turned every one into
        // "[object Object]", a refusal naming no cause. The Python SDK's
        // `_detail` renders the same object as the same compact JSON
        // (non-ASCII kept), so both packages tell a customer the same thing
        // about the same answer -- `test_rulebook_parity.py` there compares
        // the two sentences.
        const value = body[key];
        return cut(typeof value === "string" ? value : JSON.stringify(value));
      }
    }
    return cut(String(text));
  } catch {
    return cut(text);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What a Flywheel key in an outgoing body is replaced with. */
export const REDACTED_KEY = "pefw_[REDACTED]";
/** A Flywheel key as the control plane mints one: the prefix and 43 URL-safe
 *  base64 characters, matched whole. */
const FLYWHEEL_KEY = /pefw_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;
/** A secret shorter than this is not a minted key (those are 48 characters)
 *  and is not searched for by value: replacing every "k" in a report because
 *  a test authenticated as "k" would corrupt the report. */
const MIN_SECRET_LENGTH = 16;

/**
 * `body` (serialised JSON) with every Flywheel key in it -- and `secret` --
 * replaced by {@link REDACTED_KEY}.
 *
 * NO BODY THIS PACKAGE SENDS CARRIES A FLYWHEEL KEY (owner ruling 2026-10-20,
 * R2b). Tool output is captured into what this package reports, and a tool
 * can read whatever its user can -- the key `login` stored under
 * ~/.percepteye included. Every key the control plane mints is matched by its
 * shape, and the key this client authenticates with by its exact value,
 * whatever its shape. The Python SDK's `_http.redact_keys`, on the
 * serialised form: a key is URL-safe, so JSON writes it unescaped.
 */
export function redactKeys(body, secret = null) {
  let out = body.replace(FLYWHEEL_KEY, REDACTED_KEY);
  if (secret && secret.length >= MIN_SECRET_LENGTH && out.includes(secret)) {
    out = out.split(secret).join(REDACTED_KEY);
  }
  return out;
}

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
    // Kept so `redactKeys` can find this exact value in a body.
    this._secret = apiKey;
    this._timeoutMs = opts.timeoutMs ?? 30_000;
    const maxAttempts = opts.maxAttempts ?? 4;
    // A NaN made the retry loop run zero times and report "failed after NaN
    // attempts" for a request never made; Infinity never stopped retrying.
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new TransportError(
        `maxAttempts must be a positive integer, not ${String(maxAttempts)}`,
      );
    }
    this._maxAttempts = maxAttempts;
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

    // SERIALISED ONCE, before any attempt. A body JSON cannot carry (a
    // BigInt, a cycle) fails identically every time; inside the loop it was
    // read as a failed send -- "may have been performed" -- and retried.
    let body;
    if (jsonBody !== undefined) {
      let serialised;
      try {
        serialised = JSON.stringify(jsonBody);
      } catch (err) {
        throw new TransportError(
          `${method} ${path}: the request body cannot be serialised as JSON ` +
          `(${err?.name ?? "Error"}: ${err?.message ?? err}); nothing was sent`,
          { cause: err },
        );
      }
      if (typeof serialised !== "string") {
        throw new TransportError(
          `${method} ${path}: the request body serialises to no JSON; nothing was sent`,
        );
      }
      body = redactKeys(serialised, this._secret);
    }

    let lastErr = null;
    // The status of the LAST attempt, so a request that ran out of attempts on
    // a 503 still says 503 on the error and not only inside its message.
    let lastStatus = null;
    // Whether ANY attempt so far may have been performed -- see
    // `TransportError.ambiguous`. Over every attempt, not the last: a retry
    // that was never sent says nothing about the one before it.
    let ambiguous = false;
    let wait = null;

    for (let attempt = 1; attempt <= this._maxAttempts; attempt += 1) {
      if (wait !== null) {
        await sleep(wait);
        wait = null;
      }
      const last = attempt === this._maxAttempts;
      const controller = new AbortController();
      // The deadline covers the WHOLE attempt, the body read included. It
      // used to be cleared as soon as the headers arrived, so a server that
      // sent headers and then stalled held the call open forever.
      const timer = setTimeout(
        () => controller.abort(),
        timeoutMs ?? this._timeoutMs,
      );
      try {
        let response;
        try {
          response = await this._fetch(url, {
            method,
            headers,
            body,
            signal: controller.signal,
            // A redirect is answered, never followed: fetch would replay the
            // request -- the bearer key with it -- at wherever the Location
            // points, and a 3xx that was not followed would otherwise fall
            // through as a success with an empty body.
            redirect: "manual",
          });
        } catch (err) {
          lastErr = `${err?.name ?? "Error"}: ${err?.message ?? err}`;
          lastStatus = null;
          ambiguous = ambiguous || !neverSent(err);
          if (last || !(retryIfAmbiguous || neverSent(err))) break;
          wait = backoffMs(attempt);
          continue;
        }
        const status = response.status;

        if (status === 410) {
          throw new LeaseLost((await detail(response)) || "lease lost",
                              { statusCode: status, ambiguous });
        }
        ambiguous = ambiguous || mayHavePerformed(status);

        if (status >= 300 && status < 400) {
          const location = response.headers?.get?.("location");
          throw new TransportError(
            `${method} ${path} -> HTTP ${status}: the control plane does not ` +
            "redirect, so this URL is not answering as the control plane" +
            (location ? ` (it redirects to ${cut(location)})` : ""),
            { statusCode: status, ambiguous },
          );
        }

        // 429 retries EVEN WHEN ambiguous retries are off: it is the server
        // explicitly telling us it did not do the work. Python has the same
        // asymmetry (`status == 429 or (status in RETRY and retry_if_ambiguous)`).
        if (status === 429 || (RETRY_STATUS.has(status) && retryIfAmbiguous)) {
          lastErr = `HTTP ${status}: ${await detail(response)}`;
          lastStatus = status;
          if (last) break;
          wait = retryAfterMs(response) ?? backoffMs(attempt);
          continue;
        }

        if (status >= 400) {
          // Terminal. A 4xx that is not 408/429 will not become a 2xx by being
          // sent again; retrying only delays the error.
          //
          // The STATUS travels with the error, not only inside its message: a
          // caller holding a rollout's only copy of its result has to tell a
          // 422 (these bytes are refused forever) from a 401 (a reissued key
          // delivers them), and the difference decides whether the file stays
          // in the retry set. See `outbox.js:REDELIVERY_CANNOT_FIX`.
          throw new TransportError(
            `${method} ${path} -> HTTP ${status}: ${await detail(response)}`,
            { statusCode: status, ambiguous },
          );
        }

        // PERFORMED from here on: the control plane answered 2xx. What it did
        // may be unreadable; it is not undone.
        let text;
        try {
          text = await response.text();
        } catch (err) {
          throw new TransportError(
            `${method} ${path} -> HTTP ${status} with a body that could not be ` +
            `read: ${err?.name ?? "Error"}: ${err?.message ?? err}`,
            { statusCode: status, ambiguous: true },
          );
        }
        if (!text) return {};
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          throw new TransportError(
            `${method} ${path} -> HTTP ${status} with unparseable body: ${err.message}`,
            { statusCode: status, ambiguous: true },
          );
        }
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed
          : { data: parsed };
      } finally {
        clearTimeout(timer);
      }
    }

    throw new TransportError(
      `${method} ${path} failed after ${this._maxAttempts} attempts: ${lastErr}`,
      { statusCode: lastStatus, ambiguous },
    );
  }
}
