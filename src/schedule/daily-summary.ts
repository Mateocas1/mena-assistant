import { hashChatId, type AuditLogger } from "../audit/index.js";
import type { StockBackend, StockEntry } from "../adapters/stock/client.js";
import type { Appointment, PendingPayments } from "../adapters/turnos/client.js";
import type { TurnosBackend } from "../adapters/turnos/client.js";
import type { ChatAllowlist } from "../bot/allowlist.js";
import type { ProfileName } from "../config.js";
import { artToday, systemClock, type Clock } from "../time/index.js";

/** ART has no DST, so the offset is a constant. */
const ART_OFFSET = "-03:00";
const MS_PER_DAY = 86_400_000;

export const DEFAULT_SUMMARY_HOUR = 8;

export interface DailySummaryData {
  readonly date: string;
  readonly appointments: readonly Appointment[];
  readonly counts: Readonly<Record<string, number>>;
  readonly revenue: number;
  readonly pending: PendingPayments;
  /** Present only when `FEATURE_STOCK` is on and the stock read succeeded. */
  readonly stockAlerts?: readonly StockEntry[];
}

export interface DailySummaryDeps {
  readonly backend: TurnosBackend;
  readonly allowlist: ChatAllowlist;
  readonly audit: AuditLogger;
  readonly send: (chatId: string, text: string) => Promise<void>;
  readonly clock?: Clock;
  readonly features: { readonly tareas: boolean; readonly stock?: boolean };
  readonly stock?: StockBackend;
  readonly hour?: number;
}

/** Next occurrence of `hour:00` in ART, as an instant. */
export function nextDailyRun(clock: Clock, hour: number = DEFAULT_SUMMARY_HOUR): Date {
  const candidate = Date.parse(
    `${artToday(clock)}T${String(hour).padStart(2, "0")}:00:00${ART_OFFSET}`,
  );
  const now = clock().getTime();
  return new Date(candidate > now ? candidate : candidate + MS_PER_DAY);
}

export function msUntilNextRun(clock: Clock, hour: number = DEFAULT_SUMMARY_HOUR): number {
  return Math.max(0, nextDailyRun(clock, hour).getTime() - clock().getTime());
}

function describeCounts(counts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return "sin turnos";
  return entries.map(([status, count]) => `${count} ${status}`).join(", ");
}

function describeAppointment(appointment: Appointment): string {
  const who = appointment.clientName ?? "sin nombre";
  return `- ${appointment.timeSlot} · ${appointment.serviceName} · ${who} (${appointment.status})`;
}

/**
 * Spanish text for one chat, built from data only — never by the LLM.
 * `mateo` also gets the tareas placeholder while the flag is off.
 */
export function buildDailySummary(
  profile: ProfileName,
  data: DailySummaryData,
  options: { readonly tareasEnabled: boolean },
): string {
  const lines: string[] = [];
  lines.push(`☀️ Buenos días — resumen del ${data.date}`);
  lines.push("");
  lines.push(
    `Turnos: ${data.appointments.length} (${describeCounts(data.counts)}) · Seña facturada: $${data.revenue}`,
  );

  if (data.appointments.length > 0) {
    lines.push(...data.appointments.map(describeAppointment));
  }

  lines.push("");
  lines.push(`Pagos por revisar: ${data.pending.verificaciones.length}`);
  for (const verification of data.pending.verificaciones) {
    const who = verification.clientName ?? "sin nombre";
    const amount = verification.amount === null ? "monto desconocido" : `$${verification.amount}`;
    const when = verification.date
      ? `${verification.date}${verification.timeSlot ? ` ${verification.timeSlot}` : ""} · `
      : "";
    lines.push(`- ${when}${who} · ${amount} (${verification.status})`);
  }
  lines.push(
    `Reintegros pendientes: ${data.pending.reintegros.count} · $${data.pending.reintegros.totalAmount}`,
  );

  if (data.stockAlerts !== undefined) {
    lines.push("");
    lines.push(`Insumos con alerta: ${data.stockAlerts.length}`);
    for (const item of data.stockAlerts) {
      const units = item.units === null ? "sin unidades confirmadas" : `${item.units} unidades`;
      lines.push(`- ${item.label} · ${units}`);
    }
  }

  if (profile === "mateo" && !options.tareasEnabled) {
    lines.push("");
    lines.push("Tareas: todavía no están conectadas (M5).");
  }

  return lines.join("\n");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sends the daily summary to every allow-listed chat. When the backend is down
 * it skips silently (audited) instead of sending a broken message.
 */
export async function runDailySummary(deps: DailySummaryDeps): Promise<void> {
  const clock = deps.clock ?? systemClock;
  const date = artToday(clock);

  let appointments: Appointment[];
  let summary: { counts: Readonly<Record<string, number>>; revenue: number };
  let pending: PendingPayments;

  try {
    [appointments, summary, pending] = await Promise.all([
      deps.backend.delDia(date),
      deps.backend.resumen(date),
      deps.backend.pagosPendientes(),
    ]);
  } catch (error) {
    deps.audit.log({
      event: "daily_summary",
      status: "error",
      detail: "backend_unavailable",
      error: messageOf(error),
    });
    return;
  }

  // The stock section is best effort: a stock outage must not silence the day.
  let stockAlerts: StockEntry[] | undefined;
  if (deps.features.stock && deps.stock) {
    try {
      stockAlerts = await deps.stock.alertas();
    } catch (error) {
      deps.audit.log({
        event: "daily_summary",
        status: "error",
        detail: "stock_unavailable",
        error: messageOf(error),
      });
    }
  }

  const data: DailySummaryData = {
    date,
    appointments,
    counts: summary.counts,
    revenue: summary.revenue,
    pending,
    ...(stockAlerts === undefined ? {} : { stockAlerts }),
  };

  for (const [chatId, profile] of Object.entries(deps.allowlist)) {
    const text = buildDailySummary(profile, data, { tareasEnabled: deps.features.tareas });
    try {
      await deps.send(chatId, text);
      deps.audit.log({
        event: "daily_summary",
        profile,
        chatIdHash: hashChatId(chatId),
        status: "ok",
        detail: "sent",
      });
    } catch (error) {
      deps.audit.log({
        event: "daily_summary",
        profile,
        chatIdHash: hashChatId(chatId),
        status: "error",
        error: messageOf(error),
      });
    }
  }
}

/**
 * In-process scheduler (no external cron). Returns a stop function; the timer
 * does not hold the process open.
 */
export function startDailySummary(deps: DailySummaryDeps): () => void {
  const clock = deps.clock ?? systemClock;
  const hour = deps.hour ?? DEFAULT_SUMMARY_HOUR;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (): void => {
    timer = setTimeout(
      () => {
        void runDailySummary(deps).finally(schedule);
      },
      msUntilNextRun(clock, hour),
    );
    timer.unref?.();
  };

  schedule();
  return () => {
    if (timer) clearTimeout(timer);
  };
}
