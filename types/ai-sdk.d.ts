// Type declarations for @percepteye/agent-flywheel/ai-sdk. Structural, so
// this package needs no dependency on `ai`: they match the AI SDK's tool and
// middleware shapes from v5 on.
import type { ModelInput } from "./index.js";

/** Wrap a `tools` record so every executed call is recorded. */
export function flywheelTools<T>(tools: T): T;

/** A middleware for `wrapLanguageModel` that reports the model's input. */
export function flywheelMiddleware(): {
  middlewareVersion: "v2";
  wrapGenerate: (options: { doGenerate: () => PromiseLike<any>; params: any; model: any }) => Promise<any>;
  wrapStream: (options: { doStream: () => PromiseLike<any>; params: any; model: any }) => Promise<any>;
};

/** The model input `flywheelMiddleware` reports, from the AI SDK's call options. */
export function modelInputOf(params: unknown, model: unknown): ModelInput;
