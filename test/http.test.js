/**
 * The retry semantics, pinned. Every case here names a defect the Python
 * client's docstring records, because this port exists to be the SAME client
 * in a second language, not a second client.
 */
import "./support/home.js";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  ControlPlaneClient, MAX_BACKOFF_MS, MAX_ERROR_BODY_BYTES, cut,
} from "../src/http.js";
import { LeaseLost, TransportError } from "../src/errors.js";

/** A fetch stub that replays a scripted sequence and records what it saw. */
function stub(script) {
  const seen = [];
  const impl = async (url, init) => {
    seen.push({ url, init });
    const next = script[Math.min(seen.length - 1, script.length - 1)];
    if (typeof next === "function") return next();
    if (next instanceof Error) throw next;
    return new Response(next.body ?? null, {
      status: next.status ?? 200,
      headers: next.headers ?? {},
    });
  };
  return { impl, seen };
}

const client = (script, opts = {}) => {
  const s = stub(script);
  return {
    c: new ControlPlaneClient("https://cp.test", "pefw_k", {
      fetchImpl: s.impl, maxAttempts: 4, ...opts,
    }),
    seen: s.seen,
  };
};

function netError(code) {
  const e = new TypeError("fetch failed");
  e.cause = { code };
  return e;
}

describe("retrying reads the response, not just the exception", () => {
  it("retries a 503 and returns the eventual success", async () => {
    const { c, seen } = client([
      { status: 503, body: '{"detail":"warming"}' },
      { status: 200, body: '{"ok":true}' },
    ]);
    assert.deepEqual(await c.request("GET", "/health"), { ok: true });
    assert.equal(seen.length, 2);
  });

  it("does NOT retry a 400 — it will not become a 2xx", async () => {
    const { c, seen } = client([{ status: 400, body: '{"error":"bad"}' }]);
    await assert.rejects(() => c.request("POST", "/agents"), TransportError);
    assert.equal(seen.length, 1, "a terminal status was retried");
  });

  it("raises LeaseLost on 410 rather than a generic transport error", async () => {
    const { c } = client([{ status: 410, body: '{"detail":"lease lapsed"}' }]);
    await assert.rejects(() => c.request("POST", "/x"), LeaseLost);
  });

  it("carries the status ON the error, not only inside its message", async () => {
    // THE PRODUCER of the fact `outbox.js:retirementFor` consumes. A caller
    // holding a rollout's only copy of its result has to tell a 422 (these
    // bytes are refused forever -- keep them, under a name) from a 401 (a
    // reissued key delivers them -- keep retrying), and parsing English out of
    // a message is not a mechanism. Without this the outbox reads every
    // refusal as transient and retries it for a week.
    const { c } = client([{ status: 422, body: '{"detail":"nope"}' }]);
    await assert.rejects(() => c.request("POST", "/rollouts/r1/result"), (err) => {
      assert.equal(err.statusCode, 422,
        `the status did not travel with the error: ${err.statusCode}`);
      return true;
    });
  });

  it("puts 410 on the LeaseLost too", async () => {
    const { c } = client([{ status: 410, body: '{"detail":"gone"}' }]);
    await assert.rejects(() => c.request("POST", "/rollouts/r1/heartbeat"), (err) => {
      assert.ok(err instanceof LeaseLost);
      assert.equal(err.statusCode, 410);
      return true;
    });
  });

  it("leaves the status null when no response was ever produced", async () => {
    // The TRANSIENT side of the split, and it has to stay that way: a network
    // blip that retired a rollout's only copy of its result would be a worse
    // failure than the one the split exists to handle.
    const { c } = client([netError("ECONNREFUSED")]);
    await assert.rejects(() => c.request("POST", "/rollouts/r1/result"), (err) => {
      assert.equal(err.statusCode, null,
        "a failure the server never saw was classified as a permanent refusal");
      return true;
    });
  });

  it("honours Retry-After over its own backoff", async () => {
    const { c, seen } = client([
      { status: 429, headers: { "retry-after": "0" } },
      { status: 200, body: "{}" },
    ]);
    await c.request("GET", "/health");
    assert.equal(seen.length, 2);
  });

  it("caps a server-supplied Retry-After at the backoff ceiling", async (t) => {
    // A proxy answering `Retry-After: 3600` must not park a request for an
    // hour: the Python client caps it at the same 8s as its own backoff
    // (tests/test_the_delivery_reserve_is_derived_not_declared.py there).
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { c, seen } = client([
      { status: 503, headers: { "retry-after": "3600" } },
      { status: 200, body: '{"ok":true}' },
    ]);
    const pending = c.request("GET", "/health");
    for (let i = 0; i < 20 && seen.length < 2; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(MAX_BACKOFF_MS);
    }
    assert.equal(seen.length, 2, "an hour-long Retry-After was honoured");
    assert.deepEqual(await pending, { ok: true });
  });
});

describe("ambiguity is the axis, not failure", () => {
  it("retryIfAmbiguous=false still retries a CONNECT failure (never sent)", async () => {
    const { c, seen } = client([netError("ECONNREFUSED"), { status: 200, body: "{}" }]);
    await c.request("POST", "/rollouts/claim", { retryIfAmbiguous: false });
    assert.equal(seen.length, 2, "a provably-unsent request was not retried");
  });

  it("retryIfAmbiguous=false does NOT retry a timeout", async () => {
    // THE DEFECT THIS PREVENTS: a read timeout may have been fully processed.
    // Resending /rollouts/claim double-leased batches that then sat until
    // their leases lapsed -- transport.py:134-139 records the incident.
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const { c, seen } = client([abort, { status: 200, body: "{}" }]);
    await assert.rejects(
      () => c.request("POST", "/rollouts/claim", { retryIfAmbiguous: false }),
      TransportError,
    );
    assert.equal(seen.length, 1, "an ambiguous failure was retried");
  });

  it("a 429 retries EVEN when ambiguous retries are off", async () => {
    // The server explicitly said it did not do the work, so resending is safe
    // regardless. Python carries the same asymmetry.
    const { c, seen } = client([
      { status: 429, headers: { "retry-after": "0" } },
      { status: 200, body: "{}" },
    ]);
    await c.request("POST", "/rollouts/claim", { retryIfAmbiguous: false });
    assert.equal(seen.length, 2);
  });
});

describe("refusing to start wrong", () => {
  it("refuses an empty API key rather than defaulting one", async () => {
    // A previous SDK defaulted a missing key to a literal placeholder, so a
    // misconfigured deployment ran happily and reported nothing.
    assert.throws(() => new ControlPlaneClient("https://cp.test", ""), TransportError);
  });
  it("refuses an empty base URL", () => {
    assert.throws(() => new ControlPlaneClient("", "pefw_k"), TransportError);
  });
});

describe("bodies", () => {
  it("an empty body is {}, not a parse error", async () => {
    const { c } = client([{ status: 200, body: "" }]);
    assert.deepEqual(await c.request("POST", "/x"), {});
  });
  it("a non-object body is wrapped rather than returned bare", async () => {
    const { c } = client([{ status: 200, body: "[1,2]" }]);
    assert.deepEqual(await c.request("GET", "/x"), { data: [1, 2] });
  });
  it("an unparseable body raises instead of returning nothing", async () => {
    const { c } = client([{ status: 200, body: "not json" }]);
    await assert.rejects(() => c.request("GET", "/x"), TransportError);
  });
  it("sends the contract version on every request", async () => {
    const { c, seen } = client([{ status: 200, body: "{}" }]);
    await c.request("GET", "/health");
    assert.equal(seen[0].init.headers["Contract-Version"], "flywheel/1");
    assert.match(seen[0].init.headers.Authorization, /^Bearer /);
  });
  it("sets Idempotency-Key only when given one", async () => {
    const { c, seen } = client([{ status: 200, body: "{}" }, { status: 200, body: "{}" }]);
    await c.request("POST", "/a", { idempotencyKey: "k1" });
    await c.request("POST", "/b");
    assert.equal(seen[0].init.headers["Idempotency-Key"], "k1");
    assert.equal(seen[1].init.headers["Idempotency-Key"], undefined);
  });
  it("adds per-request evidence without replacing client-owned headers", async () => {
    const { c, seen } = client([{ status: 200, body: "{}" }]);
    await c.request("POST", "/rollouts/r1/result", {
      headers: { "X-Percepteye-Lease-Token": "lease-1" },
    });
    assert.equal(
      seen[0].init.headers["X-Percepteye-Lease-Token"], "lease-1",
    );
    assert.equal(seen[0].init.headers.Authorization, "Bearer pefw_k");
    assert.equal(seen[0].init.headers["Contract-Version"], "flywheel/1");
  });
  it("refuses case-insensitive overrides of client-owned headers", async () => {
    const { c, seen } = client([{ status: 200, body: "{}" }]);
    await assert.rejects(
      () => c.request("GET", "/health", {
        headers: { authorization: "Bearer attacker-selected" },
      }),
      /owned by the control-plane client/,
    );
    assert.equal(seen.length, 0, "an override reached fetch");
  });
});

describe("an error body is cut at 300 CODE POINTS, as Python's text[:300] cuts it", () => {
  // Every path through `detail` that keeps the body's own text, not only the
  // structured one: a UTF-16 `.slice(0, 300)` keeps fewer characters than
  // Python wherever an astral character comes first, and can halve one.
  const BOX = "\u{1f4e6}";

  it("an unparseable (text/plain) body keeps exactly its first 300 code points", async () => {
    // 400 code points, 600 UTF-16 units.
    const body = BOX.repeat(200) + "x".repeat(200);
    const { c } = client([{
      status: 422, body, headers: { "content-type": "text/plain" },
    }]);
    await assert.rejects(() => c.request("POST", "/x"), (err) => {
      assert.equal(err.message,
        `POST /x -> HTTP 422: ${BOX.repeat(200)}${"x".repeat(100)}`);
      return true;
    });
  });

  it("a JSON body naming no detail key is kept whole under 300 code points", async () => {
    // 211 code points, 411 UTF-16 units: a cut by units dropped its end.
    const body = JSON.stringify({ note: BOX.repeat(200) });
    const { c } = client([{
      status: 422, body, headers: { "content-type": "application/json" },
    }]);
    await assert.rejects(() => c.request("POST", "/x"), (err) => {
      assert.equal(err.message, `POST /x -> HTTP 422: ${body}`);
      return true;
    });
  });

  it("iterates no further into a string than the 300 code points it keeps", () => {
    // A cut that spread the whole string into one entry per character paid
    // heap in proportion to it, on every attempt. Pinned on what is ITERATED,
    // which a timing could not pin: this string refuses to be read past its
    // 301st code point (the one the loop stops on). How much of a BODY is read
    // off the wire is `detail`'s bound, pinned below.
    let pulled = 0;
    const endless = {
      *[Symbol.iterator]() {
        for (;;) {
          pulled += 1;
          if (pulled > 301) throw new Error(`read code point ${pulled}`);
          yield BOX;
        }
      },
    };
    assert.equal(cut(endless), BOX.repeat(300));
    assert.equal(pulled, 301);
    const huge = BOX.repeat(2_000_000);
    assert.equal(cut(huge), BOX.repeat(300));
    assert.equal(cut("short"), "short");
  });
});

describe("what one attempt may cost, and what an error keeps", () => {
  it("treats a connection reset as possibly performed (ND-H1)", async () => {
    // A reset arrives on an ESTABLISHED connection, after the request may have
    // been written and processed. It was listed as "never sent", so a call
    // with ambiguous retries off was resent and the error said it had not
    // happened.
    const { c, seen } = client([netError("ECONNRESET"), { status: 200, body: "{}" }]);
    await assert.rejects(
      () => c.request("POST", "/x", { retryIfAmbiguous: false }),
      (err) => {
        assert.equal(err.ambiguous, true, "a reset was reported as never sent");
        return true;
      },
    );
    assert.equal(seen.length, 1, "a reset was resent with ambiguous retries off");
  });

  it("times out a server that sends headers and then stalls the body (ND-H2)", async () => {
    let attempts = 0;
    const impl = async (url, init) => {
      attempts += 1;
      const body = new ReadableStream({
        start(controller) {
          init.signal.addEventListener("abort", () => {
            controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        },
      });
      return new Response(body, { status: 200 });
    };
    const c = new ControlPlaneClient("https://cp.test", "pefw_k", {
      fetchImpl: impl, maxAttempts: 1, timeoutMs: 50,
    });
    await assert.rejects(() => c.request("GET", "/x"), (err) => {
      assert.ok(err instanceof TransportError, String(err));
      assert.equal(err.ambiguous, true);
      assert.equal(err.statusCode, 200);
      return true;
    });
    assert.equal(attempts, 1);
  });

  it("serialises the body once and never sends one JSON cannot carry (ND-H3)", async () => {
    const { c, seen } = client([{ status: 200, body: "{}" }]);
    await assert.rejects(() => c.request("POST", "/x", { jsonBody: { n: 1n } }), (err) => {
      assert.ok(err instanceof TransportError);
      assert.equal(err.ambiguous, false, "nothing was sent, so nothing may have happened");
      assert.match(err.message, /cannot be serialised as JSON/);
      return true;
    });
    assert.equal(seen.length, 0, "a body that cannot be serialised was attempted");
  });

  it("keeps the last status on an error that ran out of attempts (ND-M6)", async () => {
    const { c } = client([{ status: 503, headers: { "retry-after": "0" } }], { maxAttempts: 2 });
    await assert.rejects(() => c.request("GET", "/x"), (err) => {
      assert.equal(err.statusCode, 503, `got ${err.statusCode}`);
      return true;
    });
  });

  it("keeps the status on a 2xx whose body cannot be parsed (ND-M6)", async () => {
    const { c } = client([{ status: 200, body: "<html>proxy</html>" }]);
    await assert.rejects(() => c.request("GET", "/x"), (err) => {
      assert.equal(err.statusCode, 200);
      assert.equal(err.ambiguous, true);
      return true;
    });
  });

  it("answers a redirect as an error and never follows it (ND-M6)", async () => {
    const { c, seen } = client([
      { status: 302, headers: { location: "https://elsewhere.test/login" } },
      { status: 200, body: "{}" },
    ]);
    await assert.rejects(() => c.request("POST", "/x", { jsonBody: {} }), (err) => {
      assert.equal(err.statusCode, 302);
      assert.match(err.message, /does not redirect/);
      assert.match(err.message, /elsewhere\.test/);
      return true;
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].init.redirect, "manual",
      "fetch was left to follow a redirect with the bearer key");
  });

  it("reads no more of a refusal's body than MAX_ERROR_BODY_BYTES (ND-M6)", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(4096).fill(0x61);
    const impl = async () => new Response(new ReadableStream({
      // Finite (2 MiB), so a client that reads it all finishes and says how
      // much it read rather than hanging the suite.
      pull(controller) {
        if (pulled >= 2 * 1024 * 1024) { controller.close(); return; }
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }), { status: 400 });
    const c = new ControlPlaneClient("https://cp.test", "pefw_k", { fetchImpl: impl });
    await assert.rejects(() => c.request("GET", "/x"), (err) => {
      assert.equal(err.statusCode, 400);
      assert.ok(err.message.endsWith("a".repeat(300)), err.message.slice(0, 80));
      return true;
    });
    assert.ok(pulled <= MAX_ERROR_BODY_BYTES + 3 * chunk.byteLength,
      `read ${pulled} bytes of a 2 MiB error body`);
  });

  it("refuses an attempt count that is not a positive integer (ND-M6)", () => {
    for (const maxAttempts of [Number.NaN, Infinity, 0, -1, 1.5, "3"]) {
      assert.throws(
        () => new ControlPlaneClient("https://cp.test", "pefw_k", { maxAttempts }),
        TransportError, String(maxAttempts),
      );
    }
  });
});
