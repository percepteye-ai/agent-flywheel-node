/**
 * PRODUCTION MODE: what the control plane says this agent should be running,
 * read ONCE at startup, and applied.
 *
 * Two endpoints answer that question and they are not interchangeable:
 *
 *   GET /policy/current   WHICH MODEL. An OpenAI-compatible `endpoint`
 *                         (base_url + model), the arm, and a
 *                         `serving_generation` that changes when and only when
 *                         the answer changes. Always 200; nulls included.
 *   GET /prompt/current   WHICH SYSTEM PROMPT. The approved optimized text,
 *                         or `{}` meaning KEEP THE PROMPT YOU HAVE. Never
 *                         "use no prompt".
 *
 * ⚠ `policy.prompt` IS NOT PROMPT TEXT, and the name invites exactly that
 * mistake. It is the control plane's own prompt-PIN identity snapshot --
 * `{pins, digest, captured_at}`, a record of which of ITS OWN prompts were in
 * force when the answer was computed. It has nothing to do with the
 * customer's twin candidate, so `policy.prompt.digest` and this prompt's
 * `sha256` are not comparable and are never compared here. The TEXT only ever
 * comes from `/prompt/current`.
 *
 * ── THE PAIR, AND WHY BOTH HALVES ARE APPLIED ─────────────────────────────
 *
 * A bundle is a (prompt, model) PAIR: the optimized text was certified
 * TOGETHER WITH a checkpoint, and `model_prompt_checksum` is the prompt
 * identity stamped on that checkpoint. Applying one half alone runs the
 * approved prompt over whatever model the customer's provider serves -- which
 * is not the combination anybody evaluated, and this file used to say so in a
 * warning on every start, because it could apply only the prompt.
 *
 * It can now apply both, so that warning is a warning only when one half is
 * genuinely missing, and it names WHICH. See `pairNote`: that conditional is
 * the whole point of the pair check.
 *
 * `agent_flywheel.current_prompt()` (Python) hands the text back
 * and stops, deliberately -- it is a library inside an arbitrary Python
 * process and has no idea where that process's prompt or model comes from.
 * Here we ARE the host's prompt and model seams, so the check that docstring
 * tells its caller to perform is ours to perform.
 *
 * ── RESOLVED ONCE, NOT POLLED ─────────────────────────────────────────────
 *
 * Both reads happen once, after registration, and the answer is held for the
 * life of the process. `ttl_s` is a real cadence hint (300s, 60s while a
 * candidate is in flight) and it is deliberately not honoured: a policy that
 * changes under a running agent is the same confound the control plane
 * refuses on -- half a process's turns served under one prompt and half under
 * another, with nothing on either side recording where the seam was. The
 * control plane's own remedy for a moved answer is a restart, which is why
 * `serving_generation` supports equality and nothing else. Nothing here sits
 * on the path of a turn, and no timer re-reads it.
 *
 * THE GATEWAY MAKES THAT RESTART A FIRST-DELIVERY COST, not a per-promotion
 * one. A model the platform serves is handed out as Mission Control's
 * CONSTANT gateway URL for this agent (`api_key_env: PERCEPTEYE_API_KEY`),
 * and the control plane resolves which checkpoint answers behind it, so a
 * later promotion or rollback between trained checkpoints reaches a running
 * agent without one. What still needs the restart is a change of ADDRESS:
 * the first delivery, and a withdrawal (`endpoint: null, withdrawn: true`),
 * which `modelDecision` refuses so the agent runs on its host's own model.
 *
 * ── TRAINING MODE DOES NOT REACH THIS FILE ────────────────────────────────
 *
 * `registerServingPolicy` is called from the production branch of
 * `index.js` only, the same structural split `mode.js` describes. A rollout is
 * evidence about the agent as configured; applying an unproven prompt or model
 * during one would change the behaviour being measured and attribute the
 * difference to the gradient step.
 *
 * ── THE HOST SEAMS ────────────────────────────────────────────────────────
 *
 * Verified against the INSTALLED host, OpenClaw 2026.7.1-2 -- the version
 * `package.json`'s `openclaw.compat.pluginApi` declares -- not against its
 * documentation:
 *
 *   `before_prompt_build` receives `{prompt, messages}` and its RESULT is what
 *   the host reads. `systemPrompt` is a RETURN FIELD, not a mutable field on
 *   the event: `resolvePromptBuildSystemPrompt`
 *   (agent-harness-runtime-827dyFNd.js:193-197) takes
 *   `promptBuildResult.systemPrompt` in preference to `developerInstructions`,
 *   which is the host's fully assembled system prompt. Mutating the event does
 *   NOTHING. Returning replaces the whole prompt, per attempt.
 *
 *   It is a PROMPT-INJECTION hook (`PROMPT_INJECTION_HOOK_NAMES`,
 *   command-registration-tKF3dsKu.js:162-167) and the gate is OPT-OUT: the
 *   registry blocks it only on an explicit
 *   `plugins.entries.<id>.hooks.allowPromptInjection === false`
 *   (registry-B8eQDFB4.js:4206-4214). It is NOT in `CONVERSATION_HOOK_NAMES`,
 *   so the opt-IN that `agent_end` needs does not apply to it.
 *
 *   `before_model_resolve` receives `{prompt, attachments?}` and returns
 *   `{providerOverride, modelOverride}`, honoured at
 *   embedded-agent-DGUuxGR2.js:1660-1667. It IS in `CONVERSATION_HOOK_NAMES`
 *   (command-registration-tKF3dsKu.js:170-178), so unlike the prompt hook it
 *   needs the operator's `plugins.entries.<id>.hooks.allowConversationAccess
 *   = true` -- the same opt-in this plugin already asks for to capture
 *   answers. Without it the host refuses the subscription with a bare return
 *   (registry-B8eQDFB4.js:4225-4235) and `api.on` reports nothing, so the
 *   operator has to be told by us, once.
 *
 *   THE BASE URL comes from neither of those. `providerOverride` names a
 *   provider; a registered provider's `normalizeTransport` is what supplies
 *   `{api, baseUrl}` (types-DaHgOqFX.d.ts:11113-11116, applied at
 *   provider-runtime-CLQOjLJ6.js:126-149). The two go together: the override
 *   is what makes `ctx.provider` ours, and ours is the only value we may act
 *   on -- see `normalizeTransport` below for the footgun that makes that gate
 *   mandatory rather than tidy. So the REGISTRATION is part of whether the
 *   model half may fire at all, not a step that follows that decision: see
 *   `openModelSeam`, which asks the whole question once.
 *
 *   THE CREDENTIAL comes from the same registration. The embedded runner
 *   asks `getApiKeyForModel` (embedded-agent-DGUuxGR2.js:1238) ->
 *   `resolveApiKeyForProvider` (model-auth-CJEm9SNp.js:565+), which tries
 *   auth profiles, the environment (:828) and the operator's own
 *   `models.providers.<id>.apiKey` (:853) FIRST, and only then the registered
 *   provider's `resolveSyntheticAuth` (:864 -> :501 -> :471-499 ->
 *   provider-runtime-CLQOjLJ6.js:322-359, which finds a runtime-registered
 *   provider in the loaded registry). That hook returns
 *   `{apiKey, source, mode}` (types-DaHgOqFX.d.ts:532-537), so the plugin can
 *   hand the host its own flywheel key for an endpoint the control plane
 *   names it for, and an operator's explicit entry still wins. See
 *   `resolveSyntheticAuth` below for why it answers so narrowly.
 *
 *   BOTH hook contexts carry `agentId` and `sessionKey`
 *   (lifecycle-hook-helpers-BwL6869q.js:9-34,
 *   embedded-agent-DGUuxGR2.js:2292-2303), which is what `scope.js` reads to
 *   keep this agent's approved answer off every OTHER agent, subagent and
 *   cron turn in the same process.
 *
 * FEATURE-DETECTED, NEVER ASSUMED. The host source available to read is
 * 2026.4.3 and it agrees on all of the above, but a patch release may close
 * either seam at any time and `api.on` reports nothing either way. So: the
 * hooks are subscribed, they return values, and if the host never calls them
 * or ignores what they return, the agent runs exactly as it does today. The
 * cost of a closed seam is the improvement and nothing else.
 */
import { resolveServedAgent, scopeDecision } from "./scope.js";

/** The host hook whose RESULT carries the system prompt. */
export const PROMPT_HOOK_NAME = "before_prompt_build";

/** The host hook whose RESULT carries the provider and model. */
export const MODEL_HOOK_NAME = "before_model_resolve";

/**
 * The provider this plugin registers, and the ONLY id it will act on.
 *
 * Declared in `openclaw.plugin.json` as well: a plugin's provider surface is
 * live only when the manifest's `providers` array is non-empty AND the plugin
 * is activated (providers-y2Lns8fh.js:31-35,92-103). Registering one without
 * declaring it is a registration nothing consults.
 */
export const PROVIDER_ID = "percepteye-flywheel";

/**
 * The transport family the served endpoint speaks.
 *
 * The control plane serves an OpenAI-compatible completions API, and
 * `openai-completions` is the host's own vocabulary for it
 * (config-3MmNBWgm.js:22,46). `GET /policy/current` answers with a `base_url`
 * whose trailing `/chat/completions` is ALREADY STRIPPED, because an OpenAI
 * client appends that suffix itself -- so it is used verbatim and never
 * re-appended.
 */
export const PROVIDER_TRANSPORT_API = "openai-completions";

/**
 * The variable the control plane names when the served endpoint takes THIS
 * plugin's own flywheel key.
 *
 * `/policy/current` names `PERCEPTEYE_API_KEY` exactly when the endpoint is
 * Mission Control's own -- its gateway URL for this agent, or a self-hosted
 * endpoint with no provider stamped -- and a provider's own variable (or
 * nothing) for a tenant-owned provider endpoint. Only the first is ours: the
 * flywheel key sent to anybody else's endpoint is a credential handed to a
 * third party, and it would 401 there anyway.
 */
export const FLYWHEEL_KEY_ENV = "PERCEPTEYE_API_KEY";

/** `modelDecision`'s `credential` when the endpoint takes the flywheel key. */
export const FLYWHEEL_KEY_CREDENTIAL = "flywheel_key";

/**
 * Where the flywheel key comes from, said the same way in the provider's
 * auth hint, the startup line and the `source` the host shows for it.
 */
export const flywheelKeyOrigin = (pluginId) =>
  `this plugin's flywheel key (plugins.entries.${pluginId}.config.apiKey, ` +
  `or ${FLYWHEEL_KEY_ENV})`;

/**
 * The delivery states that may serve.
 *
 * The control plane's own boundary, not a second one: it serves a bundle only
 * in these two states, and its prompt export enforces the same set.
 * Re-asserting it here is not a duplicate gate -- it is the only thing
 * standing between a control plane that one day widens the filter and a
 * customer's agent silently running an unapproved prompt.
 */
export const SERVABLE_PROMPT_STATUSES = new Set(["approved", "delivered"]);

/**
 * Prefixes that mean STORED ARTIFACT, not sampling address.
 *
 * The control plane already refuses to hand one of these out as a `model`,
 * for exactly the reason this refuses to send one:
 * `model="gs://bucket/run/iter_0"` 404s on every completion. Re-asserted here
 * on the same argument as the status set above.
 */
export const ARCHIVE_REF_PREFIXES = ["gs://", "s3://", "file://", "/"];

/** Said the same way wherever it is said. */
export const PROMPT_OFF_REASON =
  "prompt application is switched off (PERCEPTEYE_APPLY_PROMPT / applyPrompt)";

/** Said the same way wherever it is said. */
export const MODEL_OFF_REASON =
  "model application is switched off (PERCEPTEYE_APPLY_MODEL / applyModel)";

/** Why the model half cannot fire on this host at all. One phrasing, one place. */
export const modelHookBlockedReason = (pluginId) =>
  `${MODEL_HOOK_NAME} is a conversation hook and this host drops it for ` +
  `non-bundled plugins unless you set plugins.entries.${pluginId}.hooks.` +
  "allowConversationAccess=true -- the same setting that lets this plugin " +
  "capture your agent's answers";

/**
 * Why the model half cannot fire when this host has no provider surface.
 *
 * THE PROVIDER IS THE ONLY PRODUCER OF THE BASE URL. `handleModelResolve`
 * returns `providerOverride: PROVIDER_ID`, and the only thing that turns that
 * id into `{api, baseUrl}` is the registered provider's `normalizeTransport`.
 * Returning the override on a host that never took the registration names a
 * provider the host does not know: the resolve fails outright, or the served
 * model name is handed to the customer's OWN provider, which does not serve
 * it. Both break a working agent to deliver an improvement that cannot
 * arrive, which is the one thing this file exists not to do.
 */
export const NO_PROVIDER_SURFACE_REASON =
  `this host exposes no provider registration (api.registerProvider is ` +
  `missing), and a registered provider is the only thing that can supply the ` +
  `base URL of the approved endpoint -- so naming '${PROVIDER_ID}' in ` +
  `${MODEL_HOOK_NAME} would point this agent at a provider the host does not ` +
  "know";

/** Why the model half cannot fire when the host REFUSED the registration. */
export const providerRefusedReason = (detail) =>
  `registering the provider '${PROVIDER_ID}' failed (${detail}), and a ` +
  "registered provider is the only thing that can supply the base URL of the " +
  `approved endpoint -- so naming it in ${MODEL_HOOK_NAME} would point this ` +
  "agent at a provider the host does not know";

/**
 * The refusal that means NOTHING IS WRONG -- the answer has not arrived yet.
 *
 * `refusal` and `modelRefusal` are true at every moment, so before the startup
 * read they have to say something, and this is it. It is exported because it
 * is also the ONE test for "this half can still apply": every other value
 * either half can hold at construction is a settled refusal. `index.js` asks
 * that question rather than re-deriving the predicate from a subset of its
 * inputs, which is how its startup line came to promise a model half that a
 * refused provider registration had already ruled out.
 */
export const PENDING_ANSWER_REASON = "the control plane has not been asked yet";

/** Why nothing is read or applied when no key is configured. */
export const NO_KEY_REASON =
  "no API key is configured, so the control plane is never asked and no hook " +
  "is subscribed (set PERCEPTEYE_API_KEY, or plugins.entries.<id>.config." +
  "apiKey)";

const str = (v) => (typeof v === "string" ? v.trim() : "");

/** A checksum, shortened for a log line. Never a claim that it is complete. */
const short = (v) => (v ? `${v.slice(0, 12)}…` : "none");

const isArchiveRef = (value) =>
  ARCHIVE_REF_PREFIXES.some((p) => value.startsWith(p));

/**
 * MAY THIS PROMPT BE APPLIED, and if not, WHY NOT.
 *
 * Pure, and separate from everything that logs or subscribes, because it is
 * the decision worth testing exhaustively. Each refusal names ITS OWN cause;
 * one message covering four different failures would tell an operator to go
 * looking in the wrong place three times out of four.
 *
 * @param {object} prompt the `/prompt/current` body, possibly `{}`
 * @returns {{apply: boolean, text: string|null, reason: string,
 *            checksum: string|null}}
 */
export function promptDecision(prompt) {
  const p = prompt && typeof prompt === "object" ? prompt : {};
  const text = typeof p.text === "string" ? p.text : "";
  const checksum = str(p.model_prompt_checksum) || null;

  // `{}` IS AN ANSWER, and it is "keep what you have". No product declares
  // this agent, no twin optimizes that product, nothing has passed the gate,
  // or the control plane could not answer -- and every one of those means the
  // host's own prompt stands. It never means "run with no prompt".
  if (!text.trim()) {
    return {
      apply: false, text: null, checksum,
      reason: "the control plane is serving no approved prompt for this " +
        "agent (empty answer); the prompt this host assembles stands",
    };
  }

  // THE BASELINE MOVED UNDER IT. The customer re-intook the twin with a
  // changed baseline after this bundle was approved, so the approved text was
  // shaped against a prompt they no longer ship. The deliverable still
  // stands as a record; applying it is a different question, and the Python
  // SDK names this as the first thing a caller must check before applying.
  // Re-certification is manual, so this does not clear on its own.
  if (p.stale_baseline === true) {
    return {
      apply: false, text: null, checksum,
      reason: "stale_baseline=true: this agent's own baseline prompt changed " +
        "after the pair was certified, so the approved text was shaped " +
        "against a prompt this agent no longer ships. Re-certification is " +
        "manual -- ask the control plane to re-certify the pair",
    };
  }

  const status = str(p.status);
  if (!SERVABLE_PROMPT_STATUSES.has(status)) {
    return {
      apply: false, text: null, checksum,
      reason: `the served bundle's status is ${JSON.stringify(status)}, not ` +
        `one of ${[...SERVABLE_PROMPT_STATUSES].join("/")}; only an operator-` +
        "approved bundle is applied",
    };
  }

  // THE PAIR, AS FAR AS THIS SIDE CAN CHECK IT. `model_prompt_checksum` is
  // the prompt identity STAMPED ON THE CHECKPOINT at certification;
  // `sha256` is the optimized prompt's own identity. Delivery assembly on the
  // control plane refuses with a 409 unless the two are equal, so a served
  // bundle where they differ is not the validated pair, whatever its status
  // says. That is an inconsistency in the deliverable, not a policy call, so
  // it refuses.
  //
  // Checked only when BOTH are present: a blank one means we could not look,
  // which is the "cannot prove" case the pair note names, not a proven
  // mismatch.
  const sha = str(p.sha256);
  if (sha && checksum && sha !== checksum) {
    return {
      apply: false, text: null, checksum,
      reason: `the bundle disagrees with itself: the prompt's sha256 is ` +
        `${short(sha)} but the checkpoint it was certified against is ` +
        `stamped ${short(checksum)}. Assembly refuses that pair, so this ` +
        "answer is not the thing that was approved",
    };
  }

  return { apply: true, text, checksum, reason: "" };
}

/**
 * MAY THIS MODEL BE APPLIED, and if not, WHY NOT.
 *
 * The model half's counterpart to `promptDecision`, and deliberately short:
 * every POLICY question -- has a person moved this agent onto the candidate,
 * did certification refuse it, is it deployed anywhere servable -- was already
 * answered by the control plane before it filled `endpoint` in at all, and all
 * three fail closed to the champion. An agent that never left the champion arm
 * is served the champion, and that is an answer to apply, not one to
 * second-guess. What is left for this side is whether the ADDRESS is one an
 * agent can actually call -- and whether the control plane has WITHDRAWN the
 * model, the one answer that falls back to the host's own model rather than
 * to a champion, because there is none.
 *
 * THE CREDENTIAL is the one other thing read here, and only read: it is
 * `FLYWHEEL_KEY_CREDENTIAL` when the control plane names `FLYWHEEL_KEY_ENV`
 * for the endpoint -- the gateway, or our own self-hosted endpoint -- and
 * `null` for everything else, which leaves the credential to the host's own
 * `models.providers` entry exactly as before. It never refuses: whether an
 * endpoint needs a key at all is the host's question.
 *
 * @param {object} policy the `/policy/current` body, possibly `{}`
 * @returns {{apply: boolean, baseUrl: string|null, model: string|null,
 *            credential: string|null, reason: string}}
 */
export function modelDecision(policy) {
  const p = policy && typeof policy === "object" ? policy : {};
  const ep = p.endpoint && typeof p.endpoint === "object" ? p.endpoint : {};
  const baseUrl = str(ep.base_url);
  const model = str(ep.model);

  // A WITHDRAWAL IS AN ANSWER, and it is asked FIRST. The control plane says
  // `withdrawn: true` when an agent under management is moved back to the
  // base arm and there is no champion to serve: the approved model is taken
  // away, and this agent runs on whatever its host configures. It also sends
  // `endpoint: null` -- but the flag is the instruction, so it wins over any
  // endpoint that arrives beside it, and the refusal names the withdrawal
  // rather than the generic "nothing deployed" an operator would read as a
  // serving fault.
  if (p.withdrawn === true) {
    return {
      apply: false, baseUrl: null, model: null, credential: null,
      reason: "the control plane WITHDREW the approved model for this agent " +
        `(withdrawn=true${str(p.reason) ? `, ${str(p.reason)}` : ""}), so ` +
        "this agent runs on the model its host configures",
    };
  }

  if (!baseUrl || !model) {
    return {
      apply: false, baseUrl: null, model: null, credential: null,
      reason: "the control plane is serving no endpoint for this agent " +
        "(nothing is deployed for it, or no policy resolved), so there is " +
        "nothing to point it at",
    };
  }

  // AN ARCHIVE URI IS NOT A MODEL NAME. `is_servable` refuses this on the
  // server for exactly this reason -- a bucket path in `model` 404s on every
  // completion -- so an answer carrying one is not a policy an agent can run,
  // whatever else it says.
  if (isArchiveRef(model)) {
    return {
      apply: false, baseUrl: null, model: null, credential: null,
      reason: `the served model ${JSON.stringify(model)} is a stored-artifact ` +
        "reference, not a name an endpoint can serve; that address would 404 " +
        "on every completion",
    };
  }

  // EXACT, not "absent means ours". The control plane OMITS `api_key_env`
  // when it cannot honestly name a variable -- a provider whose key travels
  // in the body -- and a provider's endpoint must never be sent our key.
  const credential = str(ep.api_key_env) === FLYWHEEL_KEY_ENV
    ? FLYWHEEL_KEY_CREDENTIAL : null;
  return { apply: true, baseUrl, model, credential, reason: "" };
}

/**
 * The one line an operator needs to see what the control plane WOULD serve.
 *
 * Every field here has a reader: `arm` and `reason` say which policy this
 * agent is on and why, `serving_generation` is the equality token a fleet
 * cycles a replica on, and `endpoint` is the address the model half points at.
 */
export function servedPolicySummary(policy) {
  const p = policy && typeof policy === "object" ? policy : {};
  const ep = p.endpoint && typeof p.endpoint === "object" ? p.endpoint : {};
  const base = str(ep.base_url);
  const model = str(ep.model);
  return (
    `arm=${str(p.arm) || "unknown"} ` +
    `serving_generation=${str(p.serving_generation) || "none"} ` +
    `candidate_available=${p.candidate_available === true} ` +
    `endpoint=${base || "none"} model=${model || "none"}` +
    (str(p.reason) ? ` (${p.reason})` : "")
  );
}

/**
 * THE PAIR CHECK, as a sentence -- or null when there is nothing to say.
 *
 * This is why the two halves live in one file. The bundle is a (prompt, model)
 * pair, so:
 *
 *   both applied   the prompt is running on the checkpoint it was certified
 *                  with. An ordinary confirmation; nothing is wrong.
 *   one applied    what runs is HALF of a validated combination, and an
 *                  operator who is not told will read a behaviour change as
 *                  the certified improvement. A warning, naming WHICH half is
 *                  missing and why -- "one half is missing" without saying
 *                  which sends them to look in the wrong place half the time.
 *   neither        each half has already logged its own cause; there is no
 *                  pair to say anything about.
 *
 * @returns {{level: "info"|"warn", text: string}|null}
 */
export function pairNote({
  promptApplied, modelApplied, promptRefusal, modelRefusal, checksum,
}) {
  if (promptApplied && modelApplied) {
    return {
      level: "info",
      text: "the pair is intact: the approved prompt is running on the " +
        `checkpoint it was certified with (stamped ${short(checksum ?? "")}), ` +
        "which is the combination that was evaluated",
    };
  }
  if (promptApplied) {
    return {
      level: "warn",
      text: "HALF THE PAIR: the approved prompt is applied but the MODEL half " +
        `is not -- ${modelRefusal || "no reason was recorded"}. The prompt ` +
        `was certified as a pair with the checkpoint stamped ` +
        `${short(checksum ?? "")}, so it runs over whatever model your ` +
        "provider serves, which is not the combination that was evaluated",
    };
  }
  if (modelApplied) {
    return {
      level: "warn",
      text: "HALF THE PAIR: the approved model is applied but the PROMPT half " +
        `is not -- ${promptRefusal || "no reason was recorded"}. The ` +
        "checkpoint was certified together with an optimized prompt, so it " +
        "runs under whatever prompt your host assembles, which is not the " +
        "combination that was evaluated",
    };
  }
  return null;
}

/**
 * Hold the control plane's answer, and hand both halves to the host.
 *
 * The hooks are subscribed SYNCHRONOUSLY at plugin load while the answer
 * arrives later, so the handlers return nothing until `resolve` has run. That
 * ordering is the fail-open one: the first turns of a freshly started gateway
 * run on the host's own prompt and model, exactly as they do today, rather
 * than waiting on a network call between a user and their answer.
 *
 * @param {object}  opts
 * @param {string}  opts.pluginId
 * @param {object}  [opts.logger]
 * @param {boolean} [opts.applyPrompt]  the prompt kill switch, already resolved
 * @param {boolean} [opts.applyModel]   the model kill switch, already resolved
 * @param {object}  [opts.servedAgent]  from `resolveServedAgent`
 * @param {string|null} [opts.modelBlocked] why the model half cannot fire on
 *   this host AT ALL -- the kill switch, a missing conversation opt-in, or a
 *   provider registration the host does not offer or refused. Decided once by
 *   `registerServingPolicy`, which is the only place that knows all three.
 * @param {string|null} [opts.unwired]  why no seam was wired, when none was
 * @param {string|null} [opts.flywheelKey] this plugin's own key (`config.
 *   apiKey`), handed to the host ONLY through `resolveSyntheticAuth` and only
 *   for an endpoint the control plane names it for. Held in this closure:
 *   no getter returns it and no line logs it.
 */
export function createPolicySource({
  pluginId, logger = null, applyPrompt = true, applyModel = true,
  servedAgent = resolveServedAgent({}), modelBlocked = null,
  unwired = null, flywheelKey = null,
}) {
  let policy = {};
  let prompt = {};
  let applied = null;
  let appliedModel = null;

  // NOTHING CAN BE APPLIED TO ANY RUN when the agent scope is unresolvable --
  // several agents on this host and none of them named -- because
  // `scopeDecision` refuses every one of them. It is known at construction,
  // so it belongs here beside the other never-going-to-happen causes rather
  // than only inside the handlers: this source used to take the control
  // plane's answer, set BOTH `applied` and `appliedModel` from it, clear both
  // refusals, and then announce "the pair is intact" for a pair that ran on
  // nothing.
  const scopeUnresolved = servedAgent?.id
    ? null
    : servedAgent?.reason || "no agent is resolved";

  // TRUE AT EVERY MOMENT, including before the read and when the read never
  // happens (no key, no transport). A `refusal` that is null while
  // `appliedPrompt` is also null cannot be told apart from a source that
  // applied nothing for a reason, and this field exists to be read.
  //
  // The switched-off value is THE CONSTANT, not a second phrasing of it: an
  // operator must read the same sentence here and in the startup log, and a
  // comment saying "keep these in sync" is not a mechanism.
  let refusal = !applyPrompt ? PROMPT_OFF_REASON
    : unwired ?? scopeUnresolved ?? PENDING_ANSWER_REASON;
  let refusedModel = !applyModel ? MODEL_OFF_REASON
    : modelBlocked ?? unwired ?? scopeUnresolved ?? PENDING_ANSWER_REASON;
  let resolved = false;
  let announcedPrompt = false;
  let announcedModel = false;

  /** The scope gate, asked identically by both halves. */
  const inScope = (ctx) => scopeDecision(ctx, servedAgent);

  // EVERY SCOPE REFUSAL HAS A READER NOW. `scopeDecision` builds a specific
  // sentence for each of its cases -- a subagent session, a cron turn, the
  // wrong host agent, no hook context, neither identifier -- and until this
  // existed every one of them was computed on every turn and dropped, leaving
  // an operator with a startup log promising both halves, no behaviour change,
  // and nothing anywhere naming the cause.
  //
  // Once per DISTINCT reason, not per turn: this sits in front of every turn
  // the process serves. The set is bounded by the six sentences and the host's
  // own agent ids.
  const saidScope = new Set();
  const sayScope = (half, reason) => {
    const line = `${half}: ${reason}`;
    if (saidScope.has(line)) return;
    saidScope.add(line);
    logger?.info?.(
      `[${pluginId}] the approved ${half} was NOT applied to this run -- ` +
      `${reason}.`);
  };

  const source = {
    /** The `/policy/current` body. `{}` until resolved, or on any failure. */
    get policy() { return policy; },
    /** The `/prompt/current` body. `{}` when not read or not readable. */
    get prompt() { return prompt; },
    /** The text handed to the host, or null when none is being applied. */
    get appliedPrompt() { return applied; },
    /**
     * `{provider, model, baseUrl, credential}` handed to the host, or null
     * when none is. `credential` is `FLYWHEEL_KEY_CREDENTIAL` when this
     * plugin supplies its own key for the endpoint, null when the host's own
     * `models.providers` entry has to. Never the key itself.
     */
    get appliedModel() { return appliedModel; },
    /** Why no prompt is being applied, or null when one is. */
    get refusal() { return refusal; },
    /** Why no model is being applied, or null when one is. */
    get modelRefusal() { return refusedModel; },
    /** Which host agent this install's answer is for. `id` null when ambiguous. */
    get servedAgent() { return servedAgent; },
    /**
     * Whether the startup read has finished.
     *
     * ONE read or TWO: `/policy/current` always, `/prompt/current` only when
     * prompt application is on AND the agent scope resolved -- pulling the
     * customer's prompt text over the wire to discard it is a cost with no
     * reader. Stays false forever when there is no transport to read through,
     * because no read was ever attempted.
     */
    get resolved() { return resolved; },

    /**
     * Read both endpoints, decide, and say so once. NEVER REJECTS.
     *
     * A control plane that is down costs the improvement and nothing else:
     * `policy` and `prompt` stay `{}`, nothing is applied, and the hooks go on
     * returning nothing.
     */
    async resolve(transport) {
      if (!transport) return source;
      try {
        policy = (await transport.policyCurrent()) || {};
      } catch {
        policy = {};
      }
      logger?.info?.(`[${pluginId}] ${servedPolicySummary(policy)}`);

      // WHOSE RUN? -- and when the answer is "we cannot tell", NOTHING is
      // applied to any run, so neither half's refusal may be overwritten by
      // the payload's answer and the customer's prompt text is not fetched to
      // be discarded. `registerServingPolicy` has already warned, naming the
      // agents and the remedy; `announcePair` stays silent because there is no
      // pair, which is what stops "the pair is intact" being logged for a
      // bundle that reaches no turn.
      if (scopeUnresolved) {
        resolved = true;
        source.announcePair();
        return source;
      }

      // ── THE MODEL HALF ────────────────────────────────────────────────
      // The kill switch, a missing conversation opt-in and a provider the host
      // will not register are decided before any read and must not be
      // overwritten by the payload's answer: an operator who switched the
      // model half off is not owed a sentence about an endpoint they asked not
      // to use, and an endpoint that has no provider to reach it is not
      // applied however good the answer is.
      if (applyModel && !modelBlocked) {
        const decision = modelDecision(policy);
        if (decision.apply) {
          appliedModel = {
            provider: PROVIDER_ID,
            model: decision.model,
            baseUrl: decision.baseUrl,
            credential: decision.credential,
          };
          refusedModel = null;
        } else {
          appliedModel = null;
          refusedModel = decision.reason;
        }
        // WHICH KEY OPENS IT, said exactly: the operator reading this line is
        // the one who has to supply it when we do not.
        const credentialLine = appliedModel?.credential === FLYWHEEL_KEY_CREDENTIAL
          ? `The control plane names ${FLYWHEEL_KEY_ENV} for that endpoint, ` +
            `so the provider authenticates with ${flywheelKeyOrigin(pluginId)}` +
            `; a models.providers.${PROVIDER_ID}.apiKey you set yourself ` +
            "takes precedence. "
          : "The control plane does not name this plugin's flywheel key for " +
            "that endpoint, so if it needs a credential it comes from your " +
            `host's own models.providers.${PROVIDER_ID} entry. `;
        logger?.info?.(appliedModel
          ? `[${pluginId}] applying the approved model ` +
            `'${appliedModel.model}' at ${appliedModel.baseUrl} via ` +
            `${MODEL_HOOK_NAME}, through the provider '${PROVIDER_ID}' this ` +
            `plugin registers. ${credentialLine}Set ` +
            "PERCEPTEYE_APPLY_MODEL=0 to stop applying it."
          : `[${pluginId}] the approved model is NOT being applied: ` +
            `${refusedModel}.`);
      }

      if (!applyPrompt) {
        // NOT FETCHED, not fetched-and-dropped. `/prompt/current` carries the
        // customer's own prompt text; pulling it over the wire to throw it
        // away is a cost with no reader. `refusal` already says so.
        resolved = true;
        source.announcePair();
        return source;
      }

      // ── THE PROMPT HALF ───────────────────────────────────────────────
      try {
        prompt = (await transport.promptCurrent()) || {};
      } catch {
        prompt = {};
      }
      const decision = promptDecision(prompt);
      resolved = true;
      if (!decision.apply) {
        applied = null;
        refusal = decision.reason;
        logger?.info?.(
          `[${pluginId}] the approved system prompt is NOT being applied: ` +
          `${refusal}.`);
      } else {
        applied = decision.text;
        refusal = null;
        logger?.info?.(
          `[${pluginId}] applying the approved system prompt ` +
          `'${str(prompt.name) || "unnamed"}' v${prompt.version ?? "?"} ` +
          `(${applied.length} chars, status=${str(prompt.status)}) via ` +
          `${PROMPT_HOOK_NAME}. Set PERCEPTEYE_APPLY_PROMPT=0 to stop ` +
          "applying it.");
      }
      source.announcePair();
      return source;
    },

    /** The pair sentence, at the level `pairNote` chose. */
    announcePair() {
      const note = pairNote({
        promptApplied: Boolean(applied),
        modelApplied: Boolean(appliedModel),
        promptRefusal: refusal,
        modelRefusal: refusedModel,
        checksum: str(prompt?.model_prompt_checksum) || null,
      });
      if (!note) return;
      const write = note.level === "warn" ? logger?.warn : logger?.info;
      write?.call(logger, `[${pluginId}] ${note.text}.`);
    },

    /**
     * The `before_prompt_build` body. Returns the host's result object, or
     * `undefined` to change nothing.
     *
     * `undefined` rather than `{systemPrompt: undefined}` because the host
     * merges results across plugins with `firstDefined`, and a present-but-
     * undefined field is a claim on that slot we have no right to make.
     *
     * READS THE CONTEXT, and must. WHAT to apply was settled once at startup,
     * but WHETHER IT APPLIES TO THIS RUN cannot be: the host runs this hook
     * for every agent, every subagent and every cron turn in the process, and
     * this handler used to take NO ARGUMENTS and answer all of them -- one
     * operator's approval for one agent became a process-wide prompt swap.
     * See `scope.js`.
     */
    handle(event, ctx) {
      if (!applied) return undefined;
      const scope = inScope(ctx);
      if (!scope.apply) {
        sayScope("system prompt", scope.reason);
        return undefined;
      }
      if (!announcedPrompt) {
        announcedPrompt = true;
        // FEATURE DETECTION, reported once. This is the only evidence
        // available that the host called us at all -- a version that dropped
        // the hook would simply never reach this line, and the operator would
        // otherwise see a startup log promising an applied prompt with
        // nothing behind it. It says CALLED, not HONOURED: whether the return
        // is read is the host's decision and we cannot observe it.
        logger?.info?.(
          `[${pluginId}] this host called ${PROMPT_HOOK_NAME} for agent ` +
          `'${servedAgent.id}'; the approved prompt was returned to it. ` +
          "Whether the host applies the return is the host's decision.");
      }
      return { systemPrompt: applied };
    },

    /**
     * The `before_model_resolve` body: `{providerOverride, modelOverride}`, or
     * `undefined` to change nothing.
     *
     * `providerOverride` is what makes `ctx.provider` ours on the transport
     * seam below; without it `normalizeTransport` is asked only about somebody
     * else's provider and correctly declines. The two are one change.
     *
     * Scoped exactly as the prompt half is, by the same predicate: a subagent
     * or cron turn repointed at a trained checkpoint is the same defect as one
     * given somebody else's prompt.
     */
    handleModelResolve(event, ctx) {
      if (!appliedModel) return undefined;
      const scope = inScope(ctx);
      if (!scope.apply) {
        sayScope("model", scope.reason);
        return undefined;
      }
      if (!announcedModel) {
        announcedModel = true;
        logger?.info?.(
          `[${pluginId}] this host called ${MODEL_HOOK_NAME} for agent ` +
          `'${servedAgent.id}'; the approved model was returned to it. ` +
          "Whether the host applies the return is the host's decision.");
      }
      return {
        providerOverride: appliedModel.provider,
        modelOverride: appliedModel.model,
      };
    },

    /**
     * The provider's transport seam: `{api, baseUrl}` for OUR provider only.
     *
     * ⚠ THE FOOTGUN, and the reason the guard is the first thing here rather
     * than a tidy detail. `normalizeProviderTransportWithPlugin`
     * (provider-runtime-CLQOjLJ6.js:153-165) tries the MATCHED provider's
     * `normalizeTransport` and then, if that changed nothing, LOOPS OVER EVERY
     * OTHER registered provider plugin and takes the first return that changes
     * `api` or `baseUrl`. So a `normalizeTransport` that answered
     * unconditionally would redirect the customer's Anthropic or OpenAI
     * traffic to our gateway -- silently, on a turn we were never asked about.
     *
     * `ctx.provider` is the only thing that says whose transport is being
     * assembled, so it is the only thing this answers on. Everything else gets
     * `undefined`, which the host reads as "no change".
     *
     * THE CONTEXT CARRIES NO AGENT (`ProviderNormalizeTransportContext` is
     * `{config?, workspaceDir?, provider, modelId?, api?, baseUrl?}`), so the
     * per-agent scope cannot be asked here. It does not need to be: this
     * provider becomes the current one only because `handleModelResolve`
     * named it, and that IS scoped. The one other way to reach it is an
     * operator writing `models.providers.percepteye-flywheel` into their own
     * config and pointing an agent at it by hand -- which is that operator
     * deliberately using this endpoint, and answering them is correct.
     */
    normalizeTransport(ctx) {
      if (!appliedModel) return undefined;
      if (str(ctx?.provider) !== PROVIDER_ID) return undefined;
      return {
        api: PROVIDER_TRANSPORT_API,
        // VERBATIM. `/policy/current` already stripped a trailing
        // `/chat/completions`; re-appending it produces a URL nothing serves.
        baseUrl: appliedModel.baseUrl,
      };
    },

    /**
     * The provider's credential seam: `{apiKey, source, mode}` -- this
     * plugin's flywheel key -- or `undefined` to leave the host's own answer.
     *
     * THREE GATES, and each one keeps the key off an endpoint it was never
     * meant for:
     *
     *   an applied model     nothing is named before the read, and a refused
     *                        or withdrawn answer points nowhere.
     *   credential named     the control plane named FLYWHEEL_KEY_ENV for
     *                        THIS endpoint. A tenant-owned provider endpoint
     *                        gets its own key from the host; ours there is a
     *                        credential handed to a third party.
     *   our provider id      the host also asks the plugins behind a
     *                        provider's other refs, its model `api` among
     *                        them (provider-runtime-CLQOjLJ6.js:344-353),
     *                        and `ctx.provider` is the only thing that says
     *                        whose credential is being asked for.
     *
     * LAST IN LINE ON THE HOST, by the host's own order: an auth profile, an
     * environment key or an explicit `models.providers.<id>.apiKey` the
     * operator wrote is used before this is asked at all.
     */
    resolveSyntheticAuth(ctx) {
      if (!appliedModel) return undefined;
      if (appliedModel.credential !== FLYWHEEL_KEY_CREDENTIAL) return undefined;
      if (str(ctx?.provider) !== PROVIDER_ID) return undefined;
      const apiKey = str(flywheelKey);
      if (!apiKey) return undefined;
      return {
        apiKey,
        source: flywheelKeyOrigin(pluginId),
        mode: "api-key",
      };
    },
  };
  return source;
}

/**
 * Subscribe both seams and start the one-shot read. Production only.
 *
 * Returns the source whether or not anything was wired, so a caller always
 * has something to read -- an inert source answers `{}` / null, and says why.
 *
 * @param {object} api        the OpenClaw plugin api
 * @param {object} opts
 * @param {object} opts.transport an AttachTransport, or null with no API key
 * @param {object} [opts.hostConfig] `api.config`, for the agent scope
 * @param {boolean} [opts.conversationAccess] whether this host will deliver
 *   conversation hooks to this plugin
 * @param {Promise|null} opts.after resolve only once this settles (the
 *   registration chain), so three control-plane calls do not race at startup
 */
export function registerServingPolicy(api, {
  config, pluginId, logger = null, transport = null, after = null,
  hostConfig = api?.config, conversationAccess = true,
}) {
  const applyPrompt = config?.applyPromptEnabled !== false;
  const applyModel = config?.applyModelEnabled !== false;
  const servedAgent = resolveServedAgent({
    agentId: config?.agentId, hostConfig,
  });

  // WHY NOTHING WILL BE WIRED. "No key" is the ordinary first install and the
  // consent boundary, and it is the only cause reachable here: `register()` in
  // `index.js` returns before this is called when the host exposes no `api.on`,
  // so a second branch naming that would be a refusal no host can produce.
  const unwired = transport ? null : NO_KEY_REASON;

  // Assigned immediately below. The provider's `normalizeTransport` closes
  // over it and is called by the HOST, long after this function returns.
  let source = null;

  /**
   * CAN THE MODEL HALF FIRE ON THIS HOST AT ALL, and if not, why -- asked
   * ONCE, here, because this is the only place that knows every input to it.
   *
   * Registering the provider IS part of the question, not a step that follows
   * it. `handleModelResolve` returns `providerOverride: PROVIDER_ID` and the
   * registered provider is the ONLY producer of the base URL that override
   * consumes, so a host that has no provider surface, or that refuses the
   * registration, cannot serve the approved model however good the control
   * plane's answer is. This used to swallow the refusal, subscribe the hook
   * anyway and log "applying the approved model ... through the provider this
   * plugin registers" two lines after warning that the registration failed.
   *
   * @returns {string|null} the refusal, or null when the seam is open
   */
  const openModelSeam = () => {
    if (!applyModel) return MODEL_OFF_REASON;
    if (!conversationAccess) return modelHookBlockedReason(pluginId);
    if (typeof api.registerProvider !== "function") {
      return NO_PROVIDER_SURFACE_REASON;
    }
    try {
      // REGISTERED BEFORE WE KNOW WHETHER A MODEL IS SERVED:
      // `providerOverride` names it on a later turn, and a provider registered
      // at that point would be too late. It answers for nothing until
      // `appliedModel` is set, and never for anyone else's provider id.
      api.registerProvider({
        id: PROVIDER_ID,
        label: "PerceptEye Flywheel",
        // The served endpoint is OpenAI-compatible and may need a key, which
        // the control plane names rather than this plugin inventing one. An
        // empty `auth` is accepted (registry-B8eQDFB4.js:2361-2367) but
        // leaves the host's auth surfaces with nothing to show an operator,
        // and this is the one place an operator reads where the key comes
        // from before any answer has arrived.
        auth: [{
          id: "api_key",
          label: "API key",
          kind: "api_key",
          hint: `Supplied for you when the control plane names ` +
            `${FLYWHEEL_KEY_ENV} for the served endpoint: the provider ` +
            `authenticates with ${flywheelKeyOrigin(pluginId)}. Set ` +
            `models.providers.${PROVIDER_ID}.apiKey only for an endpoint ` +
            "that takes a different credential; yours takes precedence.",
        }],
        normalizeTransport: (ctx) => source?.normalizeTransport(ctx),
        // THE CREDENTIAL, supplied rather than asked for: the host's last
        // resort after the operator's own profile, env and config entry.
        resolveSyntheticAuth: (ctx) => source?.resolveSyntheticAuth(ctx),
      });
    } catch (err) {
      // A refused provider registration must not take the prompt half, the
      // turn capture, or the plugin load down with it -- it costs the MODEL
      // half, and only that.
      return providerRefusedReason(err?.message ?? err);
    }
    return null;
  };

  // Not attempted at all with no key: nothing is read, so there is nothing for
  // a provider to serve, and `unwired` is already the refusal both halves
  // carry.
  const modelBlocked = unwired ? null : openModelSeam();

  source = createPolicySource({
    pluginId, logger, applyPrompt, applyModel, servedAgent,
    modelBlocked, unwired,
    // The same key the transport authenticates to the control plane with:
    // the gateway URL the control plane hands out is opened by it.
    flywheelKey: config?.apiKey ?? null,
  });

  // THE CONSENT BOUNDARY, again. With no key there is no transport, nothing
  // is read, and no hook is subscribed -- the guarantee is the absence of the
  // subscription, not a branch inside a handler.
  //
  // SAID OUT LOUD, because it used to be the one not-doing-it path in this
  // package that returned in silence, directly after a startup line telling
  // the operator that production mode "DOES apply the system prompt your
  // control plane has approved".
  if (unwired) {
    logger?.info?.(
      `[${pluginId}] applying nothing the control plane has approved: ` +
      `${unwired}. Turns are still captured locally.`);
    return source;
  }

  // THE AGENT SCOPE, decided once. A host running several agents with none of
  // them named is the one case where we cannot tell whose bundle this is, and
  // the handlers will then refuse every run. Saying so at startup is the
  // difference between a fixable setting and a feature that silently does
  // nothing.
  if (!servedAgent.id) {
    logger?.warn?.(
      `[${pluginId}] nothing the control plane approves will be applied: ` +
      `${servedAgent.reason}.`);
  }

  if (applyPrompt) {
    api.on(PROMPT_HOOK_NAME, (event, ctx) => {
      // The host isolates a throwing hook, but it logs a warning per failure
      // and this one sits in front of every turn. One swallowed error is a
      // turn on the host's own prompt; a throw here would be a warning per
      // turn, forever, with our name on it.
      try {
        return source.handle(event, ctx ?? null);
      } catch {
        return undefined;
      }
    });
  } else {
    logger?.info?.(
      `[${pluginId}] the approved system prompt is NOT being applied: ` +
      `${PROMPT_OFF_REASON}. ${PROMPT_HOOK_NAME} is not subscribed.`);
  }

  // THE MODEL HOOK IS SUBSCRIBED ONLY WHEN THE WHOLE SEAM IS OPEN, and the
  // sentence the operator reads is the SAME STRING the source reports through
  // `modelRefusal`. `api.on` accepts a subscription the host will silently
  // drop, and `providerOverride` is honoured whether or not a provider answers
  // for the id, so the guarantee has to be the absence of the subscription.
  if (modelBlocked) {
    // The kill switch is the operator's own instruction; the rest are things
    // they would want to know about.
    const write = modelBlocked === MODEL_OFF_REASON ? logger?.info : logger?.warn;
    write?.call(logger,
      `[${pluginId}] the approved model is NOT being applied: ` +
      `${modelBlocked}. ${MODEL_HOOK_NAME} is not subscribed. The prompt ` +
      "half is unaffected.");
  } else {
    api.on(MODEL_HOOK_NAME, (event, ctx) => {
      try {
        return source.handleModelResolve(event, ctx ?? null);
      } catch {
        return undefined;
      }
    });
  }

  // NOT AWAITED and never rejecting: `register()` must return to the host
  // synchronously, and a slow control plane must not delay a plugin load.
  Promise.resolve(after)
    .catch(() => {})
    .then(() => source.resolve(transport))
    .catch(() => {});

  return source;
}
