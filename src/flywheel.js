/**
 * THE FRAMEWORK API: Agent Flywheel for any JavaScript or TypeScript agent.
 *
 * The OpenClaw and DeepSeek Harness plugins load into a host that fires hooks.
 * An agent written with the Vercel AI SDK, LangChain.js, Mastra, the OpenAI
 * SDK or plain code has no such host -- so this module IS one: a small,
 * in-process host that implements the slice of the plugin API `register()`
 * consumes, and fires its hooks from the customer's own calls.
 *
 * WHY A HOST AND NOT A SECOND IMPLEMENTATION. Production capture (consent,
 * upload, retention, outcomes), the approved system prompt and model, and the
 * training lane (registration, claim, heartbeat, deadline, outbox, report) are
 * each one lane in this package with one set of tests. Re-composing them here
 * would be a second copy of every one of those decisions, to be kept in step
 * by a comment. Instead `register()` runs unchanged, and this file only
 * translates "the customer started a turn" into the hooks a turn fires. The
 * one seam the rollout lane needed is `startTurn`/`cancel` (rollout.js):
 * OpenClaw starts a rollout's turn through its cron service; this host starts
 * it by calling the customer's agent function.
 *
 *   const fw = flywheel({ agentId: "support-agent" });
 *   // production: wrap each turn you serve
 *   const answer = await fw.turn(userMessage, async (t) => runAgent(t), {
 *     conversationId });
 *   // training: run the tasks the control plane sends
 *   await fw.serve(async (t) => runAgent(t));
 *
 * `t` is the same in both: the input, the system prompt to use
 * (`t.systemPrompt(yours)`), the model to call (`t.model`, or null to keep
 * yours), an abort signal, and `t.recordToolCall`. The adapters
 * (`/ai-sdk`, `/langchain`) find the current turn by themselves.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { ConfigurationError } from "./errors.js";
import { nowUnixNano } from "./genai-otlp.js";
import { PLUGIN_ID } from "./config.js";
import { register as registerPlugin } from "./index.js";
import { PROVIDER_ID, TOOL_DESCRIPTIONS } from "./policy.js";
import { normalizeAgentId } from "./scope.js";

/** Hooks whose handlers RETURN a decision; the first one given wins. */
const DECISION_HOOKS = new Set([
  "before_prompt_build", "before_model_resolve", "before_agent_run",
  "before_tool_call",
]);

const turnScope = new AsyncLocalStorage();

/**
 * The turn (or rollout) the calling code is running inside, or null. What the
 * adapters use, so a framework callback needs no handle passed to it.
 */
export function currentTurn() {
  return turnScope.getStore() ?? null;
}

/**
 * Record one executed tool call against the current turn or rollout. Outside
 * one it is a no-op returning false, so instrumentation can stay in code that
 * also runs outside the flywheel. The Python SDK's `record_tool_call`.
 */
export function recordToolCall(call) {
  return currentTurn()?.recordToolCall(call) ?? false;
}

/** A tool call refused because its rollout's lease was revoked. */
export class ToolCallBlocked extends Error {
  constructor(reason) {
    super(reason);
    this.name = "ToolCallBlocked";
  }
}

const QUIET_INFO = { info() {}, warn: (m) => console.warn(m), error: (m) => console.error(m) };

const text = (value) => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.text === "string") {
    return value.text;
  }
  return "";
};

/**
 * Build the in-process host and register the plugin's lanes on it.
 *
 * @param {object} [options] the plugin's own settings, by the same names
 *   (`agentId`, `apiKey`, `controlPlaneUrl`, `mode`, `capture`,
 *   `applyPrompt`, `applyModel`, `introspect`, `describe`, `rules`,
 *   `retentionTurns`), each also read from its PERCEPTEYE_* variable as the
 *   plugin reads it; plus `logger` (default: warnings to the console) and
 *   `servedModelApiKey`, the credential for an approved model served at an
 *   endpoint of your own (an endpoint the control plane sends a key for, or
 *   serves at its own address, needs none).
 * @param {object} [env] the environment the settings are read from.
 */
export function flywheel(options = {}, env = process.env) {
  const {
    logger = QUIET_INFO, servedModelApiKey = null, framework = "custom",
    ...pluginConfig
  } = options ?? {};
  // AN AGENT IS NAMED, ALWAYS. The plugin's default ("openclaw") names the
  // OpenClaw install; a framework agent registered under it would be some
  // other agent's row, key and consent. The Python SDK requires `agent_id`
  // for the same reason.
  const agentId = pluginConfig.agentId ?? env?.PERCEPTEYE_AGENT_ID;
  if (typeof agentId !== "string" || !agentId.trim()) {
    throw new ConfigurationError(
      "flywheel() needs the agent's name: pass { agentId } or set " +
      "PERCEPTEYE_AGENT_ID -- the name you gave the agent at " +
      "launch.percepteye.ai, which its key is bound to");
  }
  const handlers = new Map();
  let provider = null;
  // The one host agent this process serves, in the host's namespace -- the
  // join `resolveServedAgent` makes. A framework process serves one agent,
  // so there is nothing to disambiguate and nothing to guess.
  const hostAgent = normalizeAgentId(agentId) ?? "main";
  const controllers = new Map();

  const api = {
    logger,
    config: {
      agents: { list: [{ id: hostAgent }] },
      // The customer's own code calls `turn()` with the answer in hand, so
      // the conversation hooks are not something to opt into here: they are
      // the call itself.
      plugins: { entries: { [PLUGIN_ID]: { hooks: { allowConversationAccess: true } } } },
    },
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    registerProvider(spec) {
      if (spec?.id !== PROVIDER_ID) {
        throw new ConfigurationError(`this host registers only ${PROVIDER_ID}`);
      }
      provider = spec;
    },
  };

  /** Fire an observer hook: every handler, awaited, a throw contained. */
  async function emit(name, event, ctx) {
    for (const handler of handlers.get(name) ?? []) {
      try {
        await handler(event, ctx);
      } catch (err) {
        try { logger?.warn?.(`[${PLUGIN_ID}] ${name} failed: ${err?.message ?? err}`); } catch { /* */ }
      }
    }
  }

  /** Fire a decision hook: the first handler that answers decides. */
  async function decide(name, event, ctx) {
    for (const handler of handlers.get(name) ?? []) {
      let answer;
      try {
        answer = await handler(event, ctx);
      } catch {
        answer = undefined;
      }
      if (answer !== undefined && answer !== null) return answer;
    }
    return undefined;
  }

  /**
   * The model this turn calls, as an OpenAI-compatible client wants it, or
   * null to keep the agent's own. Resolved the way OpenClaw resolves it: the
   * model hook names our provider, and the provider alone supplies the
   * address and the credential -- so this host cannot route anywhere the
   * lanes did not decide.
   */
  async function resolveModel(ctx) {
    const named = await decide("before_model_resolve", {}, ctx);
    if (named?.providerOverride !== PROVIDER_ID || !provider) return null;
    const transport = provider.normalizeTransport?.({
      provider: PROVIDER_ID, modelId: named.modelOverride,
    });
    if (!transport?.baseUrl) return null;
    const auth = servedModelApiKey
      ? null
      : provider.resolveSyntheticAuth?.({ provider: PROVIDER_ID });
    return {
      baseURL: transport.baseUrl,
      apiKey: servedModelApiKey ?? auth?.apiKey ?? null,
      model: named.modelOverride ?? null,
    };
  }

  // ── TRAINING: the rollout lane's two host seams ─────────────────────────
  let agentFn = null;
  const modelCalls = createFetchWitness(() => handle?.rollouts ?? null);
  let finished = 0;
  let onFinished = null;
  /** Ends a running `serve()`; set by it, called by `close()`. */
  let stopServing = null;

  async function startTurn({ sessionKey, rolloutId }) {
    const rollout = handle?.rollouts?.rolloutFor?.({ sessionKey });
    if (!agentFn || !rollout) {
      return { started: false, degraded: false, reason: "no agent function is serving" };
    }
    // Started, not awaited: the runner's answer is "did the turn start", and
    // the result arrives on `agent_end` like every other host's.
    runRollout(sessionKey, rolloutId, rollout).catch(() => {});
    return { started: true, degraded: false, reason: null };
  }

  async function cancel({ sessionKey }) {
    const controller = controllers.get(sessionKey);
    if (!controller) return false;
    controller.abort(new Error("the rollout's lease was revoked or its deadline passed"));
    return true;
  }

  async function runRollout(sessionKey, rolloutId, rollout) {
    const runId = `r_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const ctx = { agentId: hostAgent, sessionKey, runId };
    const gate = await decide("before_agent_run", {}, ctx);
    if (gate?.outcome === "block") return;
    const controller = new AbortController();
    controllers.set(sessionKey, controller);
    const input = rollout.turnInput;
    let messages = [{ role: "user", content: input }];
    let success = true;
    try {
      const model = await resolveModel(ctx);
      // The GATEWAY is watched, whatever the agent was handed: a call that
      // bypasses it is exactly the one the count must not include.
      const watched = modelCalls.watch(rollout.llmUrl, { sessionKey, runId });
      try {
        const turn = makeTurn({
          input, ctx, model, prompt: null, signal: controller.signal, rolloutId,
        });
        const result = await turnScope.run(turn, () => agentFn(turn));
        const answer = text(result);
        if (result && typeof result === "object" && result.success === false) success = false;
        messages = [...messages, { role: "assistant", content: answer }];
      } finally {
        watched();
      }
    } catch (err) {
      // The agent ran and failed: a real attempt, REPORTED, as every lane
      // reports it -- never handed back as if it had not run.
      success = false;
      try {
        logger?.warn?.(`[${PLUGIN_ID}] rollout ${rolloutId}: the agent threw: ${err?.message ?? err}`);
      } catch { /* telemetry */ }
    } finally {
      controllers.delete(sessionKey);
    }
    // THE LANE'S OWN HANDLER, AWAITED. Its hook subscription is
    // fire-and-forget (a plugin must not hold an OpenClaw session on a
    // network call), so emitting `agent_end` would let serve() return before
    // the result was even spooled. `onAgentEnd` writes it to the outbox before
    // the first send and settles it on the answer.
    try {
      await handle?.rollouts?.onAgentEnd?.({ runId, messages, success }, ctx);
    } catch (err) {
      try { logger?.warn?.(`[${PLUGIN_ID}] rollout ${rolloutId}: ${err?.message ?? err}`); } catch { /* */ }
    }
    finished += 1;
    onFinished?.();
  }

  // Outcomes and feedback travel with PRODUCTION capture, which a training
  // process does not run: an episode's outcome is reported by the production
  // process that saw what happened next, naming the episode by `t.rolloutId`.
  // Said once, never a silent null.
  let saidNoUploader = false;
  const noUploader = (what) => {
    if (!saidNoUploader) {
      saidNoUploader = true;
      try {
        logger?.warn?.(
          `[${PLUGIN_ID}] ${what}() sent nothing: outcomes and feedback are ` +
          `reported by a production process (this one is ` +
          `${handle?.mode ?? "not capturing"}). Report an episode's outcome from ` +
          "production with { episodeId } set to the rollout's t.rolloutId.");
      } catch { /* telemetry */ }
    }
    return null;
  };

  const handle = registerPlugin(api, pluginConfig, env, {
    startTurn, cancel,
    // What registers: this API, and the framework the agent is built with
    // ("custom" unless you say -- the Python SDK's word for the same).
    entrypoint: "agent-flywheel-node:flywheel", framework,
  });

  /** The `t` an agent function is handed. */
  function makeTurn({
    input, ctx, model, prompt, signal, rolloutId = null, turnId = null,
    toolDescriptions = null,
  }) {
    let saidInput = false;
    const startedAt = nowUnixNano();
    const tools = toolDescriptions ? Object.freeze({ ...toolDescriptions }) : null;
    return Object.freeze({
      input,
      rolloutId,
      turnId,
      conversationId: rolloutId ? null : (ctx.sessionKey ?? null),
      model,
      signal,
      /**
       * The tool descriptions approved WITH the system prompt this turn
       * applies, `{toolName: description}`, or null (design 2026-11-21,
       * contract B). The AI SDK middleware applies them by itself; with
       * LangChain.js, `applyToolDescriptions(tools)` before binding.
       */
      toolDescriptions: tools,
      /** The approved system prompt when one applies, otherwise `yours`. */
      systemPrompt(yours = "") {
        return prompt ?? yours;
      },
      /** The approved description of tool `name` when one applies, otherwise `yours`. */
      toolDescription(name, yours = "") {
        return tools && Object.hasOwn(tools, name) ? tools[name] : yours;
      },
      /** One executed tool call, with its stated outcome when you know it. */
      recordToolCall({
        name, arguments: args = {}, outcome, statusCode, result, error,
        errorClass, latencyMs, toolCallId,
      } = {}) {
        if (typeof name !== "string" || !name) return false;
        const event = {
          toolName: name,
          params: args,
          result,
          error: error instanceof Error ? error : (error ?? undefined),
          durationMs: latencyMs,
          toolCallId,
          runId: ctx.runId,
        };
        if (outcome !== undefined) {
          event.percepteyeVerdict = {
            outcome, statusCode,
            error: error instanceof Error ? error.message : error,
            errorClass: errorClass ?? (error instanceof Error ? error.name : undefined),
          };
        }
        const before = handle?.recorder?.written ?? 0;
        for (const h of handlers.get("after_tool_call") ?? []) {
          try { h(event, ctx); } catch { /* one lost record */ }
        }
        return (handle?.recorder?.written ?? 0) > before;
      },
      /**
       * Whether a model call or tool execution observed now is recorded on
       * this turn's model boundary: a production turn of an agent the control
       * plane said may upload model content. Adapters ask it first and do no
       * work when it is false (the Python SDK's `model_capture_active`).
       */
      capturingModelContent() {
        try {
          return handle?.capture?.turns?.mayRecordModelContent?.() === true;
        } catch {
          return false;
        }
      },
      /**
       * Record ONE model call (`operation: "chat"`) or tool execution
       * (`operation: "execute_tool"`) of this turn, as it happened -- the
       * Python SDK's `record_model_boundary`. Observe only; never throws.
       */
      recordModelOperation(op) {
        try {
          return handle?.capture?.turns?.onModelOperation?.(
            op, ctx, { start: startedAt }) === true;
        } catch {
          return false;
        }
      },
      /**
       * Throws `ToolCallBlocked` when this call must not run -- a training
       * rollout whose lease the control plane revoked. Adapters call it
       * before a tool executes.
       */
      async guardToolCall(name, args = {}) {
        const answer = await decide("before_tool_call", { toolName: name, params: args, runId: ctx.runId }, ctx);
        if (answer?.block) throw new ToolCallBlocked(answer.blockReason ?? "blocked");
      },
      /**
       * What the model is sent, once per turn: the system prompt, the
       * prompt, the model and the tools. Adapters report it; it describes the
       * agent to the control plane and, under its consent, is captured.
       */
      observeModelInput({ systemPrompt, prompt, historyMessages, provider: p, model: m, tools } = {}) {
        if (saidInput) return false;
        saidInput = true;
        const event = {
          runId: ctx.runId, sessionId: ctx.sessionKey, systemPrompt, prompt,
          historyMessages, provider: p, model: m, tools,
        };
        for (const h of handlers.get("llm_input") ?? []) {
          try { h(event, ctx); } catch { /* one lost observation */ }
        }
        return true;
      },
    });
  }

  return {
    /** `training` or `production`, as resolved from options and environment. */
    mode: handle?.mode ?? null,
    /** The plugin's handle, for diagnostics. */
    plugin: handle,

    /**
     * Run one production turn through `fn(t)` and return what it returns.
     *
     * Captures the turn (the input, the tool calls, the answer) and hands
     * `fn` the approved system prompt and model when a person approved them.
     * A throw from `fn` is rethrown, after the turn is closed. In training
     * mode the turn still runs, recording nothing for the control plane.
     *
     * @param {string} input the user's message
     * @param {(t: object) => Promise<string|{text: string}>} fn
     * @param {{conversationId?: string, turnId?: string, taskId?: string}} [opts]
     */
    async turn(input, fn, { conversationId, turnId, taskId } = {}) {
      if (typeof fn !== "function") throw new TypeError("turn(input, fn): fn must be a function");
      const runId = turnId ?? `t_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const ctx = { agentId: hostAgent, sessionKey: conversationId, runId, taskId };
      const content = String(input ?? "");
      await emit("message_received", {
        runId, content, sessionKey: conversationId, taskId,
      }, ctx);
      const built = await decide("before_prompt_build", { prompt: content, messages: [] }, ctx);
      const model = await resolveModel(ctx);
      const applies = typeof built?.systemPrompt === "string";
      const turn = makeTurn({
        input: content, ctx, model,
        prompt: applies ? built.systemPrompt : null,
        // Only WITH the text they were approved with, from the same answer.
        toolDescriptions: applies ? (built[TOOL_DESCRIPTIONS] ?? null) : null,
        signal: undefined, turnId: runId,
      });
      let result;
      try {
        result = await turnScope.run(turn, () => fn(turn));
      } catch (err) {
        await emit("agent_end", {
          runId, messages: [{ role: "user", content }], success: false,
        }, ctx);
        throw err;
      }
      await emit("agent_end", {
        runId,
        messages: [{ role: "user", content }, { role: "assistant", content: text(result) }],
        success: true,
      }, ctx);
      return result;
    },

    /**
     * Training: claim the tasks the control plane sends, run each through
     * `fn(t)` (`t.input` is the task; call `t.model`, the checkpoint being
     * trained), and report what happened. Resolves when `maxRollouts` have
     * finished, when `signal` aborts, or when `close()` is called.
     *
     * Refuses at once, saying why, when this process cannot drive: not in
     * training mode, no key, or the control plane refused this worker.
     */
    async serve(fn, { maxRollouts = null, signal = null } = {}) {
      if (typeof fn !== "function") throw new TypeError("serve(fn): fn must be a function");
      const driver = handle?.rollouts;
      if (!driver?.unattended) {
        throw new ConfigurationError(
          handle?.mode === "training"
            ? "this process cannot run rollouts; the warning above says why"
            : "serve() runs training rollouts, and this process is in production " +
              "mode. Set PERCEPTEYE_AGENT_MODE=training (and allow practice runs " +
              "for the agent in Mission Control) to contribute.",
        );
      }
      if (agentFn) throw new ConfigurationError("serve() is already running");
      agentFn = fn;
      const runner = driver.unattended;
      const restore = modelCalls.install();
      let stopped = false;
      let wake = null;
      const sleep = (ms) => new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        wake = () => { clearTimeout(timer); resolve(); };
      });
      const stop = () => { stopped = true; wake?.(); };
      stopServing = stop;
      signal?.addEventListener?.("abort", stop, { once: true });
      finished = 0;
      try {
        // ITS OWN LOOP, not the runner's timer. The runner paces an OpenClaw
        // gateway's background poll (30 s idle); a process whose whole job
        // is serving rollouts goes straight back to the claim, which itself
        // long-polls the control plane. Claiming still goes through
        // `runner.tick()` -- the one gate, the registration wait and the
        // outbox drain in front of every claim.
        while (!stopped && !signal?.aborted) {
          if (maxRollouts !== null && finished >= maxRollouts) break;
          const before = finished;
          const started = await runner.tick().catch(() => null);
          if (stopped) break;
          if (!started) {
            await sleep(1_000);
            continue;
          }
          // Counted, not merely awaited: a rollout can finish before the
          // claim's own bookkeeping returns.
          if (finished === before) {
            await new Promise((resolve) => {
              onFinished = resolve;
              wake = resolve;
            });
          }
          onFinished = null;
        }
      } finally {
        runner.stop();
        signal?.removeEventListener?.("abort", stop);
        stopServing = null;
        // A rollout still running goes down with serve(): it is HANDED BACK
        // (`session_end` -> `entrypoint_error`, which requeues it), never
        // reported as the agent's failure, and its run is aborted.
        for (const [sessionKey, controller] of [...controllers]) {
          await emit("session_end", {
            sessionKey, reason: "serve() stopped before the agent answered",
          }, {});
          controller.abort(new Error("serve() stopped"));
        }
        driver.stopTimers?.();
        restore();
        agentFn = null;
      }
    },

    /** The rollout or turn the calling code is inside, or null. */
    currentTurn,

    /** How a production turn or conversation turned out. See the README. */
    reportOutcome(outcome, opts = {}) {
      if (!handle?.capture) return noUploader("reportOutcome");
      return handle.capture.reportOutcome(outcome, opts);
    },

    /** What a user did with one turn. See the README. */
    reportTurnFeedback(signal, opts = {}) {
      if (!handle?.capture) return noUploader("reportTurnFeedback");
      return handle.capture.reportTurnFeedback(signal, opts);
    },

    /**
     * Stop serving and send what is waiting: every captured turn not yet
     * uploaded goes now (bounded, so an unreachable control plane cannot hold
     * your process), the rest stays on disk for next time.
     */
    async close() {
      stopServing?.();
      await emit("gateway_stop", {}, {});
    },
  };
}

/**
 * THE INDEPENDENT MODEL-CALL WITNESS for in-process rollouts: the Python
 * SDK's `policy_calls`, at the client. While a rollout runs, every POST this
 * process makes under that rollout's model URL is a provider call, observed
 * from its start to its response and fed to the rollout lane's counter
 * (`onModelCallStarted`/`onModelCallEnded`) under the rollout's own session
 * and run. The control plane reconciles it against what its gateway saw;
 * without it every rollout is held out of training as `llm_calls_unobserved`.
 *
 * `globalThis.fetch` is wrapped only while `serve()` runs, and only matching
 * requests are touched; the OpenAI SDK, the Vercel AI SDK and
 * LangChain.js all reach the network through it. A client that does not is
 * not seen, and the rollout is reported with no count rather than a wrong one.
 * `<llm_url>/hosted/...` is the rollout's route to models that are NOT the
 * policy (simulators, judges), so it is not counted.
 */
function createFetchWitness(getDriver) {
  const watched = new Map();
  const matches = (url) => {
    for (const [base, scope] of watched) {
      if ((url === base || url.startsWith(`${base}/`))
          && !(url === `${base}/hosted` || url.startsWith(`${base}/hosted/`))) {
        return scope;
      }
    }
    return null;
  };
  return {
    watch(baseUrl, scope) {
      if (typeof baseUrl !== "string" || !baseUrl) return () => {};
      const base = baseUrl.replace(/\/+$/, "");
      watched.set(base, scope);
      return () => {
        if (watched.get(base) === scope) watched.delete(base);
      };
    },
    install() {
      const original = globalThis.fetch;
      if (typeof original !== "function") return () => {};
      const wrapped = async function fetch(input, init) {
        let url = "";
        let method = "GET";
        try {
          url = typeof input === "string" ? input : (input?.url ?? String(input));
          method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
        } catch { /* not a request we can read: not ours */ }
        const scope = method === "POST" ? matches(url) : null;
        if (!scope) return original.call(this, input, init);
        const driver = getDriver();
        const callId = randomUUID();
        const event = { ...scope, callId };
        driver?.onModelCallStarted?.(event, scope);
        try {
          const response = await original.call(this, input, init);
          driver?.onModelCallEnded?.(
            { ...event, outcome: response.status < 400 ? "completed" : "error" }, scope);
          return response;
        } catch (err) {
          driver?.onModelCallEnded?.({ ...event, outcome: "error" }, scope);
          throw err;
        }
      };
      globalThis.fetch = wrapped;
      return () => {
        if (globalThis.fetch === wrapped) globalThis.fetch = original;
      };
    },
  };
}
