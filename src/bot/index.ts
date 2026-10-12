import { Bot, InlineKeyboard } from "grammy";
import { resolveProfile } from "./allowlist.js";
import { handleCallback, handleMessage, type BotDeps, type CallbackAction } from "./core.js";
import { keepTyping } from "./typing.js";

function isAllowlisted(deps: BotDeps, chatId: number): boolean {
  return resolveProfile(deps.config.telegram.allowlist, String(chatId)) !== undefined;
}

export const CONFIRM_PREFIX = "confirm:";
export const CANCEL_PREFIX = "cancel:";

export interface ParsedCallbackData {
  readonly action: CallbackAction;
  readonly proposalId: string;
}

/** `confirm:<id>` / `cancel:<id>` — the only callback payloads the bot emits. */
export function parseCallbackData(data: string): ParsedCallbackData | undefined {
  if (data.startsWith(CONFIRM_PREFIX)) {
    const proposalId = data.slice(CONFIRM_PREFIX.length);
    return proposalId.length > 0 ? { action: "confirm", proposalId } : undefined;
  }
  if (data.startsWith(CANCEL_PREFIX)) {
    const proposalId = data.slice(CANCEL_PREFIX.length);
    return proposalId.length > 0 ? { action: "cancel", proposalId } : undefined;
  }
  return undefined;
}

export function proposalKeyboard(proposalId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Confirmar", `${CONFIRM_PREFIX}${proposalId}`)
    .text("❌ Cancelar", `${CANCEL_PREFIX}${proposalId}`);
}

export function proposalMessage(summary: string, diff: string): string {
  return `${summary}\n\n${diff}`;
}

/**
 * Telegram adapter (long polling) around the tested core. The grammy layer only
 * translates transport concerns; allowlist, tool loop and confirmation live in
 * `core.ts`.
 */
export function createBot(token: string, deps: BotDeps): Bot {
  const bot = new Bot(token);

  bot.on("message:text", async (ctx) => {
    // Typing only for allow-listed chats: a stranger must not see any sign of life.
    const stopTyping = isAllowlisted(deps, ctx.chat.id)
      ? keepTyping(() => ctx.replyWithChatAction("typing"))
      : () => undefined;
    let reply;
    try {
      reply = await handleMessage(deps, { chatId: ctx.chat.id, text: ctx.message.text });
    } finally {
      stopTyping();
    }
    if (reply.kind === "ignored") return;

    await ctx.reply(reply.text);
    for (const proposal of reply.proposals) {
      await ctx.reply(proposalMessage(proposal.summary, proposal.diff), {
        reply_markup: proposalKeyboard(proposal.id),
      });
    }
  });

  bot.on("callback_query:data", async (ctx) => {
    const parsed = parseCallbackData(ctx.callbackQuery.data);
    const chatId = ctx.chat?.id;
    if (!parsed || chatId === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }

    const result = await handleCallback(deps, {
      chatId,
      action: parsed.action,
      proposalId: parsed.proposalId,
    });

    await ctx.answerCallbackQuery();
    if (result.kind === "ignored") return;

    const text = result.text ?? "";
    try {
      await ctx.editMessageText(text);
    } catch {
      // The message may be too old to edit; a new message is the correct fallback.
      await ctx.reply(text);
    }
  });

  return bot;
}
