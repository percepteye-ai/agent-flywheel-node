/**
 * THE VERCEL AI SDK ADAPTER. Two pieces, each optional, neither importing
 * `ai`: this package keeps zero runtime dependencies, and these are plain
 * objects in the shapes the AI SDK already accepts.
 *
 *   import { flywheelTools, flywheelMiddleware } from "@percepteye/agent-flywheel/ai-sdk";
 *
 *   const model = wrapLanguageModel({ model: base, middleware: flywheelMiddleware() });
 *   await generateText({ model, tools: flywheelTools(tools), prompt: t.input });
 *
 * `flywheelTools` records every executed tool call against the current turn
 * or rollout (`currentTurn()`), and refuses to run one once a training
 * rollout's lease is revoked. `flywheelMiddleware` reports what the model is
 * sent -- system prompt, prompt, tools, model -- once per turn: the agent's
 * description, and under its consent tier, its captured model input.
 *
 * Outside a turn both are pass-throughs, so the same agent code serves
 * traffic the flywheel never sees.
 */
import { currentTurn } from "../flywheel.js";

/**
 * Wrap a `tools` record so each executed call is recorded.
 *
 * A call that THROWS is `failed`. A call that returns is `unknown` unless
 * the result says otherwise in a way this package reads (an `Error`, an exit
 * status): a returned value is not proof the side effect landed, and this
 * package never rounds an unobserved result up to `ok`. State it yourself
 * with `recordToolCall({ outcome })` where you know better.
 *
 * @template T
 * @param {T} tools the record you pass to `generateText` / `streamText`
 * @returns {T}
 */
export function flywheelTools(tools) {
  if (!tools || typeof tools !== "object") return tools;
  const out = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool || typeof tool.execute !== "function") {
      out[name] = tool;
      continue;
    }
    const execute = tool.execute;
    out[name] = {
      ...tool,
      async execute(args, options) {
        const turn = currentTurn();
        if (!turn) return execute.call(tool, args, options);
        await turn.guardToolCall(name, args);
        const started = performance.now();
        const toolCallId = typeof options?.toolCallId === "string" ? options.toolCallId : undefined;
        try {
          const result = await execute.call(tool, args, options);
          turn.recordToolCall({
            name, arguments: args, result, toolCallId,
            latencyMs: performance.now() - started,
          });
          return result;
        } catch (err) {
          turn.recordToolCall({
            name, arguments: args, error: err instanceof Error ? err : String(err),
            toolCallId, latencyMs: performance.now() - started,
          });
          throw err;
        }
      },
    };
  }
  return out;
}

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text).join("");
};

/**
 * The model input, in the shape `observeModelInput` takes, from the AI SDK's
 * call options: `params.prompt` (its messages, the system prompt among
 * them), `params.tools`, and the model's id and provider.
 */
export function modelInputOf(params, model) {
  const messages = Array.isArray(params?.prompt) ? params.prompt : [];
  const system = messages.filter((m) => m?.role === "system").map((m) => textOf(m.content))
    .filter(Boolean).join("\n\n");
  const rest = messages.filter((m) => m?.role !== "system");
  let last = -1;
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    if (rest[i]?.role === "user") { last = i; break; }
  }
  return {
    systemPrompt: system || undefined,
    prompt: last >= 0 ? textOf(rest[last].content) : undefined,
    historyMessages: last >= 0 ? rest.slice(0, last) : rest,
    provider: model?.provider,
    model: model?.modelId,
    tools: Array.isArray(params?.tools) ? params.tools : undefined,
  };
}

/**
 * A language-model middleware for `wrapLanguageModel` that reports the
 * model's input to the current turn, once per turn. It changes nothing the
 * model is sent and nothing it returns.
 */
export function flywheelMiddleware() {
  const observe = (params, model) => {
    try {
      currentTurn()?.observeModelInput(modelInputOf(params, model));
    } catch { /* an observation is never worth a failed call */ }
  };
  return {
    middlewareVersion: "v2",
    wrapGenerate: async ({ doGenerate, params, model }) => {
      observe(params, model);
      return doGenerate();
    },
    wrapStream: async ({ doStream, params, model }) => {
      observe(params, model);
      return doStream();
    },
  };
}
