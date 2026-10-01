import { hashChatId, type AuditLogger } from "../audit/index.js";
import {
  serializeTools,
  ToolArgumentError,
  type ToolDefinition,
  type ToolHandlerContext,
} from "../mcp/registry.js";
import type { Proposal } from "../proposals/store.js";
import {
  LlmError,
  type LlmCompletion,
  type LlmMessage,
  type LlmTransport,
  type LlmUsage,
} from "./types.js";

export interface ToolLoopConfig {
  readonly model: string;
  readonly fallbackModel: string;
  readonly timeoutMs: number;
  readonly maxToolCalls: number;
}

export interface ToolLoopOptions {
  readonly transport: LlmTransport;
  readonly tools: readonly ToolDefinition[];
  readonly context: ToolHandlerContext;
  readonly config: ToolLoopConfig;
  readonly audit: AuditLogger;
  readonly systemPrompt: string;
  readonly userMessage: string;
}

export type ToolCallStatus = "ok" | "error" | "proposal" | "denied";

export type ToolLoopStopReason = "completed" | "tool_call_cap" | "invalid_arguments";

export interface ToolCallRecord {
  readonly tool: string;
  readonly args: unknown;
  readonly status: ToolCallStatus;
  readonly latencyMs: number;
  readonly error?: string;
  readonly proposalId?: string;
}

export interface ToolLoopResult {
  readonly reply: string;
  readonly proposals: readonly Proposal[];
  readonly toolCalls: readonly ToolCallRecord[];
  /** Model that produced the final answer (the fallback when it was used). */
  readonly model: string;
  readonly usedFallback: boolean;
  readonly stoppedReason: ToolLoopStopReason;
  readonly usage: LlmUsage;
}

export const CAP_REPLY =
  "Alcancé el límite de consultas para este mensaje. Probá de nuevo con un pedido más puntual.";
export const INVALID_ARGUMENTS_REPLY =
  "No pude interpretar los datos de la consulta y preferí no ejecutar nada. ¿Me lo reformulás?";
export const EMPTY_REPLY = "No pude armar una respuesta. ¿Me lo preguntás de otra forma?";

const ZERO_USAGE: LlmUsage = { prompt: 0, completion: 0, total: 0 };

function addUsage(left: LlmUsage, right: LlmUsage | undefined): LlmUsage {
  if (!right) return left;
  return {
    prompt: left.prompt + right.prompt,
    completion: left.completion + right.completion,
    total: left.total + right.total,
  };
}

function parseToolArguments(
  raw: string | undefined,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string } {
  const trimmed = raw?.trim() ?? "";
  if (trimmed.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid JSON" };
  }
}

function asArgsRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

/**
 * Reads the optional `userMessage` an adapter error carries (e.g. the 503
 * "not configured" copy). Duck-typed so the loop stays backend-agnostic.
 */
export function userMessageOf(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "userMessage" in error) {
    const value = (error as { userMessage?: unknown }).userMessage;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Bounded tool-calling loop: at most `maxToolCalls` tool executions per
 * conversation turn, one retry when the model sends invalid arguments, a
 * per-call timeout and a fallback model. It never executes a write: write tools
 * only return proposals.
 */
export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const { transport, tools, context, config, audit } = options;
  const chatIdHash = hashChatId(context.chatId);
  const toolSpecs = serializeTools(tools, context.clock);

  const messages: LlmMessage[] = [
    { role: "system", content: options.systemPrompt },
    { role: "user", content: options.userMessage },
  ];

  const proposals: Proposal[] = [];
  const records: ToolCallRecord[] = [];
  const retriedTools = new Set<string>();
  let usage = ZERO_USAGE;
  let toolCallCount = 0;
  let lastContent = "";
  let usedModel = config.model;
  let usedFallback = false;

  const finish = (stoppedReason: ToolLoopStopReason, reply: string): ToolLoopResult => ({
    reply,
    proposals,
    toolCalls: records,
    model: usedModel,
    usedFallback,
    stoppedReason,
    usage,
  });

  async function complete(messages_: readonly LlmMessage[]): Promise<LlmCompletion> {
    try {
      return await transport.complete(
        { model: config.model, messages: messages_, tools: toolSpecs },
        { timeoutMs: config.timeoutMs },
      );
    } catch (primaryError) {
      if (!config.fallbackModel || config.fallbackModel === config.model) {
        throw new LlmError(`Model ${config.model} failed`, { cause: primaryError });
      }
      try {
        const completion = await transport.complete(
          { model: config.fallbackModel, messages: messages_, tools: toolSpecs },
          { timeoutMs: config.timeoutMs },
        );
        usedFallback = true;
        usedModel = config.fallbackModel;
        return completion;
      } catch (fallbackError) {
        throw new LlmError(
          `Model ${config.model} and fallback ${config.fallbackModel} both failed`,
          { cause: fallbackError },
        );
      }
    }
  }

  for (;;) {
    const completion = await complete(messages);
    usage = addUsage(usage, completion.usage);
    if (completion.content && completion.content.trim().length > 0) {
      lastContent = completion.content.trim();
    }

    messages.push({
      role: "assistant",
      content: completion.content,
      toolCalls: completion.toolCalls,
    });

    if (completion.toolCalls.length === 0) {
      return finish("completed", lastContent || EMPTY_REPLY);
    }

    for (const call of completion.toolCalls) {
      if (toolCallCount >= config.maxToolCalls) {
        audit.log({
          event: "llm_turn",
          profile: context.profile,
          chatIdHash,
          model: usedModel,
          detail: "tool_call_cap",
          status: "denied",
          tokens: usage,
        });
        return finish("tool_call_cap", CAP_REPLY);
      }
      toolCallCount += 1;

      const tool = tools.find((candidate) => candidate.name === call.name);
      if (!tool) {
        const detail = `Unknown tool: ${call.name}`;
        records.push({
          tool: call.name,
          args: undefined,
          status: "error",
          latencyMs: 0,
          error: detail,
        });
        audit.log({
          event: "tool_call",
          profile: context.profile,
          chatIdHash,
          tool: call.name,
          status: "error",
          error: detail,
          model: usedModel,
          tokens: completion.usage,
        });
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: `Tool error: ${detail}. Use one of the available tools.`,
        });
        continue;
      }

      const parsedArgs = parseToolArguments(call.arguments);
      if (!parsedArgs.ok) {
        const detail = `invalid arguments JSON: ${parsedArgs.error}`;
        records.push({
          tool: call.name,
          args: undefined,
          status: "error",
          latencyMs: 0,
          error: detail,
        });
        audit.log({
          event: "tool_call",
          profile: context.profile,
          chatIdHash,
          tool: call.name,
          status: "error",
          error: detail,
          model: usedModel,
          tokens: completion.usage,
        });
        if (retriedTools.has(call.name)) {
          return finish("invalid_arguments", INVALID_ARGUMENTS_REPLY);
        }
        retriedTools.add(call.name);
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: `Tool error: arguments are not valid JSON (${parsedArgs.error}). Retry once with valid JSON for this tool schema.`,
        });
        continue;
      }

      // One pending write proposal per turn: further writes are refused until the
      // user confirms or cancels the one already on screen.
      if (tool.kind === "write" && proposals.length >= 1) {
        const detail = "a pending write proposal already exists for this turn";
        records.push({
          tool: call.name,
          args: parsedArgs.value,
          status: "denied",
          latencyMs: 0,
          error: detail,
        });
        audit.log({
          event: "tool_call",
          profile: context.profile,
          chatIdHash,
          tool: call.name,
          args: asArgsRecord(parsedArgs.value),
          status: "denied",
          error: detail,
          latencyMs: 0,
          model: usedModel,
          tokens: completion.usage,
        });
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: `Tool error: ${detail}. Ask the user to confirm or cancel the pending proposal before proposing another action.`,
        });
        continue;
      }

      const started = Date.now();
      try {
        const result = await tool.execute(parsedArgs.value, context);
        const latencyMs = Date.now() - started;

        if (result.proposal) proposals.push(result.proposal);
        records.push({
          tool: call.name,
          args: parsedArgs.value,
          status: result.proposal ? "proposal" : "ok",
          latencyMs,
          ...(result.proposal ? { proposalId: result.proposal.id } : {}),
        });
        audit.log({
          event: "tool_call",
          profile: context.profile,
          chatIdHash,
          tool: call.name,
          args: asArgsRecord(parsedArgs.value),
          status: result.proposal ? "proposal" : "ok",
          latencyMs,
          model: usedModel,
          tokens: completion.usage,
        });
        messages.push({ role: "tool", toolCallId: call.id, content: result.content });
      } catch (error) {
        const latencyMs = Date.now() - started;
        const message = error instanceof Error ? error.message : String(error);
        const userMessage = userMessageOf(error);
        records.push({
          tool: call.name,
          args: parsedArgs.value,
          status: "error",
          latencyMs,
          error: message,
        });
        audit.log({
          event: "tool_call",
          profile: context.profile,
          chatIdHash,
          tool: call.name,
          args: asArgsRecord(parsedArgs.value),
          status: "error",
          error: message,
          latencyMs,
          model: usedModel,
          tokens: completion.usage,
        });

        if (error instanceof ToolArgumentError) {
          if (retriedTools.has(call.name))
            return finish("invalid_arguments", INVALID_ARGUMENTS_REPLY);
          retriedTools.add(call.name);
          messages.push({
            role: "tool",
            toolCallId: call.id,
            content: `Tool error: ${message}. Retry once with corrected arguments for this tool.`,
          });
          continue;
        }

        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: userMessage
            ? `Tool error: ${message}. Tell the user, in Spanish, verbatim: "${userMessage}"`
            : `Tool error: ${message}. Tell the user you could not complete that action.`,
        });
      }
    }
  }
}
