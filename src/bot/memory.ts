import type { LlmMessage } from "../llm/types.js";
import { systemClock, type Clock } from "../time/index.js";

export interface ConversationMemoryOptions {
  readonly clock?: Clock;
  /** A chat that stays silent this long starts over (default 30 minutes). */
  readonly idleMinutes?: number;
  /** User/assistant exchanges kept per chat (default 6). */
  readonly maxExchanges?: number;
}

interface ChatHistory {
  messages: LlmMessage[];
  lastActivity: number;
}

/**
 * Short per-chat memory so a reply like "Nude Glitter 118" is read as the answer
 * to the bot's last question. It keeps only the visible text of each exchange
 * (no tool results, so no catalog or client data), lives in process memory and
 * forgets a chat after the idle window.
 */
export class ConversationMemory {
  private readonly chats = new Map<string, ChatHistory>();
  private readonly clock: Clock;
  private readonly idleMs: number;
  private readonly maxMessages: number;

  constructor(options: ConversationMemoryOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.idleMs = (options.idleMinutes ?? 30) * 60_000;
    this.maxMessages = (options.maxExchanges ?? 6) * 2;
  }

  history(chatId: string): readonly LlmMessage[] {
    const chat = this.live(chatId);
    return chat ? [...chat.messages] : [];
  }

  record(chatId: string, userText: string, assistantText: string): void {
    const chat = this.live(chatId) ?? { messages: [], lastActivity: 0 };
    chat.messages.push({ role: "user", content: userText });
    chat.messages.push({ role: "assistant", content: assistantText });
    chat.messages = chat.messages.slice(-this.maxMessages);
    chat.lastActivity = this.now();
    this.chats.set(chatId, chat);
  }

  /** Starts the chat over from a question the bot asked outside the model (a button reply). */
  replaceWithAssistant(chatId: string, assistantText: string): void {
    this.chats.set(chatId, {
      messages: [{ role: "assistant", content: assistantText }],
      lastActivity: this.now(),
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
