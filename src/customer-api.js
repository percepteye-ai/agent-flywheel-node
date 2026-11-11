/**
 * Reads of the customer-automation API (customer contract 1.51.0).
 *
 * The rest of this package speaks the agent contract (`flywheel/1`) under
 * `/api/flywheel/v1` with an agent's `pefw_` key. The runs list, training
 * eligibility and evaluation sets are the CUSTOMER contract's, served under
 * `/api/v2` on the same origin to a customer-automation `mck_` key (the one
 * `pe login` or the dashboard's Settings issues). An agent key is refused
 * there, so this client refuses it before sending anything.
 *
 * The Python SDK's `agent_flywheel.customer_api` is the same surface, name for
 * name (snake_case there). A refusal's `customerMessage` (1.29.0) is the cause
 * in plain words for a person; `customerWords` is the code's remedy in plain
 * words; `plainWords` is what to show a person. The words are the server's.
 *
 * Every read works against any 1.x server from 1.30.0 on. One argument needs a
 * newer one: `trainingEligibility({ trainingLocation })` needs 1.50.0, and an
 * older server, which ignores the query and answers for the organization's own
 * setting, is refused with `CustomerContractTooOld` rather than believed.
 */
import { DEFAULT_CONTROL_PLANE } from "./config.js";
import { ConfigurationError } from "./errors.js";
import { SDK_VERSION } from "./http.js";

export const CUSTOMER_CONTRACT_VERSION = "1.51.0";
const MAJOR = CUSTOMER_CONTRACT_VERSION.split(".")[0];

export const ENV_CUSTOMER_API_KEY = "PERCEPTEYE_MC_API_KEY";

/**
 * 1.29.0: what a launch may read and how far the runs list reaches. 1.51.0: a
 * launch input only a platform operator may set (the experiment-only
 * `environment_task_grader`, which left the hill climb request's schema); and
 * a launch of a coding agent whose own code runs on the platform, refused
 * before any run exists because the deployment has no isolated sandbox for
 * that code (`code_sandbox_not_configured`, 503, the platform's: retrying does
 * not help) or its sandbox is not answering (`code_sandbox_unreachable`, 503,
 * the platform's: retry shortly).
 */
export const RUN_LIST_REFUSAL_CODES = Object.freeze([
  "launch_uri_outside_org", "run_page_too_deep",
  "launch_input_requires_platform_operator",
  "code_sandbox_not_configured", "code_sandbox_unreachable",
]);
/**
 * 1.29.0: why a prompt run cannot start (`prompt_optimization` says ahead).
 * 1.38.0: a prompt-objective hill climb's evolution could not start; 1.39.0:
 * the customer's own model is unreachable (no stand-in is ever used). The
 * three 1.40.0 codes (`prompt_box_*`) are not carried: they are the platform's
 * own prompt-optimization host, the platform's fault, and one names its
 * serving stack, which this package does not publish.
 */
export const PROMPT_RUN_REFUSAL_CODES = Object.freeze([
  "prompt_run_balance_too_small",
  "recorded_prompt_absent",
  "recorded_decisions_too_few",
  "recorded_prompt_mismatch",
  "prompt_objective_unprepared",
  "prompt_evolution_refused",
  "prompt_model_unreachable",
]);
/**
 * 1.30.0: the held-out attack set a promotion is measured on never changes.
 * 1.31.0: the attack gate and the attack measurement refuse by name.
 * 1.34.0: a person's yes that was not shown an unmeasured attack resistance.
 */
export const ATTACK_REFUSAL_CODES = Object.freeze([
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
/**
 * Why a hill climb's cyber choice cannot apply: refused, never downgraded
 * (1.44.0), and a trainer whose rewards cannot compare attacks (1.46.0).
 */
export const CYBER_REFUSAL_CODES = Object.freeze([
  "cyber_disabled",
  "cyber_training_disabled",
  "cyber_needs_training",
  "cyber_no_training_entry",
  "cyber_lane_has_no_attack_reward",
  "hillclimb_security_unknown",
  "cyber_attack_reward_not_comparable",
]);
/**
 * Why a training run is refused or stopped: the GPU host's prompt fit, the
 * recipe tokenizer and the teacher gate's evidence (1.32.0); a diverged or
 * unhealthy train (1.36.0, 1.37.0; `CustomerRefusal.detail` carries the
 * evidence); a pool that cannot train the objective (1.46.0); a chosen model
 * that cannot be trained (1.49.0); a base model named by no usable id, a
 * destination that cannot train the algorithm, a checkpoint another
 * organization's runs produced (1.51.0, raised before it published them).
 */
export const TRAINING_REFUSAL_CODES = Object.freeze([
  "opsd_prompts_exceed_host",
  "opsd_recipe_tokenizer_hub_unavailable",
  "opsd_recipe_tokenizer_refused",
  "opsd_recipe_tokenizer_platform_fault",
  "opsd_teacher_preflight_no_evidence_decisions",
  "training_diverged_at_lr",
  "training_unhealthy",
  "training_pool_cannot_train_objective",
  "opsd_chosen_model_not_trainable",
  "hillclimb_base_model_invalid",
  "base_model_unresolvable",
  "destination_algorithm_unsupported",
  "provider_checkpoint_not_owned",
]);
/**
 * Why a round with your agent is refused before anything is spent (1.51.0;
 * Mission Control raised each before it published them): its "Allow practice
 * runs" switch is off, no `serve()` process runs it with
 * `PERCEPTEYE_AGENT_MODE=training`, its model-content capture is off for a
 * round read from its capture, it gives practice nothing to write tasks
 * from, or the product does not declare the agent the organization
 * registered (or declares one that cannot serve).
 */
export const AGENT_REFUSAL_CODES = Object.freeze([
  "practice_rollouts_not_enabled",
  "practice_needs_a_training_process",
  "model_content_capture_not_enabled",
  "flywheel_no_task_source",
  "flywheel_product_undeclared",
  "invalid_flywheel_spec",
]);

const FLYWHEEL_SUFFIX = "/api/flywheel/v1";
const CUSTOMER_PREFIX = "/api/v2";

const text = (v) => (typeof v === "string" && v.trim() ? v : null);

/** `/api/v2` beside the Flywheel API, on the control plane's origin. */
export function customerApiBase(controlPlaneUrl, env = process.env) {
  const raw = text(controlPlaneUrl) ?? text(env.PERCEPTEYE_CONTROL_PLANE_URL)
    ?? DEFAULT_CONTROL_PLANE;
  const url = new URL(raw.trim());
  const path = url.pathname.replace(/\/+$/, "");
  const prefix = path.endsWith(FLYWHEEL_SUFFIX)
    ? path.slice(0, -FLYWHEEL_SUFFIX.length)
    : "";
  return `${url.protocol}//${url.host}${prefix}${CUSTOMER_PREFIX}`;
}

export class CustomerRefusal extends Error {
  constructor(statusCode, body) {
    const detail = body && typeof body === "object" ? body.detail : undefined;
    const refusal = detail && typeof detail === "object" ? detail : {};
    const code = text(refusal.code);
    const message = text(refusal.message)
      ?? (typeof detail === "string" ? detail : null)
      ?? `HTTP ${statusCode}`;
    super(`HTTP ${statusCode}${code ? ` ${code}` : ""}: ${message}`);
    this.name = "CustomerRefusal";
    this.statusCode = statusCode;
    this.body = body;
    this.code = code;
    this.refusalMessage = message;
    this.customerMessage = text(refusal.customer_message);
    this.customerWords = text(refusal.customer_words);
    this.remediation = text(refusal.remediation);
    /**
     * The refusal's own evidence (`Refusal.detail`), such as `waiting_on`,
     * `host_prompt_fit`, `cause` or `chosen_model`; null when it carries none.
     */
    this.detail = refusal.detail && typeof refusal.detail === "object" && !Array.isArray(refusal.detail)
      ? { ...refusal.detail } : null;
    this.faultOwner = text(refusal.fault_owner);
    this.retryable = typeof refusal.retryable === "boolean" ? refusal.retryable : null;
  }

  /** The cause in plain words, else the remedy in plain words, else the message. */
  get plainWords() {
    return this.customerMessage ?? this.customerWords ?? this.refusalMessage;
  }
}

/**
 * The server answered, but on a customer contract older than the one a
 * requested argument needs, so its answer is not the one asked for.
 */
export class CustomerContractTooOld extends ConfigurationError {
  constructor(message) {
    super(message);
    this.name = "CustomerContractTooOld";
  }
}

function query(values) {
  const out = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    out.set(name, typeof value === "boolean" ? (value ? "true" : "false") : String(value));
  }
  const s = out.toString();
  return s ? `?${s}` : "";
}

export class CustomerApiClient {
  constructor({ apiKey, controlPlaneUrl, baseUrl, fetchImpl, env = process.env } = {}) {
    const key = (text(apiKey) ?? text(env[ENV_CUSTOMER_API_KEY]) ?? "").trim();
    if (!key) {
      throw new ConfigurationError(
        `a customer-automation key is required: pass apiKey or set ${ENV_CUSTOMER_API_KEY} `
        + "(run `pe login`, or issue one in the dashboard under Settings, control-plane keys)");
    }
    if (key.startsWith("pefw_")) {
      throw new ConfigurationError(
        "this is an agent key (pefw_), which the customer API refuses; it needs a "
        + "customer-automation key (mck_): run `pe login`, or issue one in the "
        + "dashboard under Settings, control-plane keys");
    }
    this.baseUrl = (baseUrl ?? customerApiBase(controlPlaneUrl, env)).replace(/\/+$/, "");
    this._fetch = fetchImpl ?? globalThis.fetch;
    this._headers = {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "X-Percepteye-Sdk": `agent-flywheel-node/${SDK_VERSION}`,
    };
  }

  async _get(path, params) {
    const resp = await this._fetch(`${this.baseUrl}${path}${query(params)}`, {
      method: "GET", headers: this._headers,
    });
    const raw = await resp.text();
    let body = null;
    if (raw) {
      try { body = JSON.parse(raw); } catch { body = raw; }
    }
    if (resp.status >= 400) throw new CustomerRefusal(resp.status, body);
    return body;
  }

  /** Whether the server speaks this client's contract major (GET /health). */
  async supportsContract() {
    const body = await this._get("/health", {});
    const served = body?.customer_contract_versions_supported;
    return Array.isArray(served) && served.map(String).includes(MAJOR);
  }

  /**
   * GET /runs. With `includePromptEvolutions` each prompt evolution is one row
   * (`prompt_evolution` set) in place of its arms; every run of an evolution
   * names it in `prompt_evolution_id`. A run also names what it was admitted
   * to optimise (`objective`, `security_mode`, `benchmark_eval_set_id`,
   * 1.42.0), the model it trains (`base_model`, 1.43.0), its trainer
   * (`algorithm`, 1.46.0) and the run it belongs to (`owner_run_id`, 1.47.0;
   * null for a run the customer started): one row per run the customer
   * started, the rest folded under it. A server older than those versions
   * omits the fields. Paging past the server's depth is refused
   * `run_page_too_deep`: use `startedBefore`.
   */
  listRuns({
    status, limit, offset, startedAfter, startedBefore, productId,
    includeBackground, includePromptEvolutions,
  } = {}) {
    return this._get("/runs", {
      status, limit, offset, started_after: startedAfter,
      started_before: startedBefore, product_id: productId,
      include_background: includeBackground,
      include_prompt_evolutions: includePromptEvolutions,
    });
  }

  /**
   * GET /training/eligibility; `prompt_optimization` says the agent's prompt
   * path, (1.29.0) `model_under_test` the model a prompt run would test on.
   * `security` (1.30.0; 1.44.0) is the `default` ("off": cyber is a choice),
   * whether it is `enabled`, per objective whether cyber is `available` (else
   * its `refusal`, one of `CYBER_REFUSAL_CODES`), and `measurement_funding`
   * ("run_quote": the attack arms are on the run's quote). `flash_reinforce`
   * (1.46.0) is that practice lane's `allowed`, `refusals` and `cost_bound`;
   * `opsd.trainable_models` (1.49.0) the models a hill climb may choose to
   * train.
   *
   * `trainingLocation` (1.50.0: "platform_pool" or "platform_gpu"; the server
   * refuses any other) answers for a run trained there instead of at the
   * organization's own setting; `training_locations` names the place answered
   * for (`answered_for`), the `default`, and per `options` entry whether it is
   * `available` (else its `refusal`) and, on our GPUs, `gpu_hosts` and
   * `gpu_hosts_free`. A server older than 1.50.0 ignores the argument and
   * answers for the organization's own setting; that answer is refused,
   * `CustomerContractTooOld`, never returned as the one asked for.
   */
  async trainingEligibility({ agentId, productId, trainingLocation } = {}) {
    const body = await this._get("/training/eligibility", {
      agent_id: agentId, product_id: productId, training_location: trainingLocation,
    });
    if (trainingLocation !== undefined && trainingLocation !== null) {
      const locations = body && typeof body === "object" && !Array.isArray(body)
        ? body.training_locations : null;
      const answered = locations && typeof locations === "object" ? locations.answered_for : null;
      if (answered !== trainingLocation) {
        throw new CustomerContractTooOld(
          `the control plane at ${this.baseUrl} answered /training/eligibility without `
          + `answering for training_location=${JSON.stringify(trainingLocation)}: choosing `
          + "where a run trains needs customer contract 1.50.0, and an older server answers "
          + "for the organization's own setting instead. Omit trainingLocation, or use a "
          + "newer Mission Control.");
      }
    }
    return body;
  }

  /** GET /eval-sets: a Product's evaluation sets, one page. */
  listEvalSets({ productId, limit, offset } = {}) {
    return this._get("/eval-sets", { product_id: productId, limit, offset });
  }

  /**
   * GET /hillclimbs/{runId}/security (1.30.0): the run's security mode and
   * why, and its attack-resistance measurement. `measurement.state` is never
   * a pass by omission: not_measured, measuring, not_enough_attacks,
   * attacks_unpaired, no_regression or regressed; its `readout.benchmarks`
   * (1.35.0) holds each attack benchmark to the same rule. `base` and
   * `checkpoints` (1.44.0) are the base model's and each certified round's
   * held-out attack pass rate; `external_benchmarks`, `benchmark_coverage` and
   * `capability` (1.45.0) are unpaired, ungated arms. Each is null
   * (`checkpoints` []) on a run that did not choose cyber, and absent on an
   * older server. A run that is not a hill climb of this organization is
   * refused 404 `hillclimb_not_found`.
   */
  getHillclimbSecurity(runId) {
    return this._get(`/hillclimbs/${encodeURIComponent(String(runId))}/security`, {});
  }
}
