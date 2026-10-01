import { hashChatId, type AuditLogger } from "../audit/index.js";
import type { ChatAllowlist } from "../bot/allowlist.js";

export const DEFAULT_HEALTH_INTERVAL_MS = 300_000;
export const DEFAULT_FAILURE_THRESHOLD = 3;

export interface HealthMonitorDeps {
  /** Cheapest backend read; resolves when the backend is healthy. */
  readonly probe: () => Promise<void>;
  readonly notify: (chatId: string, text: string) => Promise<void>;
  readonly chatId: string;
  readonly audit: AuditLogger;
  readonly intervalMs?: number;
  readonly failureThreshold?: number;
}

export interface HealthMonitorState {
  readonly consecutiveFailures: number;
  readonly alerted: boolean;
}

export interface HealthMonitor {
  /** One probe cycle; exposed so tests do not need timers. */
  tick(): Promise<void>;
  /** Starts polling; returns the stop function. */
  start(): () => void;
  state(): HealthMonitorState;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Polls the backend and sends exactly one alert after `failureThreshold`
 * consecutive failures, then exactly one recovery message. A healthy probe below
 * the threshold stays silent, so a single hiccup never spams the chat.
 */
export function createHealthMonitor(deps: HealthMonitorDeps): HealthMonitor {
  const threshold = deps.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  let consecutiveFailures = 0;
  let alerted = false;

  const notify = async (text: string, detail: string): Promise<void> => {
    try {
      await deps.notify(deps.chatId, text);
      deps.audit.log({
        event: "health_alert",
        chatIdHash: hashChatId(deps.chatId),
        status: "ok",
        detail,
      });
    } catch (error) {
      deps.audit.log({
        event: "health_alert",
        chatIdHash: hashChatId(deps.chatId),
        status: "error",
        detail,
        error: messageOf(error),
      });
    }
  };

  const tick = async (): Promise<void> => {
    try {
      await deps.probe();
    } catch (error) {
      consecutiveFailures += 1;
      deps.audit.log({
        event: "health_alert",
        chatIdHash: hashChatId(deps.chatId),
        status: "error",
        detail: `probe_failed_${consecutiveFailures}`,
        error: messageOf(error),
      });

      if (!alerted && consecutiveFailures >= threshold) {
        alerted = true;
        await notify(
          `⚠️ El sistema de turnos no está respondiendo (${threshold} fallos seguidos). Aviso cuando vuelva.`,
          "alerted",
        );
      }
      return;
    }

    if (alerted) {
      alerted = false;
      consecutiveFailures = 0;
      await notify("✅ El sistema de turnos volvió a responder.", "recovered");
      return;
    }

    consecutiveFailures = 0;
  };

  const start = (): (() => void) => {
    const timer = setInterval(() => {
      void tick();
    }, deps.intervalMs ?? DEFAULT_HEALTH_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  };

  return { tick, start, state: () => ({ consecutiveFailures, alerted }) };
}

/** Alert target: the explicit id, else the first `mateo` chat, else none. */
export function resolveHealthAlertChat(
  allowlist: ChatAllowlist,
  explicitChatId?: string,
): string | undefined {
  if (explicitChatId) return explicitChatId;
  return Object.entries(allowlist).find(([, profile]) => profile === "mateo")?.[0];
}
