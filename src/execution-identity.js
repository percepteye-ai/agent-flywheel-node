/**
 * Exact, framework-neutral identity for one observed agent execution.
 *
 * The host adapter supplies opaque SHA-256 components for implementation and
 * mutable state that no model-call hook can see. Core combines those with the
 * complete prompt/tool/model observation made at `llm_input`; it never knows
 * what a component means and never accepts a caller-authored final digest.
 *
 * No component, incomplete discovery, or two different observations in one
 * run means no affirmative identity. That is an abstention, not an error and
 * never a reason to interrupt the customer's agent.
 */
import { createHash } from "node:crypto";

import { buildRecord, normalizeTools } from "./describe.js";
import { SDK_UA } from "./http.js";
import { CONTRACT_VERSION } from "./wire.js";

const OBSERVATION_DOMAIN = "percepteye-agent-observation-v1\0";
const EXECUTION_DOMAIN = "percepteye-agent-execution-v1\0";
const LOWER_SHA256 = /^[0-9a-f]{64}$/;
const MAX_PENDING_IDENTITIES = 4096;

/** Unicode-code-point ordering, matching Python rather than UTF-16 sort. */
function compareStrings(left, right) {
  const a = [...left].map((c) => c.codePointAt(0));
  const b = [...right].map((c) => c.codePointAt(0));
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** UTF-8 cannot encode an unpaired UTF-16 surrogate without replacing it. */
function hasLoneSurrogate(value) {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Canonical IEEE-754 spelling shared with the Python SDK. */
function f64Hex(value, path) {
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new Error("execution identity integer is outside the exact JSON range at " + path);
  }
  if (!Number.isFinite(value)) {
    throw new Error("execution identity contains a non-finite number at " + path);
  }
  const normalized = Object.is(value, -0) ? 0 : value;
  const bytes = new ArrayBuffer(8);
  new DataView(bytes).setFloat64(0, normalized, false);
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Typed canonical encoding for the deliberately JSON-only vocabulary. */
function canonicalJson(value, path = "$", parents = new Set()) {
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) {
      throw new Error("execution identity contains invalid Unicode at " + path);
    }
    return "[\"string\"," + JSON.stringify(value) + "]";
  }
  if (value === null) return "[\"null\"]";
  if (typeof value === "boolean") {
    return "[\"boolean\"," + JSON.stringify(value) + "]";
  }
  if (typeof value === "number") {
    return "[\"number_f64\"," + JSON.stringify(f64Hex(value, path)) + "]";
  }
  if (typeof value !== "object") {
    throw new Error(
      "execution identity contains unsupported " + typeof value + " at " + path,
    );
  }
  if (parents.has(value)) {
    throw new Error("execution identity contains a cycle at " + path);
  }
  parents.add(value);
  try {
    if (Array.isArray(value)) {
      return "[\"array\",[" + value.map(
        (item, index) => canonicalJson(item, path + "[" + index + "]", parents),
      ).join(",") + "]]";
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error("execution identity contains a non-JSON object at " + path);
    }
    const keys = Object.keys(value).sort(compareStrings);
    if (keys.some(hasLoneSurrogate)) {
      throw new Error("execution identity contains an invalid Unicode object key at " + path);
    }
    return "[\"object\",[" + keys.map((key) => (
      "[" + JSON.stringify(key) + "," +
      canonicalJson(value[key], path + "." + key, parents) + "]"
    )).join(",") + "]]";
  } finally {
    parents.delete(value);
  }
}

function digest(domain, value) {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

export const canonicalObservationSha256 = (value) =>
  digest(OBSERVATION_DOMAIN, value);

export const executionDescriptorSha256 = (value) =>
  digest(EXECUTION_DOMAIN, value);

export const isLowerSha256 = (value) =>
  typeof value === "string" && LOWER_SHA256.test(value);

/** Validate adapter-owned evidence without assigning meaning to its names. */
export function normalizeExecutionSnapshot(raw) {
  if (raw === undefined || raw === null) {
    return {
      snapshot: null,
      reason: "no execution snapshot was supplied by the host adapter",
    };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { snapshot: null, reason: "executionSnapshot must be an object" };
  }
  const adapterName = typeof raw.adapterName === "string"
    ? raw.adapterName.trim()
    : "";
  if (!adapterName) {
    return { snapshot: null, reason: "executionSnapshot.adapterName is required" };
  }
  if (hasLoneSurrogate(adapterName)) {
    return {
      snapshot: null,
      reason: "executionSnapshot.adapterName contains invalid Unicode",
    };
  }
  if (raw.executionIdentityComplete !== true) {
    return {
      snapshot: null,
      reason: "the host adapter did not attest a complete execution snapshot",
    };
  }
  const supplied = raw.executionComponents;
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
    return {
      snapshot: null,
      reason: "executionSnapshot.executionComponents must be an object",
    };
  }
  const components = {};
  for (const name of Object.keys(supplied).sort(compareStrings)) {
    if (!name.trim() || hasLoneSurrogate(name)) {
      return { snapshot: null, reason: "execution component names must be non-empty" };
    }
    if (name === "execution_sha256") {
      return {
        snapshot: null,
        reason: "execution components must not author execution_sha256",
      };
    }
    if (!isLowerSha256(supplied[name])) {
      return {
        snapshot: null,
        reason: `execution component ${JSON.stringify(name)} is not lowercase SHA-256`,
      };
    }
    components[name] = supplied[name];
  }
  if (Object.keys(components).length === 0) {
    return {
      snapshot: null,
      reason: "a complete execution snapshot needs at least one component digest",
    };
  }
  return {
    snapshot: Object.freeze({
      adapterName,
      executionComponents: Object.freeze(components),
      executionIdentityComplete: true,
    }),
    reason: null,
  };
}

/** Whether one host observation can support an exact identity. */
function exactObservation(event, ctx) {
  const record = buildRecord(event, ctx);
  const rawTools = event?.tools;
  if (!Array.isArray(rawTools)) return null;
  const tools = normalizeTools(rawTools);
  // Dropping one malformed tool from identity would make two different host
  // catalogues collapse to the same digest while the public description still
  // looked healthy. Discovery may remain advisory; identity must abstain.
  if (tools.length !== rawTools.length) return null;
  if (typeof event?.systemPrompt !== "string" || !event.systemPrompt) return null;
  if (typeof event?.provider !== "string" || !event.provider.trim()) return null;
  if (typeof event?.model !== "string" || !event.model.trim()) return null;
  const incomplete = record.incomplete ?? [];
  if (incomplete.some((item) => item !== "tool_annotations")) return null;
  return {
    discovered: record,
    // Hash before the public/JSONB projection scrubs strings and normalises
    // host tool envelopes. The projection remains useful downstream, but its
    // deliberate loss must never make two observed executions share an exact
    // identity. Unsupported/cyclic host values abstain in canonicalJson.
    full: {
      system_prompt: event.systemPrompt,
      tools: rawTools,
      provider: event.provider,
      model: event.model,
    },
  };
}

function runKey(event, ctx) {
  const runId = event?.runId ?? ctx?.runId;
  return typeof runId === "string" && runId.trim()
    ? `run:${runId.trim()}`
    : null;
}

/**
 * Reconcile observations and retain the answer only for the run that made it.
 *
 * A single run seeing two descriptors is permanently conflicted in memory.
 * This is intentional: last-write-wins would retroactively label the earlier
 * calls with whichever prompt/model happened to be observed last.
 */
export function createExecutionIdentityTracker({
  executionSnapshot = null,
  mode,
  agentId,
} = {}) {
  const normalized = normalizeExecutionSnapshot(executionSnapshot);
  const byContext = new Map();
  const conflicted = new Set();

  function bind(key, digestValue) {
    if (conflicted.has(key)) return;
    const prior = byContext.get(key);
    if (prior === undefined || prior === digestValue) {
      byContext.set(key, digestValue);
      while (byContext.size > MAX_PENDING_IDENTITIES) {
        byContext.delete(byContext.keys().next().value);
      }
      return;
    }
    byContext.delete(key);
    conflicted.add(key);
    while (conflicted.size > MAX_PENDING_IDENTITIES) {
      conflicted.delete(conflicted.values().next().value);
    }
  }

  function fingerprintFor(event, ctx = {}) {
    const key = runKey(event, ctx);
    if (key === null || conflicted.has(key)) return null;
    const value = byContext.get(key);
    return value === undefined ? null : { execution_sha256: value };
  }

  function consumeFingerprintFor(event, ctx = {}) {
    const key = runKey(event, ctx);
    if (key === null) return null;
    const fingerprint = fingerprintFor(event, ctx);
    byContext.delete(key);
    conflicted.delete(key);
    return fingerprint;
  }

  function observe(event, ctx = {}) {
    if (normalized.snapshot === null) return null;
    let observed;
    try {
      observed = exactObservation(event, ctx);
    } catch {
      // Host hook payloads are untrusted. Cyclic or exotic tool schemas make
      // exact identity unknowable; they must never escape into the agent run.
      return null;
    }
    if (observed === null) return null;
    const key = runKey(event, ctx);
    if (key === null) return null;
    let observation;
    let execution;
    try {
      observation = canonicalObservationSha256(observed.full);
      execution = executionDescriptorSha256({
        schema: "percepteye.agent_execution/v1",
        sdk: SDK_UA,
        contract_version: CONTRACT_VERSION,
        entrypoint: {
          kind: "host_plugin",
          framework: "openclaw",
          agent_id: agentId,
          adapter: normalized.snapshot.adapterName,
        },
        configuration: {
          mode,
          reports_tool_calls: true,
        },
        discovered_agent: observed.discovered,
        discovery_observation_sha256: observation,
        attested_components: normalized.snapshot.executionComponents,
      });
    } catch {
      return null;
    }
    bind(key, execution);
    const fingerprint = fingerprintFor(event, ctx);
    return {
      fingerprint,
      // The caller persists a monotonic conflict marker. Returning only null
      // here would leave an earlier sidecar in place and falsely label the
      // mixed turn with the first descriptor.
      conflict: fingerprint === null && conflicted.has(key),
    };
  }

  return {
    observe,
    fingerprintFor,
    consumeFingerprintFor,
    get enabled() { return normalized.snapshot !== null; },
    get refusal() { return normalized.reason; },
  };
}
