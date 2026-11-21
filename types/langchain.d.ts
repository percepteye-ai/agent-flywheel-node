// Type declarations for @percepteye/agent-flywheel/langchain. Structural, so
// this package needs no dependency on LangChain: the handler is a plain
// object in the shape LangChain.js accepts in `callbacks`.
import type { FlywheelTurn, ModelInput } from "./index.js";

/** A callback handler bound to the turn it is created in. */
export function flywheelCallbacks(turn?: FlywheelTurn | null): {
  name: string;
  raiseError: boolean;
  handleToolStart(...args: any[]): void;
  handleToolEnd(...args: any[]): void;
  handleToolError(...args: any[]): void;
  handleChatModelStart(...args: any[]): void;
};

/** The chat-model input `flywheelCallbacks` reports. */
export function modelInputOf(llm: unknown, messages: unknown, extraParams?: unknown, runName?: string): ModelInput;
/** `tools` with the current turn's approved descriptions applied, as copies. */
export function applyToolDescriptions<T>(tools: T, turn?: FlywheelTurn | null): T;
