import { z } from "zod";
import type { Appointment } from "../../adapters/turnos/client.js";
import {
  addDays,
  artToday,
  artTomorrow,
  artWeekRange,
  artYesterday,
  InvalidDateError,
  InvalidRangeError,
  resolveArtDate,
  resolveArtRange,
  type Clock,
} from "../../time/index.js";
import { ToolArgumentError, type ToolHandlerContext } from "../registry.js";

export const FECHA_DESCRIPTION =
  "Fecha en America/Argentina/Buenos_Aires: YYYY-MM-DD, 'hoy', 'mañana', 'ayer' o un día de la semana ('el jueves').";

export const SLOT_PATTERN = /^\d{2}:\d{2}$/;
export const SLOT_DESCRIPTION =
  "Horario en formato HH:MM (por ejemplo 16:30), uno de los horarios del salón.";

/** Window the backend enforces for bookings (test-kimi `MAX_ADVANCE_DAYS`). */
export const MAX_ADVANCE_DAYS = 30;

/**
 * Fresh ART anchors appended to the date tools' descriptions. The model never
 * does date math: it copies a resolved date or passes the Spanish phrase and the
 * tool resolves it with the real clock.
 */
export function artDateHint(clock: Clock): string {
  const week = artWeekRange(clock);
  return `Anclas de fecha (ART): hoy=${artToday(
    clock,
  )}, mañana=${artTomorrow(clock)}, esta semana=${week.from}..${week.to}.`;
}

export function resolveDateOrArgumentError(
  toolName: string,
  input: string | undefined,
  clock: Clock,
): string {
  try {
    return resolveArtDate(input, clock);
  } catch (error) {
    if (error instanceof InvalidDateError) throw new ToolArgumentError(toolName, error.message);
    throw error;
  }
}

export function resolveRangeOrArgumentError(
  toolName: string,
  from: string | undefined,
  to: string | undefined,
  clock: Clock,
) {
  try {
    return resolveArtRange(from, to, clock);
  } catch (error) {
    if (error instanceof InvalidRangeError) throw new ToolArgumentError(toolName, error.message);
    throw error;
  }
}

/** Rejects a date in the past or beyond the backend window before proposing. */
export function assertBookableDate(toolName: string, date: string, clock: Clock): void {
  const today = artToday(clock);
  if (date < today) {
    throw new ToolArgumentError(toolName, `la fecha ${date} ya pasó (hoy es ${today})`);
  }
  const limit = addDays(today, MAX_ADVANCE_DAYS);
  if (date > limit) {
    throw new ToolArgumentError(
      toolName,
      `la fecha ${date} queda a más de ${MAX_ADVANCE_DAYS} días (máximo ${limit})`,
    );
  }
}

/** Looks the appointment up when the caller knows its day, to enrich the proposal. */
export async function findAppointment(
  context: ToolHandlerContext,
  fecha: string | undefined,
  appointmentId: string,
): Promise<Appointment | undefined> {
  if (!fecha) return undefined;
  try {
    const date = resolveArtDate(fecha, context.clock);
    const appointments = await context.backend.delDia(date);
    return appointments.find((appointment) => appointment.id === appointmentId);
  } catch {
    return undefined;
  }
}

/**
 * Looks the appointment up in a recent window. Completion always refers to a
 * past appointment, so this works when the model does not know its day.
 */
export async function findRecentAppointment(
  context: ToolHandlerContext,
  appointmentId: string,
  days = 14,
): Promise<Appointment | undefined> {
  try {
    const today = artToday(context.clock);
    const appointments = await context.backend.rango(addDays(today, -days), today);
    return appointments.find((appointment) => appointment.id === appointmentId);
  } catch {
    return undefined;
  }
}

const STATUS_NAMES: Readonly<Record<string, string>> = {
  pending: "pendiente",
  paid: "seña pagada",
  confirmed: "confirmado",
  completed: "completado",
  cancelled: "cancelado",
  no_show: "no vino",
};

/** Spanish name of an appointment status; unknown statuses pass through. */
export function statusName(status: string): string {
  return STATUS_NAMES[status] ?? status;
}

/** "hoy", "ayer", "mañana" or "07/01": how Romi names a day. */
export function humanDay(date: string, clock: Clock): string {
  if (date === artToday(clock)) return "hoy";
  if (date === artYesterday(clock)) return "ayer";
  if (date === artTomorrow(clock)) return "mañana";
  return `${date.slice(8, 10)}/${date.slice(5, 7)}`;
}

/** "Ana G. (Servicio Soft Gel, hoy 08:00)": the appointment as Romi would say it, no id. */
export function appointmentLabel(appointment: Appointment, clock: Clock): string {
  const who = appointment.clientName ?? "sin nombre";
  return `${who} (${appointment.serviceName}, ${humanDay(appointment.date, clock)} ${appointment.timeSlot})`;
}

export function describeAppointment(
  appointment: Appointment,
  clock: Clock,
  status = appointment.status,
): string {
  const who = appointment.clientName ?? "sin nombre";
  return `${humanDay(appointment.date, clock)} ${appointment.timeSlot} · ${appointment.serviceName} · ${who} · ${statusName(status)}`;
}

export function slotField(description: string): z.ZodString {
  return z.string().regex(SLOT_PATTERN, "usá el formato HH:MM").describe(description);
}
