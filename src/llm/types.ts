import type { JsonFunctionToolSpec } from "../mcp/registry.js";

export interface LlmToolCall {
  readonly id: string;
  readonly name: string;
  /** Raw JSON string as delivered by the provider (`function.arguments`). */
  readonly arguments: string;
}

export interface LlmMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  /** Present on assistant messages that requested tools. */
  readonly toolCalls?: readonly LlmToolCall[];
  /** Present on tool messages: the assistant tool call they answer. */
  readonly toolCallId?: string;
}

export interface LlmUsage {
  readonly prompt: number;
  readonly completion: number;
  readonly total: number;
}

export interface LlmCompletionRequest {
  readonly model: string;
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly JsonFunctionToolSpec[];
}

export interface LlmCompletion {
  readonly content: string | null;
  readonly toolCalls: readonly LlmToolCall[];
  readonly model: string;
  readonly usage?: LlmUsage;
}

export interface LlmCallOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** When set, the reply is streamed and this receives the text so far after each chunk. */
  readonly onText?: (textSoFar: string) => void;
}

/** Transport seam: the real OpenAI-compatible client, or a scripted one in tests. */
export interface LlmTransport {
  complete(request: LlmCompletionRequest, options: LlmCallOptions): Promise<LlmCompletion>;
}

/** Raised when the model could not be reached (primary and fallback both failed). */
export class LlmError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlmError";
  }
}
