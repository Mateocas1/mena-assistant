import { addDays } from "../../time/index.js";
import type { Appointment, Service } from "./client.js";

/** Slots offered by the salon (test-kimi `TIME_SLOTS`). */
export const TIME_SLOTS = ["08:00", "11:00", "14:00", "16:30", "18:30"] as const;

/** Statuses that occupy a slot (test-kimi `ACTIVE_BOOKING_STATUSES`). */
export const ACTIVE_BOOKING_STATUSES = ["pending", "paid", "confirmed"] as const;

export interface TurnosFixtures {
  readonly timeSlots: readonly string[];
  readonly appointments: readonly Appointment[];
  /** Blocked time slots per ART date. */
  readonly blockedSlots: Readonly<Record<string, readonly string[]>>;
  /** ART dates blocked entirely. */
  readonly fullDayBlocks: readonly string[];
  readonly services: readonly Service[];
}

/** Canonical catalog (test-kimi `CANONICAL_SERVICE_CATALOG`). */
const SERVICES: readonly Service[] = [
  { slug: "retiro-softgel", name: "Retiro Soft Gel", price: 8000, durationMinutes: 40 },
  { slug: "retiro-capping", name: "Retiro Capping", price: 7000, durationMinutes: 40 },
  { slug: "retiro-semi", name: "Retiro Semipermanente", price: 5000, durationMinutes: 40 },
  { slug: "servicio-softgel", name: "Servicio Soft Gel", price: 25000, durationMinutes: 120 },
  { slug: "servicio-capping", name: "Servicio Capping", price: 23000, durationMinutes: 120 },
  { slug: "servicio-semi", name: "Servicio Semipermanente", price: 21000, durationMinutes: 60 },
];

/**
 * Builds a fixture set anchored on `referenceDate` (ART `YYYY-MM-DD`) so the
 * mock has data for "today", "tomorrow" and the day after, whenever it runs.
 */
export function createTurnosFixtures(referenceDate: string): TurnosFixtures {
  const tomorrow = addDays(referenceDate, 1);
  const dayAfter = addDays(referenceDate, 2);

  return {
    timeSlots: TIME_SLOTS,
    appointments: [
      {
        id: "apt_today_0800",
        date: referenceDate,
        timeSlot: "08:00",
        status: "confirmed",
        serviceName: "Servicio Soft Gel",
        clientName: "Ana G.",
      },
      {
        id: "apt_today_1400",
        date: referenceDate,
        timeSlot: "14:00",
        status: "paid",
        serviceName: "Servicio Capping",
        clientName: "Laura P.",
      },
      {
        id: "apt_cancelled_today",
        date: referenceDate,
        timeSlot: "18:30",
        status: "cancelled",
        serviceName: "Servicio Semipermanente",
        clientName: "Nadia S.",
      },
      {
        id: "apt_tomorrow_1100",
        date: tomorrow,
        timeSlot: "11:00",
        status: "confirmed",
        serviceName: "Retiro Soft Gel",
        clientName: "Sofía M.",
      },
      {
        id: "apt_tomorrow_1630",
        date: tomorrow,
        timeSlot: "16:30",
        status: "pending",
        serviceName: "Servicio Semipermanente",
        clientName: "Carla D.",
      },
      {
        id: "apt_dayafter_1800",
        date: dayAfter,
        timeSlot: "18:30",
        status: "confirmed",
        serviceName: "Servicio Soft Gel",
        clientName: "Marta R.",
      },
    ],
    blockedSlots: {
      [referenceDate]: ["16:30"],
      [tomorrow]: ["08:00"],
    },
    fullDayBlocks: [],
    services: SERVICES,
  };
}
