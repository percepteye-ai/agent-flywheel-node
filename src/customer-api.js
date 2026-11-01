/**
 * Reads of the customer-automation API (customer contract 1.30.0).
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
 */
import { DEFAULT_CONTROL_PLANE } from "./config.js";
import { ConfigurationError } from "./errors.js";
import { SDK_VERSION } from "./http.js";

export const CUSTOMER_CONTRACT_VERSION = "1.30.0";
const MAJOR = CUSTOMER_CONTRACT_VERSION.split(".")[0];

export const ENV_CUSTOMER_API_KEY = "PERCEPTEYE_MC_API_KEY";

export const RUN_LIST_REFUSAL_CODES = Object.freeze([
  "launch_uri_outside_org", "run_page_too_deep",
]);
export const PROMPT_RUN_REFUSAL_CODES = Object.freeze([
  "prompt_run_balance_too_small",
  "recorded_prompt_absent",
  "recorded_decisions_too_few",
  "recorded_prompt_mismatch",
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
    this.faultOwner = text(refusal.fault_owner);
    this.retryable = typeof refusal.retryable === "boolean" ? refusal.retryable : null;
  }

  /** The cause in plain words, else the remedy in plain words, else the message. */
  get plainWords() {
    return this.customerMessage ?? this.customerWords ?? this.refusalMessage;
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
    const served = body?.customer_contract_versions_supported ?? [];
    return served.map(String).includes(MAJOR);
  }

  /**
   * GET /runs. With `includePromptEvolutions` each prompt evolution is one row
   * (`prompt_evolution` set) in place of its arms; every run of an evolution
   * names it in `prompt_evolution_id`. Paging past the server's depth is
   * refused `run_page_too_deep`: use `startedBefore`.
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
   * path, and (1.30.0) `model_under_test` the model a prompt run would test on.
   */
  trainingEligibility({ agentId, productId } = {}) {
    return this._get("/training/eligibility", { agent_id: agentId, product_id: productId });
  }

  /** GET /eval-sets: a Product's evaluation sets, one page. */
  listEvalSets({ productId, limit, offset } = {}) {
    return this._get("/eval-sets", { product_id: productId, limit, offset });
  }
}
