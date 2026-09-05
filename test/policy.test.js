/**
 * The last mile: the approved prompt AND the trained model reaching the agent.
 *
 * WHAT WAS BROKEN, twice.
 *
 *   1. `AttachTransport.policyCurrent` and `promptCurrent` both existed, both
 *      were tested against a stub, and NOTHING IN THE PACKAGE CALLED EITHER --
 *      two reads whose answers were thrown away, with an operator watching a
 *      model train, get certified and get approved while the agent in front of
 *      their users ran what it ran the day they installed the plugin.
 *   2. Then the prompt half landed and `handle()` TOOK NO ARGUMENTS, so one
 *      agent's approved prompt was returned for every prompt build in the
 *      process -- subagents and cron turns included.
 *
 * These tests hold four things:
 *
 *   THE PAIR CHECK. The prompt is certified together with a checkpoint, so
 *   every reason the pair might not stand has to refuse BY NAME -- a refusal
 *   that reports the wrong cause sends an operator to fix something that was
 *   never wrong.
 *   THE SCOPE. Both halves apply to this agent's own served turns and to
 *   nothing else. `scope.test.js` holds the predicate; here it is held at the
 *   seam, which is where it was missing.
 *   THE SEAMS. `{systemPrompt}` is a RETURN field on `before_prompt_build`
 *   and `{providerOverride, modelOverride}` a RETURN on
 *   `before_model_resolve`; mutating either event does nothing. A test that
 *   asserted on a mutated event would pass against a plugin that changes
 *   nothing at all.
 *   THE FOOTGUN. `normalizeTransport` is consulted for OTHER providers too --
 *   the host loops over every registered provider plugin looking for one that
 *   changes the transport -- so answering unconditionally would redirect the
 *   customer's Anthropic or OpenAI traffic to our gateway.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { register, PLUGIN_ID } from "../src/index.js";
import { resolveConfig } from "../src/config.js";
import { resolveServedAgent } from "../src/scope.js";
import {
  MODEL_HOOK_NAME, MODEL_OFF_REASON, NO_KEY_REASON, PROMPT_HOOK_NAME,
  PROMPT_OFF_REASON, PROVIDER_ID, PROVIDER_TRANSPORT_API,
  SERVABLE_PROMPT_STATUSES, createPolicySource, modelDecision,
  modelHookBlockedReason, pairNote, promptDecision, registerServingPolicy,
  servedPolicySummary,
} from "../src/policy.js";

/** A `/prompt/current` body that passes every check. */
const APPROVED = {
  name: "support-agent",
  version: 3,
  sha256: "a".repeat(64),
  text: "You are a careful support agent.",
  candidate_kind: "replacement",
  status: "approved",
  model_prompt_checksum: "a".repeat(64),
  stale_baseline: false,
};

/** A `/policy/current` body with a candidate being served. */
const SERVED = {
  arm: "candidate",
  reason: "certified candidate for contract c1",
  candidate_available: true,
  endpoint: { base_url: "https://gpu.example/v1", model: "ckpt-7" },
  model: { uri: "gs://bucket/ckpt-7" },
  prompt: { pins: { p1: {} }, digest: "d".repeat(16), captured_at: "now" },
  bundle_digest: "b".repeat(64),
  resolved_at: "2026-09-05T00:00:00+00:00",
  ttl_s: 60.0,
  serving_generation: "0123456789abcdef",
};

/** A `/policy/current` body on the champion arm with nothing deployed. */
const UNSERVED = { ...SERVED, arm: "base", endpoint: null, candidate_available: false };

/**
 * One of this agent's own served turns, as the host describes it.
 *
 * The default install: `agentId` is "openclaw" (the control plane's name) and
 * the host runs its one default agent, "main".
 */
const TURN = { agentId: "main", sessionKey: "agent:main:slack:chat:c1" };

/** The same agent, but a subagent it spawned. */
const SUBAGENT = { agentId: "main", sessionKey: "agent:main:subagent:t9" };

/** The same agent, on a scheduled turn. */
const CRON = { agentId: "main", sessionKey: "agent:main:cron:nightly:run:3" };

function fakeTransport({ policy = SERVED, prompt = APPROVED } = {}) {
  const calls = [];
  return {
    calls,
    async policyCurrent() { calls.push("policy"); return policy; },
    async promptCurrent() { calls.push("prompt"); return prompt; },
  };
}

function fakeLogger() {
  const lines = [];
  const push = (level) => (msg) => lines.push(`${level}:${msg}`);
  return { lines, info: push("info"), warn: push("warn"), text: () => lines.join("\n") };
}

/** A host api that records everything a plugin registers on it. */
const hostApi = (overrides = {}) => {
  const hooks = [];
  const providers = [];
  return {
    hooks,
    providers,
    on: (name, fn) => hooks.push([name, fn]),
    registerProvider: (p) => providers.push(p),
    hook: (name) => hooks.find(([n]) => n === name)?.[1],
    ...overrides,
  };
};

const productionConfig = (over = {}, env = {}) =>
  resolveConfig({ apiKey: "pefw_x", ...over }, env);


describe("promptDecision — the pair check, cause by cause", () => {
  it("applies an approved bundle whose halves agree", () => {
    const d = promptDecision(APPROVED);
    assert.equal(d.apply, true);
    assert.equal(d.text, APPROVED.text);
    assert.equal(d.checksum, APPROVED.model_prompt_checksum);
  });

  it("`delivered` serves too — the control plane's own set, not a narrower one", () => {
    // `_servable_prompt_for_agent` filters status.in_(("approved","delivered")).
    // Accepting only "approved" would silently stop applying a prompt the
    // moment a human collected the deliverable, which flips it to "delivered".
    assert.equal(promptDecision({ ...APPROVED, status: "delivered" }).apply, true);
    assert.deepEqual([...SERVABLE_PROMPT_STATUSES], ["approved", "delivered"]);
  });

  it("`{}` means KEEP WHAT YOU HAVE, and says so — never 'use no prompt'", () => {
    for (const body of [{}, null, undefined, { text: "" }, { text: "   " }]) {
      const d = promptDecision(body);
      assert.equal(d.apply, false);
      assert.equal(d.text, null, "an empty answer must never blank the prompt");
      assert.match(d.reason, /no approved prompt/i);
    }
  });

  it("refuses on stale_baseline, and names THAT", () => {
    const d = promptDecision({ ...APPROVED, stale_baseline: true });
    assert.equal(d.apply, false);
    assert.match(d.reason, /stale_baseline/);
    // The refusal must not be a generic one shared with the other three.
    assert.doesNotMatch(d.reason, /status/i);
  });

  it("refuses an unapproved status, and names THAT", () => {
    for (const status of ["draft", "pending_approval", "", "APPROVED"]) {
      const d = promptDecision({ ...APPROVED, status });
      assert.equal(d.apply, false, `status=${JSON.stringify(status)} must not serve`);
      assert.match(d.reason, /status/);
      assert.doesNotMatch(d.reason, /stale_baseline/);
    }
  });

  it("refuses a bundle whose prompt and checkpoint checksums disagree", () => {
    // Delivery assembly refuses that pair with a 409, so a served bundle
    // carrying it is not the thing that was approved, whatever its status says.
    const d = promptDecision({ ...APPROVED, model_prompt_checksum: "f".repeat(64) });
    assert.equal(d.apply, false);
    assert.match(d.reason, /disagrees with itself/);
  });

  it("applies when the checkpoint checksum is MISSING — that is 'cannot look', not 'proven wrong'", () => {
    const d = promptDecision({ ...APPROVED, model_prompt_checksum: "" });
    assert.equal(d.apply, true);
    assert.equal(d.checksum, null);
  });
});


describe("modelDecision — is this an address an agent can call", () => {
  it("applies a served endpoint", () => {
    const d = modelDecision(SERVED);
    assert.equal(d.apply, true);
    assert.equal(d.baseUrl, "https://gpu.example/v1");
    assert.equal(d.model, "ckpt-7");
  });

  it("refuses when nothing is deployed, and says that", () => {
    for (const policy of [UNSERVED, {}, null, { endpoint: { base_url: "x" } },
      { endpoint: { model: "m" } }]) {
      const d = modelDecision(policy);
      assert.equal(d.apply, false, JSON.stringify(policy));
      assert.match(d.reason, /no endpoint/);
    }
  });

  it("refuses a stored-artifact reference in `model`", () => {
    // `agent_protocol.served_policy.is_servable` refuses these server-side for
    // the same reason: `model="gs://bucket/run/iter_0"` 404s on every
    // completion. A refusal here is the only thing standing between a control
    // plane that one day widens its own filter and a broken agent.
    for (const model of ["gs://bucket/run/iter_0", "s3://b/k", "file:///ckpt",
      "/mnt/ckpt"]) {
      const d = modelDecision({ ...SERVED, endpoint: { ...SERVED.endpoint, model } });
      assert.equal(d.apply, false, model);
      assert.match(d.reason, /stored-artifact/);
      assert.doesNotMatch(d.reason, /no endpoint/, "the cause must be THIS one");
    }
  });

  it("takes the base_url verbatim — it is already normalised", () => {
    // `/policy/current` strips a trailing /chat/completions before answering.
    // Re-appending it produces a URL nothing serves.
    assert.doesNotMatch(modelDecision(SERVED).baseUrl, /chat\/completions/);
  });

  it("the summary carries what an operator has to see, including the generation", () => {
    const s = servedPolicySummary(SERVED);
    assert.match(s, /arm=candidate/);
    assert.match(s, /serving_generation=0123456789abcdef/);
    assert.ok(s.includes("https://gpu.example/v1"));
    assert.ok(s.includes("ckpt-7"));
  });
});


describe("pairNote — the whole point of the pair check is the CONDITIONAL", () => {
  const checksum = "a".repeat(64);

  it("both halves: an ordinary confirmation, not a warning", () => {
    const note = pairNote({
      promptApplied: true, modelApplied: true, checksum,
      promptRefusal: null, modelRefusal: null,
    });
    assert.equal(note.level, "info");
    assert.match(note.text, /pair is intact/);
    assert.match(note.text, /combination that was evaluated/);
    assert.doesNotMatch(
      note.text, /not the combination/,
      "with both halves applied there is nothing to warn about",
    );
  });

  it("prompt only: warns, and names the MODEL half as the missing one", () => {
    const note = pairNote({
      promptApplied: true, modelApplied: false, checksum,
      promptRefusal: null, modelRefusal: "nothing is deployed",
    });
    assert.equal(note.level, "warn");
    assert.match(note.text, /MODEL half/);
    assert.doesNotMatch(note.text, /PROMPT half/);
    assert.match(note.text, /nothing is deployed/, "it must carry the actual cause");
    assert.match(note.text, /not the combination that was evaluated/);
  });

  it("model only: warns, and names the PROMPT half as the missing one", () => {
    const note = pairNote({
      promptApplied: false, modelApplied: true, checksum: null,
      promptRefusal: "no approved prompt", modelRefusal: null,
    });
    assert.equal(note.level, "warn");
    assert.match(note.text, /PROMPT half/);
    assert.doesNotMatch(note.text, /MODEL half/);
    assert.match(note.text, /no approved prompt/);
  });

  it("neither half: nothing to say about a pair that is not being applied", () => {
    assert.equal(pairNote({
      promptApplied: false, modelApplied: false, checksum: null,
      promptRefusal: "a", modelRefusal: "b",
    }), null);
  });
});


describe("createPolicySource — resolve once, then serve the answer", () => {
  it("reads both endpoints exactly once and applies BOTH halves", async () => {
    const t = fakeTransport();
    const src = createPolicySource({ pluginId: PLUGIN_ID, logger: fakeLogger() });
    await src.resolve(t);
    assert.deepEqual(t.calls, ["policy", "prompt"]);
    assert.equal(src.appliedPrompt, APPROVED.text);
    assert.equal(src.refusal, null);
    assert.deepEqual(src.appliedModel, {
      provider: PROVIDER_ID, model: "ckpt-7", baseUrl: "https://gpu.example/v1",
    });
    assert.equal(src.modelRefusal, null);
    assert.equal(src.resolved, true);
  });

  it("returns {systemPrompt} — the RETURN field the host reads", async () => {
    // The host's `resolvePromptBuildSystemPrompt` takes
    // `promptBuildResult.systemPrompt` over its own assembled prompt. The
    // event is `{prompt, messages}` and carries no systemPrompt to mutate, so
    // a handler that wrote to the event would change nothing at all.
    const src = createPolicySource({ pluginId: PLUGIN_ID });
    await src.resolve(fakeTransport());
    const event = { prompt: "hello", messages: [] };
    assert.deepEqual(src.handle(event, TURN), { systemPrompt: APPROVED.text });
    assert.ok(!("systemPrompt" in event), "the event must not be mutated");
  });

  it("returns {providerOverride, modelOverride} — the two go together", async () => {
    // `providerOverride` is what makes ctx.provider ours on the transport
    // seam; the model name alone would aim the customer's existing provider
    // at a model it may not serve.
    const src = createPolicySource({ pluginId: PLUGIN_ID });
    await src.resolve(fakeTransport());
    const event = { prompt: "hello" };
    assert.deepEqual(src.handleModelResolve(event, TURN), {
      providerOverride: PROVIDER_ID, modelOverride: "ckpt-7",
    });
    assert.ok(!("modelOverride" in event), "the event must not be mutated");
  });

  it("returns undefined BEFORE the read lands, so the host's own answers stand", () => {
    const src = createPolicySource({ pluginId: PLUGIN_ID });
    assert.equal(src.handle({ prompt: "", messages: [] }, TURN), undefined);
    assert.equal(src.handleModelResolve({ prompt: "" }, TURN), undefined);
    assert.equal(src.normalizeTransport({ provider: PROVIDER_ID }), undefined);
  });

  it("returns undefined from BOTH halves on every prompt refusal", async () => {
    for (const prompt of [{}, { ...APPROVED, stale_baseline: true },
      { ...APPROVED, status: "draft" }]) {
      const src = createPolicySource({ pluginId: PLUGIN_ID });
      await src.resolve(fakeTransport({ prompt }));
      assert.equal(src.handle({}, TURN), undefined);
      assert.equal(src.appliedPrompt, null);
      assert.ok(src.refusal, "a refusal must always carry its reason");
      // The MODEL half is independent and still applies.
      assert.ok(src.handleModelResolve({}, TURN));
    }
  });

  it("a control plane that throws costs the improvement and nothing else", async () => {
    const src = createPolicySource({ pluginId: PLUGIN_ID, logger: fakeLogger() });
    await src.resolve({
      async policyCurrent() { throw new Error("down"); },
      async promptCurrent() { throw new Error("down"); },
    });
    assert.deepEqual(src.policy, {});
    assert.deepEqual(src.prompt, {});
    assert.equal(src.appliedPrompt, null);
    assert.equal(src.appliedModel, null);
    assert.equal(src.handle({}, TURN), undefined);
    assert.equal(src.handleModelResolve({}, TURN), undefined);
  });

  it("the prompt kill switch does not even FETCH the prompt text", async () => {
    const t = fakeTransport();
    const src = createPolicySource({
      pluginId: PLUGIN_ID, logger: fakeLogger(), applyPrompt: false,
    });
    await src.resolve(t);
    assert.deepEqual(t.calls, ["policy"], "the customer's prompt text must not be pulled to be discarded");
    assert.equal(src.appliedPrompt, null);
    assert.equal(src.refusal, PROMPT_OFF_REASON);
    // The policy half is still read, and still applied.
    assert.equal(src.policy.serving_generation, SERVED.serving_generation);
    assert.ok(src.appliedModel);
  });

  it("the model kill switch leaves the prompt half alone", async () => {
    const src = createPolicySource({
      pluginId: PLUGIN_ID, logger: fakeLogger(), applyModel: false,
    });
    await src.resolve(fakeTransport());
    assert.equal(src.appliedModel, null);
    assert.equal(src.modelRefusal, MODEL_OFF_REASON);
    assert.equal(src.handleModelResolve({}, TURN), undefined);
    assert.equal(src.normalizeTransport({ provider: PROVIDER_ID }), undefined);
    assert.equal(src.appliedPrompt, APPROVED.text);
  });

  it("a served endpoint the host will never ask about is refused by ITS cause", async () => {
    const src = createPolicySource({
      pluginId: PLUGIN_ID, logger: fakeLogger(), modelHookAvailable: false,
    });
    await src.resolve(fakeTransport());
    assert.equal(src.appliedModel, null);
    assert.match(src.modelRefusal, /allowConversationAccess/);
    assert.doesNotMatch(
      src.modelRefusal, /switched off/,
      "a missing opt-in is not a kill switch, and the remedy is different",
    );
  });

  it("both refusals are true at every moment, including before the read", () => {
    const src = createPolicySource({ pluginId: PLUGIN_ID });
    // A null refusal beside a null appliedPrompt cannot be told from a bug.
    assert.match(src.refusal, /not been asked yet/);
    assert.match(src.modelRefusal, /not been asked yet/);
  });

  it("an unwired source says why, forever", () => {
    const src = createPolicySource({ pluginId: PLUGIN_ID, unwired: NO_KEY_REASON });
    assert.equal(src.refusal, NO_KEY_REASON);
    assert.equal(src.modelRefusal, NO_KEY_REASON);
    assert.equal(src.resolved, false, "no read was ever attempted");
  });
});


describe("the scope gate at the seam — one agent's bundle, one agent's turns", () => {
  const applied = async (opts = {}) => {
    const src = createPolicySource({ pluginId: PLUGIN_ID, ...opts });
    await src.resolve(fakeTransport());
    return src;
  };

  it("applies both halves to the agent's own served turn", async () => {
    const src = await applied();
    assert.ok(src.handle({}, TURN));
    assert.ok(src.handleModelResolve({}, TURN));
  });

  it("applies NEITHER half to a subagent's turn", async () => {
    // A subagent runs the same host agent id under a different job. The
    // bundle was certified against the turns the agent serves its users.
    const src = await applied();
    assert.equal(src.handle({}, SUBAGENT), undefined);
    assert.equal(src.handleModelResolve({}, SUBAGENT), undefined);
  });

  it("applies NEITHER half to a cron turn", async () => {
    const src = await applied();
    assert.equal(src.handle({}, CRON), undefined);
    assert.equal(src.handleModelResolve({}, CRON), undefined);
  });

  it("applies NEITHER half to another agent in the same process", async () => {
    const servedAgent = resolveServedAgent({
      agentId: "support",
      hostConfig: { agents: { list: [{ id: "main" }, { id: "support" }] } },
    });
    const src = await applied({ servedAgent });
    const other = { agentId: "main", sessionKey: "agent:main:slack:chat:c1" };
    assert.equal(src.handle({}, other), undefined);
    assert.equal(src.handleModelResolve({}, other), undefined);
    const own = { agentId: "support", sessionKey: "agent:support:slack:chat:c1" };
    assert.ok(src.handle({}, own), "the agent it IS for must still be served");
    assert.ok(src.handleModelResolve({}, own));
  });

  it("FAILS CLOSED when the host gives no identity", async () => {
    const src = await applied();
    for (const ctx of [{}, null, undefined]) {
      assert.equal(src.handle({}, ctx), undefined, JSON.stringify(ctx));
      assert.equal(src.handleModelResolve({}, ctx), undefined, JSON.stringify(ctx));
    }
  });
});


describe("normalizeTransport — the base URL, and the footgun", () => {
  const resolved = async () => {
    const src = createPolicySource({ pluginId: PLUGIN_ID });
    await src.resolve(fakeTransport());
    return src;
  };

  it("supplies the api and the base URL for OUR provider", async () => {
    const src = await resolved();
    assert.deepEqual(src.normalizeTransport({ provider: PROVIDER_ID, modelId: "ckpt-7" }), {
      api: PROVIDER_TRANSPORT_API,
      baseUrl: "https://gpu.example/v1",
    });
  });

  it("answers NOTHING for every other provider", async () => {
    // ⚠ `normalizeProviderTransportWithPlugin` tries the matched provider and
    // then LOOPS OVER EVERY OTHER registered provider plugin, taking the first
    // return that changes api or baseUrl. The context carries no way to
    // decline other than `ctx.provider`, so answering unconditionally would
    // silently redirect the customer's Anthropic/OpenAI traffic to our
    // gateway on a turn we were never asked about.
    const src = await resolved();
    for (const provider of ["anthropic", "openai", "openrouter", "google",
      "", undefined, `${PROVIDER_ID}-x`, PROVIDER_ID.toUpperCase()]) {
      assert.equal(
        src.normalizeTransport({ provider, modelId: "claude-opus-5" }), undefined,
        `provider=${JSON.stringify(provider)} must be left alone`,
      );
    }
    assert.equal(src.normalizeTransport(null), undefined);
    assert.equal(src.normalizeTransport(undefined), undefined);
  });

  it("does not re-append /chat/completions", async () => {
    const src = await resolved();
    assert.doesNotMatch(
      src.normalizeTransport({ provider: PROVIDER_ID }).baseUrl,
      /chat\/completions/,
    );
  });
});


describe("registerServingPolicy — the seams, wired", () => {
  it("subscribes both hooks and registers the provider", async () => {
    const api = hostApi();
    const src = registerServingPolicy(api, {
      config: productionConfig(),
      pluginId: PLUGIN_ID,
      logger: fakeLogger(),
      transport: fakeTransport(),
      hostConfig: {},
    });
    assert.ok(api.hook(PROMPT_HOOK_NAME), `${PROMPT_HOOK_NAME} must be subscribed`);
    assert.ok(api.hook(MODEL_HOOK_NAME), `${MODEL_HOOK_NAME} must be subscribed`);
    assert.equal(api.providers.length, 1);
    assert.equal(api.providers[0].id, PROVIDER_ID);
    assert.equal(typeof api.providers[0].normalizeTransport, "function");
    // ProviderPlugin requires {id, label, auth}.
    assert.equal(typeof api.providers[0].label, "string");
    assert.ok(Array.isArray(api.providers[0].auth));
    assert.equal(api.providers[0].auth[0].kind, "api_key");

    await src.resolve(fakeTransport());
    assert.deepEqual(api.hook(PROMPT_HOOK_NAME)({ prompt: "", messages: [] }, TURN),
      { systemPrompt: APPROVED.text });
    assert.deepEqual(api.hook(MODEL_HOOK_NAME)({ prompt: "" }, TURN),
      { providerOverride: PROVIDER_ID, modelOverride: "ckpt-7" });
    // The registered provider's seam is the source's, not a second copy.
    assert.deepEqual(api.providers[0].normalizeTransport({ provider: PROVIDER_ID }), {
      api: PROVIDER_TRANSPORT_API, baseUrl: "https://gpu.example/v1",
    });
    assert.equal(api.providers[0].normalizeTransport({ provider: "anthropic" }), undefined);
  });

  it("the manifest declares the provider it registers, or nothing consults it", async () => {
    // A plugin's provider surface is live only when the manifest's
    // `providers` array is non-empty AND the plugin is activated. Registering
    // one the manifest does not declare is a registration nothing reads.
    const { readFileSync } = await import("node:fs");
    const manifest = JSON.parse(readFileSync(
      new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    assert.deepEqual(manifest.providers, [PROVIDER_ID]);
  });

  it("waits for the registration chain before reading", async () => {
    // Registration is the ONLY producer of the agent row, and three
    // control-plane calls racing at plugin load is three chances to be
    // rate-limited on a cold start. `announce` is sequenced behind `enrol` for
    // the same reason; this read sits behind both.
    const order = [];
    let release;
    const after = new Promise((r) => { release = r; })
      .then(() => order.push("enrol"));
    const transport = {
      async policyCurrent() { order.push("policy"); return SERVED; },
      async promptCurrent() { return APPROVED; },
    };
    registerServingPolicy(hostApi(), {
      config: productionConfig(),
      pluginId: PLUGIN_ID, logger: fakeLogger(), transport, after, hostConfig: {},
    });
    release();
    await after;
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(order, ["enrol", "policy"]);
  });

  it("a rejecting registration chain still reaches the read", async () => {
    // `enrol` and `announce` both swallow, but a future edit must not be able
    // to take the policy read down with a failed registration.
    const src = registerServingPolicy(hostApi(), {
      config: productionConfig(),
      pluginId: PLUGIN_ID,
      logger: fakeLogger(),
      transport: fakeTransport(),
      after: Promise.reject(new Error("registration refused")),
      hostConfig: {},
    });
    for (let i = 0; i < 8 && !src.resolved; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(src.resolved, true);
    assert.equal(src.appliedPrompt, APPROVED.text);
    assert.ok(src.appliedModel);
  });

  it("subscribes NOTHING without a transport — the consent boundary, SAID OUT LOUD", () => {
    // It used to return in silence, directly after a startup line telling the
    // operator that production mode "DOES ... apply the system prompt your
    // control plane has approved". Every other not-doing-it path in this
    // package announces itself; this one contradicted the line before it.
    const api = hostApi();
    const logger = fakeLogger();
    const src = registerServingPolicy(api, {
      config: resolveConfig({}, {}),
      pluginId: PLUGIN_ID, logger, transport: null, hostConfig: {},
    });
    assert.equal(api.hooks.length, 0, "no key means no subscription at all");
    assert.equal(api.providers.length, 0, "and no provider either");
    assert.equal(src.appliedPrompt, null);
    assert.equal(src.appliedModel, null);
    const said = logger.lines.find((l) => l.includes("applying nothing"));
    assert.ok(said, "a keyless install must be told why nothing is applied");
    assert.ok(said.includes(NO_KEY_REASON), "and the reason must be the actual one");
    assert.ok(!logger.text().includes("api.on is missing"),
      "the refusal must name the real cause, not the other one");
  });

  it("names the OTHER unwired cause when it is the real one", () => {
    const logger = fakeLogger();
    registerServingPolicy({ config: {} }, {
      config: productionConfig(),
      pluginId: PLUGIN_ID, logger, transport: fakeTransport(), hostConfig: {},
    });
    assert.ok(logger.text().includes("api.on is missing"));
    assert.ok(!logger.text().includes(NO_KEY_REASON),
      "a host with no hook seam must not be reported as a missing key",
    );
  });

  it("the prompt kill switch subscribes NOTHING, and says so in the ONE phrasing", () => {
    const api = hostApi();
    const logger = fakeLogger();
    registerServingPolicy(api, {
      config: productionConfig({}, { PERCEPTEYE_APPLY_PROMPT: "0" }),
      pluginId: PLUGIN_ID, logger, transport: fakeTransport(), hostConfig: {},
    });
    assert.equal(api.hook(PROMPT_HOOK_NAME), undefined,
      `${PROMPT_HOOK_NAME} must not be subscribed when application is off`);
    // A COMMENT IS NOT A MECHANISM. `PROMPT_OFF_REASON` documents itself as
    // "said the same way wherever it is said", and this is what makes that
    // true: the log line must BE the constant, not a second phrasing of it.
    const said = logger.lines.find((l) => l.includes(PROMPT_HOOK_NAME));
    assert.ok(said);
    assert.ok(said.includes(PROMPT_OFF_REASON));
    // The model half is untouched by the prompt switch.
    assert.ok(api.hook(MODEL_HOOK_NAME));
  });

  it("the model kill switch subscribes NOTHING and registers NO provider", () => {
    const api = hostApi();
    const logger = fakeLogger();
    registerServingPolicy(api, {
      config: productionConfig({}, { PERCEPTEYE_APPLY_MODEL: "0" }),
      pluginId: PLUGIN_ID, logger, transport: fakeTransport(), hostConfig: {},
    });
    assert.equal(api.hook(MODEL_HOOK_NAME), undefined);
    assert.equal(api.providers.length, 0,
      "a provider nothing will point at is a registration with no consumer");
    const said = logger.lines.find((l) => l.includes(MODEL_HOOK_NAME));
    assert.ok(said);
    assert.ok(said.includes(MODEL_OFF_REASON));
    // The prompt half is untouched by the model switch.
    assert.ok(api.hook(PROMPT_HOOK_NAME));
  });

  it("says PLAINLY, once, when the conversation opt-in is missing", () => {
    // `api.on` accepts the subscription and the host drops it with a
    // diagnostic of its own, so without this the operator cannot tell a
    // missing opt-in from a control plane with nothing to serve.
    const api = hostApi();
    const logger = fakeLogger();
    const src = registerServingPolicy(api, {
      config: productionConfig(),
      pluginId: PLUGIN_ID, logger, transport: fakeTransport(),
      hostConfig: {}, conversationAccess: false,
    });
    assert.equal(api.hook(MODEL_HOOK_NAME), undefined);
    assert.equal(api.providers.length, 0);
    assert.ok(api.hook(PROMPT_HOOK_NAME), "the prompt hook is NOT conversation-gated");
    const said = logger.lines.filter((l) => l.includes("allowConversationAccess"));
    assert.equal(said.length, 1, "said once, not per turn");
    assert.match(said[0], /^warn:/);
    assert.ok(said[0].includes(modelHookBlockedReason(PLUGIN_ID)));
    assert.equal(src.modelRefusal, modelHookBlockedReason(PLUGIN_ID));
  });

  it("warns at startup when several agents run and none is named", () => {
    const logger = fakeLogger();
    const src = registerServingPolicy(hostApi(), {
      config: productionConfig(),
      pluginId: PLUGIN_ID, logger, transport: fakeTransport(),
      hostConfig: { agents: { list: [{ id: "main" }, { id: "support" }] } },
    });
    assert.equal(src.servedAgent.id, null);
    assert.ok(logger.lines.some((l) => l.startsWith("warn:") && /2 agents/.test(l)),
      "a feature that will refuse every run must say so at startup");
  });

  it("a throwing handler costs one turn's answer, never the turn", async () => {
    const api = hostApi();
    const src = registerServingPolicy(api, {
      config: productionConfig(),
      pluginId: PLUGIN_ID, logger: fakeLogger(), transport: fakeTransport(),
      hostConfig: {},
    });
    await src.resolve(fakeTransport());
    // The host isolates a throwing hook but warns per failure, and these
    // hooks sit in front of every turn.
    const boom = () => { throw new Error("boom"); };
    Object.defineProperty(src, "handle", { value: boom, configurable: true });
    Object.defineProperty(src, "handleModelResolve", { value: boom, configurable: true });
    assert.doesNotThrow(() => api.hook(PROMPT_HOOK_NAME)({}, TURN));
    assert.doesNotThrow(() => api.hook(MODEL_HOOK_NAME)({}, TURN));
  });

  it("a refused provider registration does not cost the prompt half", () => {
    const api = hostApi({
      registerProvider: () => { throw new Error("already registered"); },
    });
    const logger = fakeLogger();
    assert.doesNotThrow(() => registerServingPolicy(api, {
      config: productionConfig(),
      pluginId: PLUGIN_ID, logger, transport: fakeTransport(), hostConfig: {},
    }));
    assert.ok(api.hook(PROMPT_HOOK_NAME));
    assert.ok(logger.text().includes("already registered"));
  });

  it("the pair note is an ORDINARY confirmation when both halves land", async () => {
    const logger = fakeLogger();
    const src = createPolicySource({ pluginId: PLUGIN_ID, logger });
    await src.resolve(fakeTransport());
    const note = logger.lines.find((l) => l.includes("pair is intact"));
    assert.ok(note, "an intact pair must be reported, not left silent");
    assert.match(note, /^info:/, "it is a confirmation now, not a warning");
    assert.ok(!logger.text().includes("HALF THE PAIR"));
  });

  it("the pair note WARNS and names the missing half when only one lands", async () => {
    const logger = fakeLogger();
    const src = createPolicySource({ pluginId: PLUGIN_ID, logger });
    await src.resolve(fakeTransport({ policy: UNSERVED }));
    const note = logger.lines.find((l) => l.includes("HALF THE PAIR"));
    assert.ok(note);
    assert.match(note, /^warn:/);
    assert.match(note, /MODEL half/);
    assert.ok(
      note.includes(APPROVED.model_prompt_checksum.slice(0, 12)),
      "the checkpoint it was certified with must be recorded",
    );
  });
});


describe("the config kill switches", () => {
  it("are both ON by default", () => {
    assert.equal(resolveConfig({}, {}).applyPromptEnabled, true);
    assert.equal(resolveConfig({}, {}).applyModelEnabled, true);
  });

  it("honour every off spelling `capture` honours, from both sources", () => {
    for (const value of ["0", "false", "no", "off", "OFF", " False "]) {
      assert.equal(resolveConfig({ applyPrompt: value }, {}).applyPromptEnabled, false);
      assert.equal(resolveConfig({ applyModel: value }, {}).applyModelEnabled, false);
      assert.equal(
        resolveConfig({}, { PERCEPTEYE_APPLY_PROMPT: value }).applyPromptEnabled, false,
        `PERCEPTEYE_APPLY_PROMPT=${JSON.stringify(value)} must switch it off`,
      );
      assert.equal(
        resolveConfig({}, { PERCEPTEYE_APPLY_MODEL: value }).applyModelEnabled, false,
        `PERCEPTEYE_APPLY_MODEL=${JSON.stringify(value)} must switch it off`,
      );
    }
    assert.equal(resolveConfig({ applyPrompt: false }, {}).applyPromptEnabled, false);
    assert.equal(resolveConfig({ applyModel: false }, {}).applyModelEnabled, false);
  });

  it("a typo does not silently switch either off", () => {
    assert.equal(resolveConfig({ applyPrompt: "flase" }, {}).applyPromptEnabled, true);
    assert.equal(resolveConfig({ applyModel: "flase" }, {}).applyModelEnabled, true);
  });

  it("neither switch is the other", () => {
    const c = resolveConfig({}, { PERCEPTEYE_APPLY_MODEL: "0" });
    assert.equal(c.applyModelEnabled, false);
    assert.equal(c.applyPromptEnabled, true);
  });
});


describe("mode decides it, structurally", () => {
  const modeApi = () => hostApi({ logger: { info() {}, warn() {} }, config: {} });

  it("training mode never subscribes either seam", () => {
    const api = modeApi();
    const out = register(api, { apiKey: "pefw_x" }, {
      PERCEPTEYE_AGENT_MODE: "training",
    });
    assert.equal(out.serving, null, "training must not construct a policy source");
    assert.equal(api.hook(PROMPT_HOOK_NAME), undefined,
      "a rollout is evidence about the agent as configured; changing its " +
      "prompt moves the behaviour with no weight change behind it");
    assert.equal(api.hook(MODEL_HOOK_NAME), undefined);
    assert.equal(api.providers.length, 0);
  });

  /**
   * The WHOLE seam, end to end: a real `register()`, the real transport, the
   * real HTTP client, and the two endpoints answering their real payloads.
   *
   * `globalThis.fetch` rather than an injected stub because
   * `ControlPlaneClient` captures it at construction and there is no seam
   * through `register` -- and adding one would be a test-only parameter on the
   * host's own entry point. Restored in `finally`; node:test runs each file in
   * its own process and the tests in a file in order.
   */
  it("production mode wires BOTH halves end to end, from register()", async () => {
    const root = mkdtempSync(join(tmpdir(), "percepteye-policy-"));
    const realFetch = globalThis.fetch;
    const paths = [];
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      paths.push(path);
      const body = path.endsWith("/policy/current") ? SERVED
        : path.endsWith("/prompt/current") ? APPROVED
          : path.endsWith("/capture") ? { capture: { turns: false, reason: "off" } }
            : {};
      return new Response(JSON.stringify(body), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    try {
      const api = modeApi();
      // The conversation opt-in the model half needs, as an operator writes it.
      api.config = {
        plugins: { entries: { [PLUGIN_ID]: { hooks: { allowConversationAccess: true } } } },
      };
      const out = register(api, { apiKey: "pefw_x" }, {
        PERCEPTEYE_AGENT_MODE: "production", PERCEPTEYE_CAPTURE_DIR: root,
      });
      assert.ok(out.serving, "the policy source must be reachable from the handle");
      for (const key of ["policy", "prompt", "appliedPrompt", "appliedModel",
        "refusal", "modelRefusal", "servedAgent"]) {
        assert.ok(key in out.serving, `the handle must expose ${key}`);
      }
      assert.ok(api.hook(PROMPT_HOOK_NAME), `${PROMPT_HOOK_NAME} must be subscribed`);
      assert.ok(api.hook(MODEL_HOOK_NAME), `${MODEL_HOOK_NAME} must be subscribed`);
      assert.equal(api.providers.length, 1);

      for (let i = 0; i < 40 && !out.serving.resolved; i += 1) {
        await new Promise((r) => setImmediate(r));
      }
      assert.equal(out.serving.resolved, true, "the startup read never completed");
      assert.deepEqual(
        api.hook(PROMPT_HOOK_NAME)({ prompt: "hi", messages: [] }, TURN),
        { systemPrompt: APPROVED.text },
        "the approved prompt must reach the host through the hook's RETURN",
      );
      assert.deepEqual(
        api.hook(MODEL_HOOK_NAME)({ prompt: "hi" }, TURN),
        { providerOverride: PROVIDER_ID, modelOverride: "ckpt-7" },
        "the approved model must reach the host through the hook's RETURN",
      );
      assert.deepEqual(
        api.providers[0].normalizeTransport({ provider: PROVIDER_ID }),
        { api: PROVIDER_TRANSPORT_API, baseUrl: "https://gpu.example/v1" },
        "and the base URL through the provider's transport seam",
      );
      // Both reads happen, exactly once each, and only after registration.
      assert.equal(paths.filter((p) => p.endsWith("/policy/current")).length, 1);
      assert.equal(paths.filter((p) => p.endsWith("/prompt/current")).length, 1);
      // The paths the package addresses, unchanged: the base URL already
      // carries /api/flywheel/v1 and the client appends the bare path.
      assert.ok(paths.includes("/api/flywheel/v1/policy/current"));
      assert.ok(paths.includes("/api/flywheel/v1/prompt/current"));
    } finally {
      globalThis.fetch = realFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the startup line says what will ACTUALLY happen, keyless or not", () => {
    const root = mkdtempSync(join(tmpdir(), "percepteye-startup-"));
    try {
      // KEYLESS: no transport, no subscription, nothing applied. The line
      // used to promise the opposite unconditionally.
      const bare = hostApi({ logger: fakeLogger(), config: {} });
      register(bare, {}, {
        PERCEPTEYE_AGENT_MODE: "production", PERCEPTEYE_CAPTURE_DIR: root,
      });
      const keyless = bare.logger.lines.find((l) => l.includes("claims no rollout"));
      assert.ok(keyless);
      assert.match(keyless, /applies NOTHING your control plane has approved/);
      assert.ok(!/It also applies/.test(keyless));

      // KEYED, with the conversation opt-in: both halves are claimed.
      const full = hostApi({
        logger: fakeLogger(),
        config: { plugins: { entries: { [PLUGIN_ID]: { hooks: { allowConversationAccess: true } } } } },
      });
      register(full, { apiKey: "pefw_x" }, {
        PERCEPTEYE_AGENT_MODE: "production", PERCEPTEYE_CAPTURE_DIR: root,
      });
      const both = full.logger.lines.find((l) => l.includes("claims no rollout"));
      assert.match(both, /It also applies the system prompt and the model/);

      // KEYED, no opt-in: the prompt half only, and the line says only that.
      const promptOnly = hostApi({ logger: fakeLogger(), config: {} });
      register(promptOnly, { apiKey: "pefw_x" }, {
        PERCEPTEYE_AGENT_MODE: "production", PERCEPTEYE_CAPTURE_DIR: root,
      });
      const one = promptOnly.logger.lines.find((l) => l.includes("claims no rollout"));
      assert.match(one, /It also applies the system prompt your control plane/);
      assert.ok(!/and the model/.test(one),
        "the model half cannot fire without the conversation opt-in, so the " +
        "line must not claim it",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not read the policy until registration has SETTLED", async () => {
    // A MUTATION WROTE THIS TEST. Removing `started` from what `capture.js`
    // returns -- so `index.js` sequences the read behind nothing -- left the
    // suite entirely green, because the only thing asserting the order was the
    // ORDER THE REQUESTS WERE ISSUED IN, and both are microtasks scheduled in
    // source order. That proxy survives the bug it was there to catch.
    //
    // The property is that the read waits for registration to FINISH, so it is
    // asserted by holding the registration open: under the sequencing, nothing
    // asks for a policy while /agents is still in flight.
    const root = mkdtempSync(join(tmpdir(), "percepteye-policy-order-"));
    const realFetch = globalThis.fetch;
    const paths = [];
    let releaseRegistration;
    const held = new Promise((r) => { releaseRegistration = r; });
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path.endsWith("/agents")) await held;
      const body = path.endsWith("/policy/current") ? SERVED
        : path.endsWith("/prompt/current") ? APPROVED
          : {};
      return new Response(JSON.stringify(body), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    try {
      const out = register(modeApi(), { apiKey: "pefw_x" }, {
        PERCEPTEYE_AGENT_MODE: "production", PERCEPTEYE_CAPTURE_DIR: root,
      });
      for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
      assert.deepEqual(
        paths.filter((p) => p.endsWith("/policy/current")), [],
        "the policy read started while registration was still in flight; " +
        "three control-plane calls racing on a cold start is three chances " +
        "to be rate-limited before the agent has served a turn",
      );
      releaseRegistration();
      for (let i = 0; i < 40 && !out.serving.resolved; i += 1) {
        await new Promise((r) => setImmediate(r));
      }
      assert.equal(out.serving.resolved, true, "the read must still happen after");
      assert.equal(out.serving.appliedPrompt, APPROVED.text);
    } finally {
      releaseRegistration();
      globalThis.fetch = realFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
