import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.js";

const baseEnv = {
  TELEGRAM_BOT_TOKEN: "123456:test-token",
  TELEGRAM_ALLOWLIST: "111:romi,222:mateo",
  LLM_API_KEY: "sk-test",
};

describe("parseConfig", () => {
  it("parses a valid environment with defaults", () => {
    const config = parseConfig(baseEnv);

    expect(config.telegram.botToken).toBe("123456:test-token");
    expect(config.telegram.allowlist).toEqual({ "111": "romi", "222": "mateo" });

    expect(config.llm.baseUrl).toBe("https://api.nan.builders/v1");
    expect(config.llm.model).toBe("deepseek-v4-flash");
    expect(config.llm.fallbackModel).toBe("glm5.3-flash");
    expect(config.llm.timeoutMs).toBe(30_000);
    expect(config.llm.maxToolCalls).toBe(6);

    expect(config.turnos.backend).toBe("mock");
    expect(config.turnos.timeoutMs).toBe(10_000);
    expect(config.features).toEqual({ turnos: true, stock: false, tareas: false });
    expect(config.proposalTtlMs).toBe(10 * 60_000);
    expect(config.dailySummary).toEqual({ enabled: true, hour: 8 });
    expect(config.healthAlert).toEqual({
      enabled: false,
      intervalMs: 300_000,
      failureThreshold: 3,
      chatId: undefined,
    });
  });

  it("switching LLM_MODEL changes the configured model", () => {
    const config = parseConfig({ ...baseEnv, LLM_MODEL: "qwen3.8-flash" });
    expect(config.llm.model).toBe("qwen3.8-flash");
  });

  it("fails fast when TELEGRAM_BOT_TOKEN is missing", () => {
    expect(() => parseConfig({ ...baseEnv, TELEGRAM_BOT_TOKEN: undefined })).toThrow(ConfigError);
  });

  it("fails fast when LLM_API_KEY is empty", () => {
    expect(() => parseConfig({ ...baseEnv, LLM_API_KEY: "" })).toThrow(/LLM_API_KEY/);
  });

  it("fails fast on a malformed allowlist entry", () => {
    expect(() => parseConfig({ ...baseEnv, TELEGRAM_ALLOWLIST: "111" })).toThrow(
      /TELEGRAM_ALLOWLIST/,
    );
    expect(() => parseConfig({ ...baseEnv, TELEGRAM_ALLOWLIST: "abc:romi" })).toThrow(
      /TELEGRAM_ALLOWLIST/,
    );
  });

  it("fails fast on an unknown profile", () => {
    expect(() => parseConfig({ ...baseEnv, TELEGRAM_ALLOWLIST: "111:pepe" })).toThrow(
      /unknown profile/,
    );
  });

  it("fails fast when the http backend is selected without credentials", () => {
    expect(() => parseConfig({ ...baseEnv, TURNOS_BACKEND: "http" })).toThrow(
      /ASSISTANT_API_BASE_URL/,
    );
    expect(() =>
      parseConfig({
        ...baseEnv,
        TURNOS_BACKEND: "http",
        ASSISTANT_API_BASE_URL: "https://demo.convex.site",
      }),
    ).toThrow(/ASSISTANT_TOKEN/);
  });

  it("fails fast on a non-numeric numeric env var", () => {
    expect(() => parseConfig({ ...baseEnv, LLM_TIMEOUT_MS: "soon" })).toThrow(/LLM_TIMEOUT_MS/);
  });

  it("parses feature flags and numeric overrides", () => {
    const config = parseConfig({
      ...baseEnv,
      FEATURE_STOCK: "true",
      PROPOSAL_TTL_MINUTES: "3",
      LLM_MAX_TOOL_CALLS: "4",
      DAILY_SUMMARY_ENABLED: "false",
      DAILY_SUMMARY_HOUR: "9",
      HEALTH_ALERT_ENABLED: "true",
      HEALTH_ALERT_INTERVAL_SECONDS: "60",
      HEALTH_ALERT_FAILURES: "5",
      HEALTH_ALERT_CHAT_ID: "222",
    });

    expect(config.features.stock).toBe(true);
    expect(config.proposalTtlMs).toBe(3 * 60_000);
    expect(config.llm.maxToolCalls).toBe(4);
    expect(config.dailySummary).toEqual({ enabled: false, hour: 9 });
    expect(config.healthAlert).toEqual({
      enabled: true,
      intervalMs: 60_000,
      failureThreshold: 5,
      chatId: "222",
    });
  });

  it("rejects an impossible summary hour", () => {
    expect(() => parseConfig({ ...baseEnv, DAILY_SUMMARY_HOUR: "24" })).toThrow(
      /DAILY_SUMMARY_HOUR/,
    );
  });
});
