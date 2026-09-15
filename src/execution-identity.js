/**
 * Exact, framework-neutral identity for one observed agent execution.
 *
 * The host adapter supplies opaque SHA-256 components for implementation and
 * mutable state that no model-call hook can see. Core combines those with the
 * complete prompt/tool/model observation made at `llm_input`; it never knows
 * what a component means and never accepts a caller-authored final digest. A
 * host adapter may also supply that same exact observation at startup, before
 * a rollout is claimed, so registration can bind the worker to the execution
 * identity its later reports must carry.
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
const STARTUP_OBSERVATION_KEYS = Object.freeze([
  "systemPrompt", "tools", "provider", "model",
]);
const STARTUP_OBSERVATION_KEY_SET = new Set(STARTUP_OBSERVATION_KEYS);

/** Recursively freeze an SDK-owned JSON tree before exposing it to callers. */
function freezeJsonTree(value, seen = new Set()) {
  if (
    !value || typeof value !== "object" || Object.isFrozen(value)
    || seen.has(value)
  ) return value;
  seen.add(value);
  for (const child of Object.values(value)) freezeJsonTree(child, seen);
  return Object.freeze(value);
}

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

/**
 * A startup observation is a closed, adapter-authored copy of the four host
 * facts runtime observation reads. Invalid or lossy evidence abstains from a
 * registration fingerprint without disabling exact runtime observations.
 */
function normalizeStartupObservation(raw) {
  try {
    if (raw === undefined || raw === null) return null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const proto = Object.getPrototypeOf(raw);
    if (proto !== Object.prototype && proto !== null) return null;
    const keys = Object.keys(raw);
    if (
      keys.length !== STARTUP_OBSERVATION_KEYS.length
      || keys.some((key) => !STARTUP_OBSERVATION_KEY_SET.has(key))
    ) return null;
    if (typeof raw.systemPrompt !== "string" || !raw.systemPrompt) return null;
    if (!Array.isArray(raw.tools)) return null;
    if (typeof raw.provider !== "string" || !raw.provider.trim()) return null;
    if (typeof raw.model !== "string" || !raw.model.trim()) return null;
    const copied = structuredClone({
      systemPrompt: raw.systemPrompt,
      tools: raw.tools,
      provider: raw.provider,
      model: raw.model,
    });
    return freezeJsonTree(copied);
  } catch {
    return null;
  }
}

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
  const startupObservation = normalizeStartupObservation(raw.startupObservation);
  return {
    snapshot: Object.freeze({
      adapterName,
      executionComponents: Object.freeze(components),
      executionIdentityComplete: true,
      startupObservation,
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
  return typeof runId === "string" && runId.length > 0
    ? `run:${runId}`
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

  /**
   * One canonical descriptor path for startup registration and runtime hooks.
   */
  function evidenceFromObservation(event, ctx = {}) {
    if (normalized.snapshot === null) return null;
    let observed;
    try {
      observed = exactObservation(event, ctx);
    } catch {
      // Host and adapter observations are untrusted. Cyclic or exotic tool
      // schemas make exact identity unknowable; they remain an abstention.
      return null;
    }
    if (observed === null) return null;
    try {
      const observation = canonicalObservationSha256(observed.full);
      const execution = executionDescriptorSha256({
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
      return Object.freeze({
        fingerprint: Object.freeze({ execution_sha256: execution }),
        description: freezeJsonTree(observed.discovered),
      });
    } catch {
      return null;
    }
  }

  // Computed ONCE. A later config-object mutation cannot move the worker
  // identity after registration, and callers receive only a frozen value.
  const registrationContext = typeof agentId === "string" && agentId.trim()
    ? { agentId }
    : {};
  const registrationEvidence = normalized.snapshot === null
    ? null
    : evidenceFromObservation(
      normalized.snapshot.startupObservation, registrationContext,
    );

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
    const key = runKey(event, ctx);
    if (key === null) return null;
    // Once a stable registration exists, every later observation must use its
    // configured agent name rather than a run/session-shaped fallback. If
    // startup evidence abstained, retain the legacy runtime descriptor path.
    const observationContext = registrationEvidence !== null
      && typeof agentId === "string" && agentId.trim()
      ? { ...ctx, agentId }
      : ctx;
    // A startup-capable adapter owns the exact fields its host cannot expose
    // per run. Reconcile, do not overwrite: every field the runtime does
    // expose wins and therefore changes/conflicts the digest; only an absent
    // field is supplied from the registered snapshot. Requiring at least one
    // runtime field prevents a bare run id from inheriting a startup identity.
    let observedEvent = event;
    if (registrationEvidence !== null) {
      const startup = normalized.snapshot.startupObservation;
      const observedAny = STARTUP_OBSERVATION_KEYS.some(
        (name) => event?.[name] !== undefined,
      );
      if (!observedAny) return null;
      observedEvent = { ...event };
      for (const name of STARTUP_OBSERVATION_KEYS) {
        if (observedEvent[name] === undefined) observedEvent[name] = startup[name];
      }
    }
    const candidate = evidenceFromObservation(observedEvent, observationContext);
    if (candidate === null) return null;
    bind(key, candidate.fingerprint.execution_sha256);
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
    get registrationFingerprint() {
      return registrationEvidence?.fingerprint ?? null;
    },
    get registrationDescription() {
      return registrationEvidence?.description ?? null;
    },
    get enabled() { return normalized.snapshot !== null; },
    get refusal() { return normalized.reason; },
  };
}

/**
 * `tracker` with every fingerprint withheld and its startup observation kept.
 *
 * For a DECLARED description (`describe`, see declaration.js): the declaration
 * still merges over what was observed at startup, but it is the customer's
 * word rather than an observation of what runs, so it anchors no execution
 * identity -- not at registration, not on a rollout report, not on a
 * production turn. The Python SDK withholds its digest the same way whenever
 * `describe=` contributed.
 */
export function withholdFingerprints(tracker) {
  return {
    observe: () => null,
    fingerprintFor: () => null,
    consumeFingerprintFor: () => null,
    get registrationFingerprint() { return null; },
    get registrationDescription() { return tracker.registrationDescription; },
    get enabled() { return false; },
    get refusal() {
      return "the description is declared with describe, not observed";
    },
  };
}
