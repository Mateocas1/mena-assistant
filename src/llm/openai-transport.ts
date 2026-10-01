import OpenAI from "openai";
import type {
  LlmCallOptions,
  LlmCompletion,
  LlmCompletionRequest,
  LlmMessage,
  LlmToolCall,
  LlmTransport,
} from "./types.js";

export interface OpenAiTransportOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
}

function toChatMessages(
  messages: readonly LlmMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((message): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
    switch (message.role) {
      case "system":
        return { role: "system", content: message.content ?? "" };
      case "user":
        return { role: "user", content: message.content ?? "" };
      case "tool":
        return {
          role: "tool",
          tool_call_id: message.toolCallId ?? "",
          content: message.content ?? "",
        };
      case "assistant": {
        const toolCalls = message.toolCalls ?? [];
        if (toolCalls.length === 0) {
          return { role: "assistant", content: message.content ?? "" };
        }
        return {
          role: "assistant",
          content: message.content ?? null,
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        };
      }
    }
  });
}

function toToolCalls(
  calls: readonly OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined,
): LlmToolCall[] {
  return (calls ?? [])
    .filter((call) => call.type === "function")
    .map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments }));
}

/**
 * OpenAI-compatible transport. `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL`
 * are the only knobs: pointing the assistant at another provider is an env change.
 */
export class OpenAiTransport implements LlmTransport {
  private readonly client: OpenAI;

  constructor(options: OpenAiTransportOptions) {
    // The tool loop owns retries and the fallback model, so the SDK must not retry.
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
      maxRetries: 0,
    });
  }

  async complete(request: LlmCompletionRequest, options: LlmCallOptions): Promise<LlmCompletion> {
    const response = await this.client.chat.completions.create(
      {
        model: request.model,
        messages: toChatMessages(request.messages),
        ...(request.tools.length > 0
          ? { tools: request.tools as unknown as OpenAI.Chat.Completions.ChatCompletionTool[] }
          : {}),
      },
      {
        timeout: options.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );

    const message = response.choices[0]?.message;
    const usage = response.usage;

    return {
      content: message?.content ?? null,
      toolCalls: toToolCalls(message?.tool_calls),
      model: response.model,
      ...(usage
        ? {
            usage: {
              prompt: usage.prompt_tokens,
              completion: usage.completion_tokens,
              total: usage.total_tokens,
            },
          }
        : {}),
    };
  }
}
