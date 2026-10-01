import type { AppConfig } from "../config.js";
import { OpenAiTransport } from "./openai-transport.js";
import type { LlmTransport } from "./types.js";

export { OpenAiTransport } from "./openai-transport.js";
export { buildSystemPrompt } from "./prompt.js";
export {
  CAP_REPLY,
  EMPTY_REPLY,
  INVALID_ARGUMENTS_REPLY,
  runToolLoop,
  userMessageOf,
  type ToolCallRecord,
  type ToolCallStatus,
  type ToolLoopConfig,
  type ToolLoopOptions,
  type ToolLoopResult,
  type ToolLoopStopReason,
} from "./loop.js";
export {
  LlmError,
  type LlmCallOptions,
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmMessage,
  type LlmToolCall,
  type LlmTransport,
  type LlmUsage,
} from "./types.js";

/** Builds the transport from configuration: changing provider is an env change. */
export function createLlmTransport(config: AppConfig): LlmTransport {
  return new OpenAiTransport({ apiKey: config.llm.apiKey, baseUrl: config.llm.baseUrl });
}
