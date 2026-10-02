import { describe, expect, it, vi } from "vitest";
import { AuditLogger } from "../src/audit/index.js";
import {
  createStockAlertMonitor,
  type StockAlertItem,
  type StockAlertMonitorDeps,
} from "../src/schedule/stock-alerts.js";

function setup(initial: StockAlertItem[]) {
  const messages: string[] = [];
  const lines: string[] = [];
  let items = initial;

  const deps: StockAlertMonitorDeps = {
    probe: async () => items,
    notify: async (_chatId, text) => {
      messages.push(text);
    },
    chatId: "111",
    audit: new AuditLogger({ sink: (line) => lines.push(line) }),
    intervalMs: 1_000,
  };

  return {
    monitor: createStockAlertMonitor(deps),
    messages,
    lines,
    setItems: (next: StockAlertItem[]) => {
      items = next;
    },
  };
}

const TIPS: StockAlertItem = { itemId: 11, label: "Tips almond 6", units: 15 };
const COLOUR: StockAlertItem = { itemId: 2, label: "Nude Glitter 118", units: 1 };

describe("createStockAlertMonitor", () => {
  it("reports the current low items once and then stays quiet", async () => {
    const { monitor, messages } = setup([TIPS, COLOUR]);

    await monitor.tick();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Tips almond 6");
    expect(messages[0]).toContain("Nude Glitter 118");

    await monitor.tick();
    await monitor.tick();
    expect(messages).toHaveLength(1);
    expect([...monitor.lowItemIds()].sort((a, b) => a - b)).toEqual([2, 11]);
  });

  it("reports only the newly low item", async () => {
    const { monitor, messages, setItems } = setup([TIPS]);
    await monitor.tick();
    expect(messages).toHaveLength(1);

    setItems([TIPS, COLOUR]);
    await monitor.tick();

    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain("Nude Glitter 118");
    expect(messages[1]).not.toContain("Tips almond 6");
  });

  it("stays silent while nothing changes and alerts again after a relapse", async () => {
    const { monitor, messages, setItems } = setup([TIPS]);

    await monitor.tick();
    expect(messages).toHaveLength(1);

    // Recovered: no message, and the item leaves the known set.
    setItems([]);
    await monitor.tick();
    expect(messages).toHaveLength(1);
    expect(monitor.lowItemIds()).toEqual([]);

    // Relapse: a new alert.
    setItems([TIPS]);
    await monitor.tick();
    expect(messages).toHaveLength(2);
  });

  it("does not throw or alert when the probe fails, and audits it", async () => {
    const messages: string[] = [];
    const lines: string[] = [];
    const monitor = createStockAlertMonitor({
      probe: async () => {
        throw new Error("stock down");
      },
      notify: async (_chatId, text) => {
        messages.push(text);
      },
      chatId: "111",
      audit: new AuditLogger({ sink: (line) => lines.push(line) }),
    });

    await expect(monitor.tick()).resolves.toBeUndefined();
    expect(messages).toEqual([]);
    expect(lines.join("\n")).toContain("stock down");
  });

  it("audits a failed notification without throwing", async () => {
    const lines: string[] = [];
    const monitor = createStockAlertMonitor({
      probe: async () => [TIPS],
      notify: async () => {
        throw new Error("telegram down");
      },
      chatId: "111",
      audit: new AuditLogger({ sink: (line) => lines.push(line) }),
    });

    await expect(monitor.tick()).resolves.toBeUndefined();
    expect(lines.join("\n")).toContain("telegram down");
  });

  it("polls on the interval when started", async () => {
    vi.useFakeTimers();
    try {
      const { monitor, messages } = setup([TIPS]);
      const stop = monitor.start();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(messages).toHaveLength(1);

      stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(messages).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
