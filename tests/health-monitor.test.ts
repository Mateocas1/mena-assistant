import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLogger } from "../src/audit/index.js";
import type { ChatAllowlist } from "../src/bot/allowlist.js";
import {
  createHealthMonitor,
  resolveHealthAlertChat,
  type HealthMonitorDeps,
} from "../src/schedule/health-monitor.js";
import { fixedClock } from "../src/time/index.js";

interface SetupOptions {
  readonly fail?: boolean;
  readonly intervalMs?: number;
  readonly failureThreshold?: number;
}

function setup(options: SetupOptions = {}) {
  const messages: string[] = [];
  const lines: string[] = [];
  let failing = options.fail ?? true;

  const deps: HealthMonitorDeps = {
    probe: async () => {
      if (failing) throw new Error("backend down");
    },
    notify: async (_chatId, text) => {
      messages.push(text);
    },
    chatId: "222",
    audit: new AuditLogger({
      sink: (line) => lines.push(line),
      clock: fixedClock("2026-01-15T01:30:00Z"),
    }),
    intervalMs: options.intervalMs ?? 1_000,
    failureThreshold: options.failureThreshold ?? 3,
  };

  return {
    monitor: createHealthMonitor(deps),
    messages,
    lines,
    setFailing: (value: boolean) => {
      failing = value;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createHealthMonitor", () => {
  it("alerts once after three consecutive failures and then stays quiet", async () => {
    const { monitor, messages } = setup();

    await monitor.tick();
    await monitor.tick();
    expect(messages).toEqual([]);

    await monitor.tick();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("no está respondiendo");

    await monitor.tick();
    await monitor.tick();
    expect(messages).toHaveLength(1);
    expect(monitor.state()).toEqual({ consecutiveFailures: 5, alerted: true });
  });

  it("stays silent when a failure is followed by a healthy probe", async () => {
    const { monitor, messages, setFailing } = setup();

    await monitor.tick();
    await monitor.tick();
    setFailing(false);
    await monitor.tick();

    expect(messages).toEqual([]);
    expect(monitor.state()).toEqual({ consecutiveFailures: 0, alerted: false });
  });

  it("sends exactly one recovery message and resets the debounce", async () => {
    const { monitor, messages, setFailing } = setup();

    for (let index = 0; index < 3; index += 1) await monitor.tick();
    expect(messages).toHaveLength(1);

    setFailing(false);
    await monitor.tick();
    await monitor.tick();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain("volvió a responder");

    // A new outage alerts again (the debounce was reset).
    setFailing(true);
    for (let index = 0; index < 3; index += 1) await monitor.tick();
    expect(messages).toHaveLength(3);
    expect(monitor.state().alerted).toBe(true);
  });

  it("honours a custom threshold", async () => {
    const { monitor, messages } = setup({ failureThreshold: 2 });
    await monitor.tick();
    expect(messages).toEqual([]);
    await monitor.tick();
    expect(messages).toHaveLength(1);
  });

  it("audits every probe and the alert itself", async () => {
    const { monitor, lines } = setup();
    for (let index = 0; index < 3; index += 1) await monitor.tick();

    const entries = lines.map((line) => JSON.parse(line) as { event: string; detail?: string });
    expect(entries.filter((entry) => entry.event === "health_alert")).toHaveLength(4);
    expect(entries.some((entry) => entry.detail === "alerted")).toBe(true);
  });

  it("does not throw when the alert message cannot be delivered", async () => {
    const lines: string[] = [];
    const monitor = createHealthMonitor({
      probe: async () => {
        throw new Error("down");
      },
      notify: async () => {
        throw new Error("telegram down");
      },
      chatId: "222",
      audit: new AuditLogger({ sink: (line) => lines.push(line) }),
      failureThreshold: 1,
    });

    await expect(monitor.tick()).resolves.toBeUndefined();
    expect(lines.join("\n")).toContain("telegram down");
  });

  it("polls on the interval when started", async () => {
    vi.useFakeTimers();
    const { monitor, messages } = setup({ failureThreshold: 2 });
    const stop = monitor.start();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(messages).toHaveLength(1);

    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(messages).toHaveLength(1);
  });
});

describe("resolveHealthAlertChat", () => {
  const allowlist: ChatAllowlist = { "111": "romi", "222": "mateo" };

  it("prefers the explicit chat id", () => {
    expect(resolveHealthAlertChat(allowlist, "999")).toBe("999");
  });

  it("falls back to the first mateo chat", () => {
    expect(resolveHealthAlertChat(allowlist)).toBe("222");
    expect(resolveHealthAlertChat({ "111": "romi" })).toBeUndefined();
  });
});
