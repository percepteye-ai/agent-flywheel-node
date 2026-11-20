// Type declarations for @percepteye/agent-flywheel. The package is plain
// JavaScript with zero dependencies; these describe its public surface for
// TypeScript. `test/types.test.js` checks every runtime export is declared.

/** How one executed tool call turned out. Never rounded up: unseen is `unknown`. */
export type ToolOutcome = "ok" | "failed" | "unknown";

/** One executed tool call, as `recordToolCall` takes it. */
export interface ToolCall {
  name: string;
  arguments?: Record<string, unknown>;
  /** Say it when you know it; otherwise it is read from `error` / `result`. */
  outcome?: ToolOutcome;
  /** The HTTP status the call returned, when it was an HTTP call (100-599). */
  statusCode?: number;
  /** What the tool returned. Only entity ids are read out of it. */
  result?: unknown;
  error?: string | Error;
  errorClass?: string;
  latencyMs?: number;
  /** The id the model gave the call. */
  toolCallId?: string;
}

/** The model a turn calls, shaped for an OpenAI-compatible client. */
export interface FlywheelModel {
  baseURL: string;
  /** Null when the endpoint needs your own key (`servedModelApiKey`). */
  apiKey: string | null;
  model: string | null;
}

/** What the model is sent, as an adapter reports it. */
export interface ModelInput {
  systemPrompt?: string;
  prompt?: string;
  historyMessages?: Array<{ role: string; content: unknown }>;
  provider?: string;
  model?: string;
  tools?: unknown[];
}

/** The turn or rollout an agent function runs, handed to it as `t`. */
export interface FlywheelTurn {
  /** The user's message, or the rollout's task. */
  readonly input: string;
  /** Set in a training rollout, null in a production turn. */
  readonly rolloutId: string | null;
  /** Set in a production turn, null in a rollout. */
  readonly turnId: string | null;
  readonly conversationId: string | null;
  /**
   * The model to call: in training, the checkpoint being trained (always
   * use it); in production, the approved model, or null to keep your own.
   */
  readonly model: FlywheelModel | null;
  /** Aborts when a rollout's lease is revoked or its deadline passes. */
  readonly signal: AbortSignal | undefined;
  /** The approved system prompt when a person approved one, otherwise `yours`. */
  systemPrompt(yours?: string): string;
  /** Record one executed tool call. Returns whether it was recorded. */
  recordToolCall(call: ToolCall): boolean;
  /** Throws `ToolCallBlocked` when the call must not run. Adapters call it. */
  guardToolCall(name: string, args?: Record<string, unknown>): Promise<void>;
  /** Report the model's input, once per turn. Adapters call it. */
  observeModelInput(input: ModelInput): boolean;
}

/** What an agent function returns: the answer, or the answer and a verdict. */
export type AgentResult = string | { text: string; success?: boolean };

export interface FlywheelOptions {
  /** The agent's name in Mission Control. The key is bound to it. */
  agentId?: string;
  /** `pefw_...`; default PERCEPTEYE_API_KEY, then the key `login` stored. */
  apiKey?: string;
  controlPlaneUrl?: string;
  /** Default PERCEPTEYE_AGENT_MODE, then production. */
  mode?: "training" | "production";
  /** The framework the agent is built with, for its description. Default "custom". */
  framework?: string;
  /** False records nothing at all. */
  capture?: boolean;
  /** False leaves the system prompt alone. */
  applyPrompt?: boolean;
  /** False leaves the model alone. */
  applyModel?: boolean;
  /** False sends no description of the agent. */
  introspect?: boolean;
  describe?: unknown;
  rules?: string[];
  retentionTurns?: number;
  /** The key for an approved model served at an endpoint of your own. */
  servedModelApiKey?: string;
  logger?: {
    info?(message: string): void;
    warn?(message: string): void;
    error?(message: string): void;
  };
}

export interface TurnOptions {
  conversationId?: string;
  turnId?: string;
  /** Your own case or work-item id, for correlation only. */
  taskId?: string;
}

export interface ServeOptions {
  /** Stop after this many rollouts have finished. */
  maxRollouts?: number | null;
  signal?: AbortSignal | null;
}

export type ProductionOutcome =
  | "resolved" | "escalated" | "reopened" | "abandoned" | "thumbs_up" | "thumbs_down";
export type TurnFeedbackSignal =
  | "accepted" | "corrected" | "repeated" | "escalated" | "abandoned";

export interface OutcomeOptions {
  turnId?: string;
  conversationId?: string;
  episodeId?: string;
  value?: number;
  note?: string;
  occurredAt?: Date | string;
  outcomeId?: string;
}

export interface FeedbackOptions {
  turnId?: string;
  episodeId?: string;
  turnIndex?: number;
  occurredAt?: Date | string;
  feedbackId?: string;
}

export interface Flywheel {
  /** "training" or "production", as resolved; null when nothing registered. */
  readonly mode: "training" | "production" | null;
  /** Run one production turn through `fn` and return what it returns. */
  turn<R extends AgentResult>(
    input: string, fn: (t: FlywheelTurn) => Promise<R> | R, options?: TurnOptions,
  ): Promise<R>;
  /** Training: run the rollouts the control plane sends, until stopped. */
  serve(fn: (t: FlywheelTurn) => Promise<AgentResult> | AgentResult, options?: ServeOptions): Promise<void>;
  currentTurn(): FlywheelTurn | null;
  reportOutcome(outcome: ProductionOutcome, options?: OutcomeOptions): string | null;
  reportTurnFeedback(signal: TurnFeedbackSignal, options?: FeedbackOptions): string | null;
  /** Stop serving and send what is waiting (bounded). */
  close(): Promise<void>;
  /** The plugin's own handle, for diagnostics. */
  readonly plugin: unknown;
}

/** Build the flywheel for this process. */
export function flywheel(options?: FlywheelOptions, env?: Record<string, string | undefined>): Flywheel;
/** The turn or rollout the calling code is inside, or null. */
export function currentTurn(): FlywheelTurn | null;
/** Record a tool call against the current turn; a no-op (false) outside one. */
export function recordToolCall(call: ToolCall): boolean;
/** A tool call refused because its rollout's lease was revoked. */
export class ToolCallBlocked extends Error {}

export class InvalidOutcome extends Error {}
export class InvalidFeedback extends Error {}
export const PRODUCTION_OUTCOMES: readonly ProductionOutcome[];
export const TURN_FEEDBACK_SIGNALS: readonly TurnFeedbackSignal[];

// ── The OpenClaw / DeepSeek Harness plugin entry ─────────────────────────
export const PLUGIN_ID: "agent-flywheel";
export const HOOK_NAME: "after_tool_call";
export const DESCRIBE_HOOK_NAME: "llm_input";
/** Register the plugin on a host's plugin API. Hosts call this; you need not. */
export function register(api: unknown, pluginConfig?: Record<string, unknown>,
  env?: Record<string, string | undefined>, host?: Record<string, unknown>): unknown;
declare const plugin: {
  id: "agent-flywheel";
  name: string;
  description: string;
  configSchema: unknown;
  register: typeof register;
};
export default plugin;
