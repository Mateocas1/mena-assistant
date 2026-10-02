import { hashChatId, type AuditLogger } from "../audit/index.js";

export interface StockAlertItem {
  readonly itemId: number;
  readonly label: string;
  readonly units: number | null;
}

export interface StockAlertMonitorDeps {
  /** Current low-stock items (`stock.alertas`). */
  readonly probe: () => Promise<readonly StockAlertItem[]>;
  readonly notify: (chatId: string, text: string) => Promise<void>;
  readonly chatId: string;
  readonly audit: AuditLogger;
  readonly intervalMs?: number;
}

export interface StockAlertMonitor {
  tick(): Promise<void>;
  start(): () => void;
  /** Low item ids seen in the last successful tick. */
  lowItemIds(): readonly number[];
}

export const DEFAULT_STOCK_ALERT_INTERVAL_MS = 1_800_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeItem(item: StockAlertItem): string {
  const units = item.units === null ? "sin unidades confirmadas" : `${item.units} unidades`;
  return `- ${item.label} · ${units}`;
}

/**
 * Alerts once per newly-low item: the first tick reports what is already low,
 * later ticks report only items that crossed the threshold since the last check
 * (and an item that recovers is dropped, so a relapse alerts again).
 */
export function createStockAlertMonitor(deps: StockAlertMonitorDeps): StockAlertMonitor {
  let knownLow = new Set<number>();

  const tick = async (): Promise<void> => {
    let items: readonly StockAlertItem[];
    try {
      items = await deps.probe();
    } catch (error) {
      deps.audit.log({
        event: "stock_alert",
        chatIdHash: hashChatId(deps.chatId),
        status: "error",
        detail: "probe_failed",
        error: messageOf(error),
      });
      return;
    }

    const current = new Map(items.map((item) => [item.itemId, item]));
    const fresh = [...current.values()].filter((item) => !knownLow.has(item.itemId));
    knownLow = new Set(current.keys());

    if (fresh.length === 0) return;

    const text = [
      `⚠️ Insumo${fresh.length === 1 ? "" : "s"} por debajo del umbral:`,
      ...fresh.map(describeItem),
      "",
      "Revisá el recuento en el panel de mena-nails.",
    ].join("\n");

    try {
      await deps.notify(deps.chatId, text);
      deps.audit.log({
        event: "stock_alert",
        chatIdHash: hashChatId(deps.chatId),
        status: "ok",
        detail: `new_low:${fresh.map((item) => item.itemId).join(",")}`,
      });
    } catch (error) {
      deps.audit.log({
        event: "stock_alert",
        chatIdHash: hashChatId(deps.chatId),
        status: "error",
        detail: "notify_failed",
        error: messageOf(error),
      });
    }
  };

  const start = (): (() => void) => {
    const timer = setInterval(() => {
      void tick();
    }, deps.intervalMs ?? DEFAULT_STOCK_ALERT_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  };

  return { tick, start, lowItemIds: () => [...knownLow] };
}
