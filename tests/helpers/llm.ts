import type {
  LlmCallOptions,
  LlmCompletion,
  LlmCompletionRequest,
  LlmTransport,
} from "../../src/llm/types.js";

export type ScriptStep =
  | LlmCompletion
  | Error
  | ((request: LlmCompletionRequest) => LlmCompletion | Promise<LlmCompletion>);

/** Deterministic provider: returns scripted completions and records what it was asked. */
export class ScriptedTransport implements LlmTransport {
  readonly requests: LlmCompletionRequest[] = [];
  readonly calls: LlmCallOptions[] = [];
  private readonly script: ScriptStep[];

  constructor(script: ScriptStep[]) {
    this.script = [...script];
  }

  async complete(request: LlmCompletionRequest, options: LlmCallOptions): Promise<LlmCompletion> {
    // Copy: the loop keeps appending to the same array after this call.
    this.requests.push({ ...request, messages: [...request.messages] });
    this.calls.push(options);
    const next = this.script.shift();
    if (next === undefined) throw new Error("ScriptedTransport: script exhausted");
    if (next instanceof Error) throw next;
    if (typeof next === "function") return await next(request);
    return next;
  }

  remaining(): number {
    return this.script.length;
  }
}

const USAGE = { prompt: 10, completion: 5, total: 15 };

export function toolCallCompletion(name: string, args: unknown, id = "call_1"): LlmCompletion {
  return {
    content: null,
    toolCalls: [
      {
        id,
        name,
        // Objects are serialised; a string is passed through so tests can send invalid JSON.
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      },
    ],
    model: "scripted-model",
    usage: USAGE,
  };
}

export interface ScriptedToolCall {
  readonly name: string;
  readonly args: unknown;
  readonly id?: string;
}

/** One assistant completion requesting several tools at once (parallel tool calls). */
export function toolCallsCompletion(calls: readonly ScriptedToolCall[]): LlmCompletion {
  return {
    content: null,
    toolCalls: calls.map((call, index) => ({
      id: call.id ?? `call_${index + 1}`,
      name: call.name,
      arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args),
    })),
    model: "scripted-model",
    usage: USAGE,
  };
}

export function textCompletion(text: string): LlmCompletion {
  return { content: text, toolCalls: [], model: "scripted-model", usage: USAGE };
}
