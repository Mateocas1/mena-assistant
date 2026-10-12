import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotError, Context } from "grammy";
import { createBot, redactSecrets, sendWithRetry } from "../src/bot/index.js";
import { createBotDeps } from "../src/index.js";
import { parseConfig } from "../src/config.js";
import { ScriptedTransport } from "./helpers/llm.js";

const TOKEN = "1234567890:AAFakeTokenForTestsOnly_abcdefghijkl";

describe("redactSecrets", () => {
  it("hides a Telegram bot token inside an API url", () => {
    const text = `request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`;

    expect(redactSecrets(text)).toBe(
      "request to https://api.telegram.org/bot<redacted>/sendMessage failed",
    );
  });
});

describe("Telegram error handling", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the bot alive after a failed reply and never logs the token", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    const config = parseConfig({
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_ALLOWLIST: "111:romi",
      LLM_API_KEY: "sk-test",
    });
    const bot = createBot(TOKEN, createBotDeps(config, { transport: new ScriptedTransport([]) }));
    const failure = {
      error: new Error(
        `request to https://api.telegram.org/bot${TOKEN}/sendMessage failed, ETIMEDOUT`,
      ),
      ctx: { update: { update_id: 211273833 } },
    } as unknown as BotError<Context>;

    await expect(Promise.resolve(bot.errorHandler(failure))).resolves.toBeUndefined();

    expect(lines.join("\n")).toContain("update 211273833");
    expect(lines.join("\n")).toContain("ETIMEDOUT");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });
});

describe("sendWithRetry", () => {
  it("retries a failed send once", async () => {
    let attempts = 0;
    const result = await sendWithRetry(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("ETIMEDOUT");
      return "sent";
    }, 0);

    expect(result).toBe("sent");
    expect(attempts).toBe(2);
  });

  it("gives up after the retry fails too", async () => {
    let attempts = 0;
    await expect(
      sendWithRetry(async () => {
        attempts += 1;
        throw new Error("ETIMEDOUT");
      }, 0),
    ).rejects.toThrow("ETIMEDOUT");
    expect(attempts).toBe(2);
  });
});
