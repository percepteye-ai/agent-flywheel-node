import "./support/home.js";
/**
 * The customer API reads (contract 1.51.0), case for case with the Python
 * SDK's tests/test_customer_api.py.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigurationError } from "../src/errors.js";
import {
  AGENT_REFUSAL_CODES, ATTACK_REFUSAL_CODES, CUSTOMER_CONTRACT_VERSION, CYBER_REFUSAL_CODES, CustomerApiClient,
  CustomerContractTooOld, CustomerRefusal, PROMPT_RUN_REFUSAL_CODES, RUN_LIST_REFUSAL_CODES,
  TRAINING_REFUSAL_CODES, customerApiBase,
} from "../src/customer-api.js";

function fake(status, body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { status, text: async () => (body === undefined ? "" : JSON.stringify(body)) };
  };
  return { calls, fetchImpl };
}

const KEY = "mck_test_key_value_123456";

describe("customer api", () => {
  it("pins contract 1.51.0 and its new codes", () => {
    assert.equal(CUSTOMER_CONTRACT_VERSION, "1.51.0");
    assert.deepEqual([...ATTACK_REFUSAL_CODES], [
      "attack_set_is_sealed",
      "attack_resistance_measuring",
      "attack_regression_not_accepted",
      "attack_approval_stale",
      "attack_regression_not_stated",
      "measurement_deadline_passed",
      "prompt_changed",
      "hillclimb_not_found",
      "round_not_found",
      "event_kind_is_the_platforms",
      "attack_unmeasured_undisclosed",
    ]);
    assert.deepEqual([...CYBER_REFUSAL_CODES], [
      "cyber_disabled", "cyber_training_disabled", "cyber_needs_training",
      "cyber_no_training_entry", "cyber_lane_has_no_attack_reward",
      "hillclimb_security_unknown", "cyber_attack_reward_not_comparable",
    ]);
    assert.deepEqual([...TRAINING_REFUSAL_CODES], [
      "opsd_prompts_exceed_host", "opsd_recipe_tokenizer_hub_unavailable",
      "opsd_recipe_tokenizer_refused", "opsd_recipe_tokenizer_platform_fault",
      "opsd_teacher_preflight_no_evidence_decisions", "training_diverged_at_lr",
      "training_unhealthy", "training_pool_cannot_train_objective",
      "opsd_chosen_model_not_trainable", "hillclimb_base_model_invalid",
    ]);
    assert.deepEqual([...RUN_LIST_REFUSAL_CODES], ["launch_uri_outside_org", "run_page_too_deep"]);
    assert.deepEqual([...PROMPT_RUN_REFUSAL_CODES], [
      "prompt_run_balance_too_small", "recorded_prompt_absent",
      "recorded_decisions_too_few", "recorded_prompt_mismatch",
      "prompt_objective_unprepared", "prompt_evolution_refused",
      "prompt_model_unreachable",
    ]);
    assert.deepEqual([...AGENT_REFUSAL_CODES], [
      "practice_rollouts_not_enabled", "practice_needs_a_training_process",
      "model_content_capture_not_enabled", "flywheel_no_task_source",
    ]);
  });

  it("answers eligibility for a training location, and says so (1.50.0)", async () => {
    const f = fake(200, { training_locations: {
      answered_for: "platform_gpu", default: "platform_pool", options: [
        { location: "platform_gpu", available: true, refusal: null, gpu_hosts: 2, gpu_hosts_free: 1 }] } });
    const c = new CustomerApiClient({ apiKey: KEY, baseUrl: "https://x.test/api/v2", fetchImpl: f.fetchImpl, env: {} });
    const e = await c.trainingEligibility({ agentId: "a1", trainingLocation: "platform_gpu" });
    assert.equal(e.training_locations.options[0].gpu_hosts_free, 1);
    assert.equal(new URL(f.calls[0].url).search, "?agent_id=a1&training_location=platform_gpu");
  });

  it("refuses an answer that is not for the asked location, as an older server gives", async () => {
    for (const body of [
      { prompt_optimization: {} },
      { training_locations: null },
      { training_locations: { answered_for: "platform_pool" } },
      ["not", "an", "object"],
    ]) {
      const { fetchImpl } = fake(200, body);
      const c = new CustomerApiClient({ apiKey: KEY, baseUrl: "https://x.test/api/v2", fetchImpl, env: {} });
      await assert.rejects(c.trainingEligibility({ trainingLocation: "platform_gpu" }),
        (e) => e instanceof CustomerContractTooOld && e instanceof ConfigurationError
          && /customer contract 1\.50\.0/.test(e.message));
    }
  });

  it("returns an older server's answer unchanged when no location is asked", async () => {
    const f = fake(200, { prompt_optimization: { enabled: false } });
    const c = new CustomerApiClient({ apiKey: KEY, baseUrl: "https://x.test/api/v2", fetchImpl: f.fetchImpl, env: {} });
    assert.deepEqual(await c.trainingEligibility({ productId: "p" }), { prompt_optimization: { enabled: false } });
    assert.equal(new URL(f.calls[0].url).search, "?product_id=p");
  });

  it("reads a run's attack resistance, and a refusal by its code", async () => {
    const ok = fake(200, { measurement: { state: "not_measured" } });
    const c = new CustomerApiClient({ apiKey: KEY, baseUrl: "https://x.test/api/v2", env: {}, fetchImpl: ok.fetchImpl });
    assert.equal((await c.getHillclimbSecurity("r/1")).measurement.state, "not_measured");
    assert.equal(ok.calls[0].url, "https://x.test/api/v2/hillclimbs/r%2F1/security");
    const no = fake(404, { detail: { code: "hillclimb_not_found", message: "no" } });
    const c2 = new CustomerApiClient({ apiKey: KEY, baseUrl: "https://x.test/api/v2", env: {}, fetchImpl: no.fetchImpl });
    await assert.rejects(c2.getHillclimbSecurity("r2"), (e) => e instanceof CustomerRefusal && e.code === "hillclimb_not_found");
  });

  it("finds /api/v2 beside the Flywheel API", () => {
    assert.equal(customerApiBase("https://x.test/api/flywheel/v1/", {}), "https://x.test/api/v2");
    assert.equal(customerApiBase("https://x.test/p/api/flywheel/v1", {}), "https://x.test/p/api/v2");
    assert.equal(customerApiBase("https://x.test/other", {}), "https://x.test/api/v2");
    assert.equal(customerApiBase(undefined, {}), "https://launch.percepteye.ai/api/v2");
    assert.equal(customerApiBase(" ", { PERCEPTEYE_CONTROL_PLANE_URL: "http://localhost:8000/api/flywheel/v1" }),
      "http://localhost:8000/api/v2");
  });

  it("refuses no key and an agent key", () => {
    assert.throws(() => new CustomerApiClient({ env: {} }), ConfigurationError);
    assert.throws(() => new CustomerApiClient({ apiKey: "pefw_abc", env: {} }), /agent key \(pefw_\)/);
    const c = new CustomerApiClient({ env: { PERCEPTEYE_MC_API_KEY: KEY } });
    assert.equal(c._headers.Authorization, `Bearer ${KEY}`);
  });

  it("lists runs with the 1.29.0 parameters and omits the unset", async () => {
    const f = fake(200, [{ run_id: "r1", prompt_evolution: { id: "e1" } }]);
    const c = new CustomerApiClient({ apiKey: KEY, baseUrl: "https://x.test/api/v2", fetchImpl: f.fetchImpl, env: {} });
    const rows = await c.listRuns({ productId: "p1", includePromptEvolutions: true, limit: 10, startedBefore: "2026-11-01T00:00:00Z" });
    assert.equal(rows[0].prompt_evolution.id, "e1");
    const u = new URL(f.calls[0].url);
    assert.equal(u.pathname, "/api/v2/runs");
    assert.deepEqual(Object.fromEntries(u.searchParams), {
      limit: "10", started_before: "2026-11-01T00:00:00Z", product_id: "p1", include_prompt_evolutions: "true",
    });
    assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  });

  it("reads eligibility for an agent and eval sets by page", async () => {
    const f = fake(200, { prompt_optimization: { enabled: true, mode: "offline", needs: "prepared_corpus", algorithms: [],
      model_under_test: { model: "m", label: "l", customer_model: false, reason: "r" } } });
    const c = new CustomerApiClient({ apiKey: KEY, baseUrl: "https://x.test/api/v2", fetchImpl: f.fetchImpl, env: {} });
    const e = await c.trainingEligibility({ agentId: "a1" });
    assert.equal(e.prompt_optimization.needs, "prepared_corpus");
    assert.equal(e.prompt_optimization.model_under_test.customer_model, false);
    assert.equal(new URL(f.calls[0].url).search, "?agent_id=a1");
    await c.listEvalSets({ productId: "p1", limit: 5, offset: 10 });
    const u = new URL(f.calls[1].url);
    assert.equal(u.pathname, "/api/v2/eval-sets");
    assert.equal(u.search, "?product_id=p1&limit=5&offset=10");
  });

  it("a refusal carries its code and plain words", async () => {
    const f = fake(422, { detail: {
      code: "recorded_prompt_absent", message: "no system message in 40 traces",
      customer_message: "These traces hold no system message.",
      customer_words: "Supply your prompt.", fault_owner: "customer", retryable: false,
      remediation: "supply the prompt as a twin",
    } });
    const c = new CustomerApiClient({ apiKey: KEY, baseUrl: "https://x.test/api/v2", fetchImpl: f.fetchImpl, env: {} });
    const err = await c.trainingEligibility({ productId: "p" }).catch((e) => e);
    assert.ok(err instanceof CustomerRefusal);
    assert.equal(err.statusCode, 422);
    assert.equal(err.code, "recorded_prompt_absent");
    assert.equal(err.refusalMessage, "no system message in 40 traces");
    assert.equal(err.customerMessage, "These traces hold no system message.");
    assert.equal(err.plainWords, "These traces hold no system message.");
    assert.equal(err.faultOwner, "customer");
    assert.equal(err.retryable, false);
    assert.equal(err.detail, null);
    const diverged = new CustomerRefusal(422, { detail: {
      code: "training_diverged_at_lr", message: "m",
      detail: { learning_rate: 2e-5, retry_learning_rate: 1e-5 } } });
    assert.deepEqual(diverged.detail, { learning_rate: 2e-5, retry_learning_rate: 1e-5 });
    const noMsg = new CustomerRefusal(422, { detail: { code: "run_page_too_deep", message: "m", customer_words: "Use an earlier date." } });
    assert.equal(noMsg.plainWords, "Use an earlier date.");
    const bare = new CustomerRefusal(403, { detail: "Forbidden" });
    assert.equal(bare.code, null);
    assert.equal(bare.plainWords, "Forbidden");
  });

  it("supportsContract reads the served majors", async () => {
    const yes = fake(200, { customer_contract_versions_supported: ["1"] });
    const c = new CustomerApiClient({ apiKey: KEY, baseUrl: "https://x.test/api/v2", fetchImpl: yes.fetchImpl, env: {} });
    assert.equal(await c.supportsContract(), true);
    assert.equal(new URL(yes.calls[0].url).pathname, "/api/v2/health");
    const no = fake(200, { customer_contract_versions_supported: ["2"] });
    const c2 = new CustomerApiClient({ apiKey: KEY, baseUrl: "https://x.test/api/v2", fetchImpl: no.fetchImpl, env: {} });
    assert.equal(await c2.supportsContract(), false);
  });
  it("answers false for a health body it cannot read, as the Python SDK does", async () => {
    for (const body of ["<html>ok</html>", ["1"], { customer_contract_versions_supported: "1" }]) {
      const { fetchImpl } = fake(200, body);
      const c = new CustomerApiClient({ apiKey: KEY, baseUrl: "https://x.test/api/v2", env: {}, fetchImpl });
      assert.equal(await c.supportsContract(), false);
    }
  });

  it("holds its refusal codes to the control plane's published contract", () => {
    // Copies of the control plane's codes. When PERCEPTEYE_CONTROL_PLANE_CHECKOUT
    // names its checkout (a release), each must be published with the status
    // this SDK documents; a variable that is set is a promise.
    const checkout = process.env.PERCEPTEYE_CONTROL_PLANE_CHECKOUT;
    if (!checkout) return;
    const doc = JSON.parse(readFileSync(join(checkout, "docs", "openapi.json"), "utf8"));
    const published = Object.fromEntries(doc["x-refusal-codes"].map((e) => [e.code, e.http_status]));
    const expected = {
      launch_uri_outside_org: 403, run_page_too_deep: 422, prompt_run_balance_too_small: 402,
      recorded_prompt_absent: 422, recorded_decisions_too_few: 422, recorded_prompt_mismatch: 422,
      attack_set_is_sealed: 409,
      attack_resistance_measuring: 409,
      attack_regression_not_accepted: 409,
      attack_approval_stale: 409,
      attack_regression_not_stated: 409,
      measurement_deadline_passed: 409,
      prompt_changed: 409,
      hillclimb_not_found: 404,
      round_not_found: 404,
      event_kind_is_the_platforms: 403,
      // 1.32.0 through 1.49.0: every code those bumps published but 1.40.0's
      // three prompt_box_* codes (see PROMPT_RUN_REFUSAL_CODES).
      opsd_prompts_exceed_host: 422,
      opsd_recipe_tokenizer_hub_unavailable: 503,
      opsd_recipe_tokenizer_refused: 422,
      opsd_recipe_tokenizer_platform_fault: 503,
      opsd_teacher_preflight_no_evidence_decisions: 409,
      attack_unmeasured_undisclosed: 409,
      training_diverged_at_lr: 422,
      training_unhealthy: 422,
      prompt_objective_unprepared: 500,
      prompt_evolution_refused: 409,
      prompt_model_unreachable: 422,
      cyber_disabled: 503,
      cyber_training_disabled: 503,
      cyber_needs_training: 422,
      cyber_no_training_entry: 422,
      cyber_lane_has_no_attack_reward: 422,
      hillclimb_security_unknown: 422,
      training_pool_cannot_train_objective: 503,
      cyber_attack_reward_not_comparable: 422,
      opsd_chosen_model_not_trainable: 422,
      hillclimb_base_model_invalid: 422,
      // 1.51.0: the hillclimb door's refusals of an agent's switch, raised
      // before 1.51.0 published them.
      practice_rollouts_not_enabled: 422,
      practice_needs_a_training_process: 422,
      model_content_capture_not_enabled: 422,
      flywheel_no_task_source: 422,
    };
    const known = [...RUN_LIST_REFUSAL_CODES, ...PROMPT_RUN_REFUSAL_CODES, ...ATTACK_REFUSAL_CODES,
      ...CYBER_REFUSAL_CODES, ...TRAINING_REFUSAL_CODES, ...AGENT_REFUSAL_CODES];
    assert.equal(new Set(known).size, known.length, "a code is in two groups");
    assert.deepEqual([...known].sort(), Object.keys(expected).sort());
    for (const [code, status] of Object.entries(expected)) assert.equal(published[code], status, code);
    assert.equal(doc["x-customer-contract-version"], CUSTOMER_CONTRACT_VERSION);
  });
});
