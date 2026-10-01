import { afterEach, describe, expect, it, vi } from "vitest";
import { MockTurnosBackend } from "../src/adapters/turnos/mock.js";
import { createTurnosFixtures } from "../src/adapters/turnos/fixtures.js";
import { AuditLogger } from "../src/audit/index.js";
import type { ChatAllowlist } from "../src/bot/allowlist.js";
import {
  buildDailySummary,
  nextDailyRun,
  runDailySummary,
  startDailySummary,
  type DailySummaryDeps,
} from "../src/schedule/daily-summary.js";
import { artToday, fixedClock, type Clock } from "../src/time/index.js";

const ALLOWLIST: ChatAllowlist = { "111": "romi", "222": "mateo" };
const ART_TODAY = "2026-01-14";

function makeDeps(clock: Clock, overrides: Partial<DailySummaryDeps> = {}) {
  const sends: Array<{ chatId: string; text: string }> = [];
  const lines: string[] = [];
  return {
    sends,
    lines,
    deps: {
      backend: new MockTurnosBackend(createTurnosFixtures(artToday(clock)), { clock }),
      allowlist: ALLOWLIST,
      audit: new AuditLogger({ sink: (line) => lines.push(line), clock }),
      send: async (chatId: string, text: string) => {
        sends.push({ chatId, text });
      },
      clock,
      features: { tareas: false },
      ...overrides,
    } satisfies DailySummaryDeps,
  };
}

describe("nextDailyRun", () => {
  it("returns the same day's 08:00 when it is still ahead", () => {
    const clock = fixedClock("2026-01-14T10:59:00Z"); // 07:59 ART
    expect(nextDailyRun(clock).toISOString()).toBe("2026-01-14T11:00:00.000Z");
  });

  it("rolls to the next day once 08:00 has passed", () => {
    const clock = fixedClock("2026-01-14T11:01:00Z"); // 08:01 ART
    expect(nextDailyRun(clock).toISOString()).toBe("2026-01-15T11:00:00.000Z");
  });

  it("crosses the day boundary correctly at 23:30 ART", () => {
    const clock = fixedClock("2026-01-15T02:30:00Z"); // 2026-01-14 23:30 ART
    expect(artToday(clock)).toBe(ART_TODAY);
    expect(nextDailyRun(clock).toISOString()).toBe("2026-01-15T11:00:00.000Z");
  });
});

describe("buildDailySummary", () => {
  const data = {
    date: ART_TODAY,
    appointments: [
      {
        id: "apt_today_0800",
        date: ART_TODAY,
        timeSlot: "08:00",
        status: "confirmed" as const,
        serviceName: "Servicio Soft Gel",
        clientName: "Ana G.",
      },
    ],
    counts: { confirmed: 1 },
    revenue: 12500,
    pending: {
      verificaciones: [
        {
          id: "ver_today_pending",
          status: "pending",
          reason: "amount_mismatch",
          amount: 12500,
          date: ART_TODAY,
          timeSlot: "08:00",
          clientName: "Ana G.",
        },
      ],
      reintegros: { count: 1, totalAmount: 5000, byReason: { admin_cancellation: 1 } },
    },
  };

  it("lists the day, the payments and the refunds for Romi", () => {
    const text = buildDailySummary("romi", data, { tareasEnabled: false });
    expect(text).toContain(`resumen del ${ART_TODAY}`);
    expect(text).toContain("Turnos: 1 (1 confirmed) · Seña facturada: $12500");
    expect(text).toContain("- 08:00 · Servicio Soft Gel · Ana G. (confirmed)");
    expect(text).toContain("Pagos por revisar: 1");
    expect(text).toContain("Reintegros pendientes: 1 · $5000");
    expect(text).not.toContain("Tareas");
  });

  it("adds the tareas placeholder for Mateo while the flag is off", () => {
    expect(buildDailySummary("mateo", data, { tareasEnabled: false })).toContain(
      "Tareas: todavía no están conectadas (M5).",
    );
    expect(buildDailySummary("mateo", data, { tareasEnabled: true })).not.toContain("Tareas");
  });
});

describe("runDailySummary", () => {
  it("sends one message per allow-listed chat", async () => {
    const { deps, sends, lines } = makeDeps(fixedClock("2026-01-15T01:30:00Z"));
    await runDailySummary(deps);

    expect(sends.map((entry) => entry.chatId)).toEqual(["111", "222"]);
    expect(sends[0]?.text).toContain("resumen del 2026-01-14");
    expect(sends[1]?.text).toContain("Tareas");
    expect(
      lines
        .map((line) => JSON.parse(line) as { event: string; detail?: string })
        .filter((e) => e.event === "daily_summary"),
    ).toHaveLength(2);
  });

  it("skips silently and audits when the backend is down", async () => {
    const { deps, sends, lines } = makeDeps(fixedClock("2026-01-15T01:30:00Z"));
    deps.backend.delDia = async () => {
      throw new Error("network down");
    };

    await runDailySummary(deps);

    expect(sends).toEqual([]);
    const entries = lines.map((line) => JSON.parse(line) as { event: string; detail?: string });
    expect(entries).toContainEqual(
      expect.objectContaining({ event: "daily_summary", detail: "backend_unavailable" }),
    );
  });

  it("audits a failed send without stopping the others", async () => {
    const { deps, lines } = makeDeps(fixedClock("2026-01-15T01:30:00Z"), {
      send: async (chatId: string) => {
        if (chatId === "111") throw new Error("telegram down");
      },
    });

    await runDailySummary(deps);

    const entries = lines.map((line) => JSON.parse(line) as { event: string; status?: string });
    expect(entries.filter((entry) => entry.event === "daily_summary")).toHaveLength(2);
    expect(entries.some((entry) => entry.status === "error")).toBe(true);
    expect(entries.some((entry) => entry.status === "ok")).toBe(true);
  });
});

describe("startDailySummary", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires at 08:00 ART when started at 07:59", async () => {
    vi.useFakeTimers();
    let current = new Date("2026-01-14T10:59:00Z"); // 07:59 ART
    const { deps, sends } = makeDeps(() => current);
    const stop = startDailySummary(deps);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(sends).toEqual([]);

    current = new Date(current.getTime() + 30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(sends.map((entry) => entry.chatId)).toEqual(["111", "222"]);
    stop();
  });

  it("waits a full day when started at 08:01", async () => {
    vi.useFakeTimers();
    let current = new Date("2026-01-14T11:01:00Z"); // 08:01 ART
    const { deps, sends } = makeDeps(() => current);
    const stop = startDailySummary(deps);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sends).toEqual([]);

    const rest = nextDailyRun(() => current).getTime() - current.getTime();
    current = new Date(current.getTime() + rest);
    await vi.advanceTimersByTimeAsync(rest);

    expect(sends).toHaveLength(2);
    stop();
  });

  it("schedules across the day boundary from 23:30 ART", async () => {
    vi.useFakeTimers();
    let current = new Date("2026-01-15T02:30:00Z"); // 2026-01-14 23:30 ART
    const { deps, sends } = makeDeps(() => current);
    const stop = startDailySummary(deps);

    const delay = nextDailyRun(() => current).getTime() - current.getTime();
    expect(delay).toBe(8.5 * 60 * 60 * 1000);

    current = new Date(current.getTime() + delay);
    await vi.advanceTimersByTimeAsync(delay);

    expect(sends).toHaveLength(2);
    // 08:00 the next morning: the summary is for the new ART day.
    expect(sends[0]?.text).toContain("resumen del 2026-01-15");
    stop();
  });
});
