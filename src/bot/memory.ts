import type { LlmMessage } from "../llm/types.js";
import { systemClock, type Clock } from "../time/index.js";

export interface ConversationMemoryOptions {
  readonly clock?: Clock;
  /** A chat that stays silent this long starts over (default 30 minutes). */
  readonly idleMinutes?: number;
  /** User/assistant exchanges kept per chat (default 6). */
  readonly maxExchanges?: number;
  /** Most recent exchanges whose read results are replayed (default 2). */
  readonly readExchanges?: number;
}

interface Exchange {
  readonly user?: string;
  readonly assistant: string;
  /** Read calls and their results; ids already namespaced per exchange. */
  readonly reads: readonly LlmMessage[];
}

interface ChatHistory {
  exchanges: Exchange[];
  lastActivity: number;
  sequence: number;
}

/**
 * Short per-chat memory so a reply like "Nude Glitter 118" is read as the answer
 * to the bot's last question. Every exchange keeps its visible text; the last
 * two also keep their successful reads (today's appointments, the compact
 * catalog), so the next message does not spend a model round trip re-reading
 * them. It lives in process memory and forgets a chat after the idle window.
 */
export class ConversationMemory {
  private readonly chats = new Map<string, ChatHistory>();
  private readonly clock: Clock;
  private readonly idleMs: number;
  private readonly maxExchanges: number;
  private readonly readExchanges: number;

  constructor(options: ConversationMemoryOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.idleMs = (options.idleMinutes ?? 30) * 60_000;
    this.maxExchanges = options.maxExchanges ?? 6;
    this.readExchanges = options.readExchanges ?? 2;
  }

  history(chatId: string): readonly LlmMessage[] {
    const chat = this.live(chatId);
    if (!chat) return [];
    const firstWithReads = chat.exchanges.length - this.readExchanges;
    return chat.exchanges.flatMap((exchange, index) => [
      ...(exchange.user === undefined ? [] : [{ role: "user" as const, content: exchange.user }]),
      ...(index >= firstWithReads ? exchange.reads : []),
      { role: "assistant" as const, content: exchange.assistant },
    ]);
  }

  record(
    chatId: string,
    userText: string,
    assistantText: string,
    reads: readonly LlmMessage[] = [],
  ): void {
    const chat = this.live(chatId) ?? { exchanges: [], lastActivity: 0, sequence: 0 };
    chat.sequence += 1;
    chat.exchanges.push({
      user: userText,
      assistant: assistantText,
      reads: namespaceIds(reads, `m${chat.sequence}_`),
    });
    chat.exchanges = chat.exchanges.slice(-this.maxExchanges);
    chat.lastActivity = this.now();
    this.chats.set(chatId, chat);
  }

  /** Starts the chat over from a question the bot asked outside the model (a button reply). */
  replaceWithAssistant(chatId: string, assistantText: string): void {
    this.chats.set(chatId, {
      exchanges: [{ assistant: assistantText, reads: [] }],
      lastActivity: this.now(),
      sequence: 0,
    });
  }

  clear(chatId: string): void {
    this.chats.delete(chatId);
  }

  private live(chatId: string): ChatHistory | undefined {
    const chat = this.chats.get(chatId);
    if (!chat) return undefined;
    if (this.now() - chat.lastActivity > this.idleMs) {
      this.chats.delete(chatId);
      return undefined;
    }
    return chat;
  }

  private now(): number {
    return this.clock().getTime();
  }
}

/** Providers reuse ids like "call_1" across turns; replayed calls must stay unique. */
function namespaceIds(messages: readonly LlmMessage[], prefix: string): LlmMessage[] {
  return messages.map((message) => ({
    ...message,
    ...(message.toolCallId ? { toolCallId: `${prefix}${message.toolCallId}` } : {}),
    ...(message.toolCalls
      ? { toolCalls: message.toolCalls.map((call) => ({ ...call, id: `${prefix}${call.id}` })) }
      : {}),
  }));
}
