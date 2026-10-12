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
  /** Injected in tests; defaults to the global fetch. */
  readonly fetch?: typeof fetch;
}

// OpenAI-compatible APIs only accept function names matching
// ^[a-zA-Z0-9_-]{1,64}$. Internal tool names are dotted (`turnos.del_dia`), so
// the dot travels as a double underscore and is restored on the way back.
const WIRE_DOT = "__";

export function toWireToolName(name: string): string {
  return name.split(".").join(WIRE_DOT);
}

export function fromWireToolName(name: string): string {
  return name.split(WIRE_DOT).join(".");
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
            function: { name: toWireToolName(call.name), arguments: call.arguments },
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
    .map((call) => ({
      id: call.id,
      name: fromWireToolName(call.function.name),
      arguments: call.function.arguments,
    }));
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
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async complete(request: LlmCompletionRequest, options: LlmCallOptions): Promise<LlmCompletion> {
    const body = {
      model: request.model,
      messages: toChatMessages(request.messages),
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              ...tool,
              function: { ...tool.function, name: toWireToolName(tool.function.name) },
            })) as unknown as OpenAI.Chat.Completions.ChatCompletionTool[],
          }
        : {}),
    };
    const requestOptions = {
      timeout: options.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    };

    if (options.onText) return await this.stream(body, requestOptions, options.onText);

    const response = await this.client.chat.completions.create(body, requestOptions);
    const message = response.choices[0]?.message;
    return {
      content: message?.content ?? null,
      toolCalls: toToolCalls(message?.tool_calls),
      model: response.model,
      ...usageOf(response.usage),
    };
  }

  /** Same request with `stream: true`: text goes to `onText` as it arrives, tool calls are reassembled. */
  private async stream(
    body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    requestOptions: { timeout: number; signal?: AbortSignal },
    onText: (textSoFar: string) => void,
  ): Promise<LlmCompletion> {
    const chunks = await this.client.chat.completions.create(
      { ...body, stream: true, stream_options: { include_usage: true } },
      requestOptions,
    );
    let content = "";
    let model = body.model;
    let usage: OpenAI.Completions.CompletionUsage | undefined;
    const calls = new Map<number, { id: string; name: string; arguments: string }>();

    for await (const chunk of chunks) {
      model = chunk.model || model;
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        onText(content);
      }
      for (const fragment of delta.tool_calls ?? []) {
        const call = calls.get(fragment.index) ?? { id: "", name: "", arguments: "" };
        if (fragment.id) call.id = fragment.id;
        if (fragment.function?.name) call.name += fragment.function.name;
        if (fragment.function?.arguments) call.arguments += fragment.function.arguments;
        calls.set(fragment.index, call);
      }
    }

    return {
      content: content.length > 0 ? content : null,
      toolCalls: [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => ({ ...call, name: fromWireToolName(call.name) })),
      model,
      ...usageOf(usage),
    };
  }
}

function usageOf(usage: OpenAI.Completions.CompletionUsage | null | undefined): {
  usage?: { prompt: number; completion: number; total: number };
} {
  return usage
    ? {
        usage: {
          prompt: usage.prompt_tokens,
          completion: usage.completion_tokens,
          total: usage.total_tokens,
        },
      }
    : {};
}
