import { describe, expect, it } from "vitest";
import { createTurnosBackend } from "../src/adapters/index.js";
import { HttpTurnosClient } from "../src/adapters/turnos/http.js";
import { MockTurnosBackend } from "../src/adapters/turnos/mock.js";
import { parseConfig } from "../src/config.js";
import { fixedClock } from "../src/time/index.js";

const CLOCK = fixedClock("2026-01-15T01:30:00Z"); // 2026-01-14 22:30 ART
const ART_TODAY = "2026-01-14";

const baseEnv = {
  TELEGRAM_BOT_TOKEN: "t",
  TELEGRAM_ALLOWLIST: "111:romi",
  LLM_API_KEY: "sk",
};

describe("createTurnosBackend", () => {
  it("returns the mock backend by default, anchored on the clock's ART day", async () => {
    const config = parseConfig(baseEnv); // TURNOS_BACKEND defaults to mock
    const backend = createTurnosBackend(config, { clock: CLOCK });

    expect(backend).toBeInstanceOf(MockTurnosBackend);
    const today = await backend.delDia(ART_TODAY);
    expect(today.map((appointment) => appointment.id)).toContain("apt_today_0800");
    expect(await backend.rango(ART_TODAY, "2026-01-15")).toHaveLength(5);
  });

  it("returns the http backend when TURNOS_BACKEND=http", async () => {
    const config = parseConfig({
      ...baseEnv,
      TURNOS_BACKEND: "http",
      ASSISTANT_API_BASE_URL: "https://demo.convex.site",
      ASSISTANT_TOKEN: "service-token",
    });

    const calls: string[] = [];
    const backend = createTurnosBackend(config, {
      clock: CLOCK,
      retryDelayMs: 1,
      fetchImpl: async (url) => {
        calls.push(url);
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    expect(backend).toBeInstanceOf(HttpTurnosClient);
    await backend.servicios();
    expect(calls).toEqual(["https://demo.convex.site/assistant/services"]);
  });

  it("refuses to build the http backend without credentials", () => {
    const config = parseConfig(baseEnv);
    const tampered = {
      ...config,
      turnos: { ...config.turnos, backend: "http" as const },
    };
    expect(() => createTurnosBackend(tampered)).toThrow(/ASSISTANT_API_BASE_URL/);
  });
});
