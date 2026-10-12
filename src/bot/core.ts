import type { StockBackend } from "../adapters/stock/client.js";
import type { TareasBackend } from "../adapters/tareas/client.js";
import type { TurnosBackend } from "../adapters/turnos/client.js";
import { AuditLogger, hashChatId } from "../audit/index.js";
import type { AppConfig, ProfileName } from "../config.js";
import {
  buildSystemPrompt,
  LlmError,
  runToolLoop,
  userMessageOf,
  type LlmTransport,
} from "../llm/index.js";
import {
  isWriteTool,
  type ToolDefinition,
  type ToolHandlerContext,
  type ToolRegistry,
} from "../mcp/registry.js";
import type { LlmMessage } from "../llm/types.js";
import type { Proposal, ProposalStore } from "../proposals/store.js";
import { withSpan } from "../telemetry/tracer.js";
import { systemClock, type Clock } from "../time/index.js";
import { resolveProfile, isToolAllowed } from "./allowlist.js";
import type { ConversationMemory } from "./memory.js";

export const MODEL_ERROR_REPLY = "No pude contactar al modelo. Intentá de nuevo en un momento.";
export const GENERIC_ERROR_REPLY = "Algo salió mal de mi lado. Intentá de nuevo en un momento.";
export const STALE_CALLBACK_REPLY = "Esa confirmación ya no es válida.";
export const CANCELLED_REPLY = "Listo, no toqué nada.";

export interface BotDeps {
  readonly config: AppConfig;
  readonly registry: ToolRegistry;
  readonly backend: TurnosBackend;
  /** mena-nails stock backend; only wired when `FEATURE_STOCK` is on. */
  readonly stock?: StockBackend;
  /** Calendar backend; only wired when `FEATURE_TAREAS` is on. */
  readonly tareas?: TareasBackend;
  readonly proposals: ProposalStore;
  readonly transport: LlmTransport;
  readonly audit: AuditLogger;
  readonly clock?: Clock;
  /** Per-chat conversation memory; without it every message starts from scratch. */
  readonly memory?: ConversationMemory;
}

export interface IncomingMessage {
  readonly chatId: number | string;
  readonly text: string;
}

export type BotReply =
  | { readonly kind: "ignored" }
  | { readonly kind: "reply"; readonly text: string; readonly proposals: readonly Proposal[] };

export type CallbackAction = "confirm" | "cancel";

export interface IncomingCallback {
  readonly chatId: number | string;
  readonly action: CallbackAction;
  readonly proposalId: string;
}

/** Hint the completion tool returns so the bot can ask for the missing stock data. */
export interface StockChainHint {
  readonly serviceKey: string;
  readonly requiresTips: boolean;
  readonly serviceName?: string;
  readonly sourceAppointmentId?: string;
}

/** User-facing follow-up: asks only for what the appointment does not carry. */
export function stockChainPrompt(chain: StockChainHint): string {
  const tips = chain.requiresTips
    ? " y la forma y los talles de los tips (10 en total, por ejemplo «almond: 4 del 3 y 6 del 5»)"
    : "";
  return `Para descontar el stock, pasame el color que usaste${tips}.`;
}

/**
 * Telegram gets the reply as plain text, so markdown markers would show up as
 * literal asterisks: drop headings, bold, underline and code marks.
 */
export function plainReply(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

export interface BotCallbackResult {
  readonly kind: "ignored" | "reply";
  readonly text?: string;
}

function toolContext(deps: BotDeps, profile: ProfileName, chatId: string): ToolHandlerContext {
  return {
    backend: deps.backend,
    ...(deps.stock ? { stock: deps.stock } : {}),
    ...(deps.tareas ? { tareas: deps.tareas } : {}),
    proposals: deps.proposals,
    clock: deps.clock ?? systemClock,
    profile,
    chatId,
  };
}

/** Reads nearly every message needs; running them up front saves a model round trip. */
const PRELOADED_READS: readonly {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}[] = [
  { tool: "turnos.del_dia", args: { fecha: "hoy" } },
  { tool: "stock.catalogo", args: {} },
];
const PRELOADED_TOOLS = new Set(PRELOADED_READS.map((read) => read.tool));

/**
 * Runs the preloaded reads the profile may call and shapes them as one
 * assistant tool-call message plus its results, exactly as if the model had
 * asked. A failed read is left out; the model can still call it.
 */
async function preloadReads(
  tools: readonly ToolDefinition[],
  context: ToolHandlerContext,
  audit: AuditLogger,
): Promise<LlmMessage[]> {
  const done: { id: string; tool: string; args: Record<string, unknown>; content: string }[] = [];
  for (const [index, read] of PRELOADED_READS.entries()) {
    const tool = tools.find((candidate) => candidate.name === read.tool);
    if (!tool || tool.kind !== "read") continue;
    const started = Date.now();
    const entry = {
      event: "tool_call" as const,
      profile: context.profile,
      chatIdHash: hashChatId(context.chatId),
      tool: read.tool,
      args: read.args,
      detail: "preload",
    };
    try {
      const result = await tool.execute(read.args, context);
      done.push({ id: `preload_${index + 1}`, ...read, content: result.content });
      audit.log({ ...entry, status: "ok", latencyMs: Date.now() - started });
    } catch (error) {
      // Same as a failed tool call: the model reads it again if it needs it.
      audit.log({
        ...entry,
        status: "error",
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (done.length === 0) return [];
  return [
    {
      role: "assistant",
      content: null,
      toolCalls: done.map((read) => ({
        id: read.id,
        name: read.tool,
        arguments: JSON.stringify(read.args),
      })),
    },
    ...done.map((read) => ({ role: "tool" as const, toolCallId: read.id, content: read.content })),
  ];
}

/** The turn's reads minus the preloaded ones, which every message gets fresh anyway. */
function withoutPreloaded(trace: readonly LlmMessage[]): LlmMessage[] {
  const dropped = new Set<string>();
  const kept: LlmMessage[] = [];
  for (const message of trace) {
    if (message.role === "assistant" && message.toolCalls) {
      const calls = message.toolCalls.filter((call) => {
        if (PRELOADED_TOOLS.has(call.name)) dropped.add(call.id);
        return !PRELOADED_TOOLS.has(call.name);
      });
      if (calls.length > 0) kept.push({ ...message, toolCalls: calls });
    } else if (!(message.toolCallId && dropped.has(message.toolCallId))) {
      kept.push(message);
    }
  }
  return kept;
}

/**
 * Handles one Telegram message: allowlist first (unknown chats produce no reply,
 * no LLM call and no tool call), then the bounded tool loop. Write tools only
 * come back as proposals; nothing is executed here.
 */
export interface HandleMessageOptions {
  /** Receives the reply so far, markdown already stripped, while the model writes it. */
  readonly onText?: (textSoFar: string) => void;
}

export async function handleMessage(
  deps: BotDeps,
  message: IncomingMessage,
  options: HandleMessageOptions = {},
): Promise<BotReply> {
  const chatId = String(message.chatId);
  const profile = resolveProfile(deps.config.telegram.allowlist, chatId);

  if (!profile) {
    // Audit the drop without message content or the raw chat id.
    deps.audit.log({
      event: "chat_dropped",
      chatIdHash: hashChatId(chatId),
      detail: "not_allowlisted",
    });
    return { kind: "ignored" };
  }

  const context = toolContext(deps, profile, chatId);
  const tools = deps.registry.forProfile(profile);
  const clock = deps.clock ?? systemClock;

  const started = Date.now();
  try {
    const preloaded = await preloadReads(tools, context, deps.audit);
    const result = await withSpan(
      "bot.turn",
      { profile, chat: hashChatId(chatId), tools: tools.length },
      () =>
        runToolLoop({
          transport: deps.transport,
          tools,
          context,
          config: {
            model: deps.config.llm.model,
            fallbackModel: deps.config.llm.fallbackModel,
            timeoutMs: deps.config.llm.timeoutMs,
            maxToolCalls: deps.config.llm.maxToolCalls,
          },
          audit: deps.audit,
          systemPrompt: buildSystemPrompt(clock, { stockEnabled: deps.config.features.stock }),
          history: [...(deps.memory?.history(chatId) ?? []), ...preloaded],
          ...(options.onText
            ? { onText: (text: string) => options.onText?.(plainReply(text)) }
            : {}),
          userMessage: message.text,
        }),
    );

    deps.audit.log({
      event: "llm_turn",
      profile,
      chatIdHash: hashChatId(chatId),
      status: "ok",
      model: result.model,
      tokens: result.usage,
      latencyMs: Date.now() - started,
      modelCalls: result.modelCalls,
      detail: result.stoppedReason,
    });

    const reply = plainReply(result.reply);
    // The model only sees its own text next time; note the proposal so it does
    // not propose the same action again while the buttons are still on screen.
    const pending = result.proposals.map(
      (proposal) => `\n(Propuesta ya mostrada, esperando su botón: ${proposal.summary})`,
    );
    deps.memory?.record(
      chatId,
      message.text,
      `${reply}${pending.join("")}`,
      withoutPreloaded(result.readTrace),
    );
    return { kind: "reply", text: reply, proposals: result.proposals };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.audit.log({
      event: "error",
      profile,
      chatIdHash: hashChatId(chatId),
      status: "error",
      error: detail,
    });
    return {
      kind: "reply",
      text: error instanceof LlmError ? MODEL_ERROR_REPLY : GENERIC_ERROR_REPLY,
      proposals: [],
    };
  }
}

/**
 * Handles a Confirm/Cancel button. Only a callback from the originating chat,
 * before expiry, on a still-pending proposal reaches the adapter — and only
 * through the write tool's `executeProposal`.
 */
export async function handleCallback(
  deps: BotDeps,
  callback: IncomingCallback,
): Promise<BotCallbackResult> {
  const chatId = String(callback.chatId);
  const profile = resolveProfile(deps.config.telegram.allowlist, chatId);

  if (!profile) {
    deps.audit.log({
      event: "chat_dropped",
      chatIdHash: hashChatId(chatId),
      detail: "not_allowlisted",
    });
    return { kind: "ignored" };
  }

  const consumed = deps.proposals.consume(callback.proposalId, chatId);
  if (!consumed.ok) {
    deps.audit.log({
      event: "proposal_cancelled",
      profile,
      chatIdHash: hashChatId(chatId),
      proposalId: callback.proposalId,
      status: "denied",
      detail: consumed.reason,
    });
    return { kind: "reply", text: STALE_CALLBACK_REPLY };
  }

  const proposal = consumed.proposal;

  if (callback.action === "cancel") {
    deps.audit.log({
      event: "proposal_cancelled",
      profile,
      chatIdHash: hashChatId(chatId),
      proposalId: proposal.id,
      tool: proposal.tool,
      status: "ok",
    });
    deps.memory?.clear(chatId);
    return { kind: "reply", text: CANCELLED_REPLY };
  }

  // Defense in depth: even a proposal that exists in the store must belong to
  // this profile and name a tool this profile may call.
  if (proposal.profile !== profile || !isToolAllowed(profile, proposal.tool)) {
    deps.audit.log({
      event: "error",
      profile,
      chatIdHash: hashChatId(chatId),
      proposalId: proposal.id,
      tool: proposal.tool,
      status: "error",
      error: "proposal is not allowed for this profile",
    });
    return { kind: "reply", text: GENERIC_ERROR_REPLY };
  }

  const tool = deps.registry.get(proposal.tool);
  if (!tool || !isWriteTool(tool)) {
    deps.audit.log({
      event: "error",
      profile,
      chatIdHash: hashChatId(chatId),
      proposalId: proposal.id,
      tool: proposal.tool,
      status: "error",
      error: "proposal does not map to a write tool",
    });
    return { kind: "reply", text: GENERIC_ERROR_REPLY };
  }

  try {
    const result = await tool.executeProposal(proposal.args, toolContext(deps, profile, chatId));
    const data = result.data as { refundRequired?: boolean; chain?: StockChainHint } | undefined;
    const extra = data?.refundRequired ? " Quedó un reintegro pendiente de revisar." : "";

    deps.audit.log({
      event: "proposal_confirmed",
      profile,
      chatIdHash: hashChatId(chatId),
      proposalId: proposal.id,
      tool: proposal.tool,
      status: "ok",
      ...(data?.chain ? { detail: `stock_chain:${data.chain.serviceKey}` } : {}),
    });

    // Confirming a completion opens the stock chain: ask for what is missing.
    const followUp =
      deps.config.features.stock && data?.chain ? `\n\n${stockChainPrompt(data.chain)}` : "";

    const text = `✅ ${proposal.summary}.${extra}${followUp}`;
    // The stock question is the next thing Romi answers; anything older is done.
    if (followUp) deps.memory?.replaceWithAssistant(chatId, text);
    else deps.memory?.clear(chatId);
    return { kind: "reply", text };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Adapter errors carry Spanish copy for the user; anything else stays generic.
    const userMessage = userMessageOf(error);
    deps.audit.log({
      event: "proposal_confirmed",
      profile,
      chatIdHash: hashChatId(chatId),
      proposalId: proposal.id,
      tool: proposal.tool,
      status: "error",
      error: detail,
    });
    return { kind: "reply", text: userMessage ?? `${GENERIC_ERROR_REPLY} (${detail})` };
  }
}
