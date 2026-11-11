import { addDays } from "../../time/index.js";
import type { Appointment, AssistantVerification, RefundSummary, Service } from "./client.js";

/** Slots offered by the salon (booking backend `TIME_SLOTS`). */
export const TIME_SLOTS = ["08:00", "11:00", "14:00", "16:30", "18:30"] as const;

/** Statuses that occupy a slot (booking backend `ACTIVE_BOOKING_STATUSES`). */
export const ACTIVE_BOOKING_STATUSES = ["pending", "paid", "confirmed"] as const;

/** Statuses that count as revenue in the daily summary (booking backend `getDailySummary`). */
export const REVENUE_STATUSES = ["paid", "confirmed", "completed"] as const;

/** Statuses that still need a human decision (booking backend `NON_TERMINAL_VERIFICATION_STATUSES`). */
export const NON_TERMINAL_VERIFICATION_STATUSES = [
  "pending",
  "auto_match",
  "manual_review",
  "failed",
] as const;

/** Fixture-only extension: the deposit is needed to mirror `getDailySummary.revenue`. */
export interface FixtureAppointment extends Appointment {
  readonly depositPrice: number;
}

export interface TurnosFixtures {
  readonly timeSlots: readonly string[];
  readonly appointments: readonly FixtureAppointment[];
  /** Blocked time slots per ART date. */
  readonly blockedSlots: Readonly<Record<string, readonly string[]>>;
  /** ART dates blocked entirely. */
  readonly fullDayBlocks: readonly string[];
  readonly services: readonly Service[];
  readonly verifications: readonly AssistantVerification[];
  readonly refunds: RefundSummary;
}

/** Canonical catalog (booking backend `CANONICAL_SERVICE_CATALOG`). */
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
        id: "apt_past_0800",
        date: addDays(referenceDate, -7),
        timeSlot: "08:00",
        status: "confirmed",
        serviceName: "Servicio Soft Gel",
        clientName: "Paula V.",
        depositPrice: 12500,
      },
      {
        id: "apt_today_0800",
        date: referenceDate,
        timeSlot: "08:00",
        status: "confirmed",
        serviceName: "Servicio Soft Gel",
        clientName: "Ana G.",
        depositPrice: 12500,
      },
      {
        id: "apt_today_1400",
        date: referenceDate,
        timeSlot: "14:00",
        status: "paid",
        serviceName: "Servicio Capping",
        clientName: "Laura P.",
        depositPrice: 11500,
      },
      {
        id: "apt_cancelled_today",
        date: referenceDate,
        timeSlot: "18:30",
        status: "cancelled",
        serviceName: "Servicio Semipermanente",
        clientName: "Nadia S.",
        depositPrice: 10500,
      },
      {
        id: "apt_tomorrow_1100",
        date: tomorrow,
        timeSlot: "11:00",
        status: "confirmed",
        serviceName: "Retiro Soft Gel",
        clientName: "Sofía M.",
        depositPrice: 4000,
      },
      {
        id: "apt_tomorrow_1630",
        date: tomorrow,
        timeSlot: "16:30",
        status: "pending",
        serviceName: "Servicio Semipermanente",
        clientName: "Carla D.",
        depositPrice: 10500,
      },
      {
        id: "apt_dayafter_1800",
        date: dayAfter,
        timeSlot: "18:30",
        status: "confirmed",
        serviceName: "Servicio Soft Gel",
        clientName: "Marta R.",
        depositPrice: 12500,
      },
    ],
    blockedSlots: {
      [referenceDate]: ["16:30"],
      [tomorrow]: ["08:00"],
    },
    fullDayBlocks: [],
    services: SERVICES,
    verifications: [
      {
        id: "ver_today_pending",
        paymentId: "pay_today_pending",
        status: "pending",
        reason: "amount_mismatch",
        amount: 12500,
        date: referenceDate,
        timeSlot: "08:00",
        clientName: "Ana G.",
      },
      {
        id: "ver_today_failed",
        paymentId: "pay_today_failed",
        status: "failed",
        reason: "wrong_destination",
        amount: 11500,
        date: referenceDate,
        timeSlot: "14:00",
        clientName: "Laura P.",
      },
      {
        id: "ver_tomorrow_matched",
        paymentId: "pay_tomorrow_matched",
        status: "matched",
        reason: "verified",
        amount: 4000,
        date: tomorrow,
        timeSlot: "11:00",
        clientName: "Sofía M.",
      },
    ],
    refunds: { count: 1, totalAmount: 5000, byReason: { admin_cancellation: 1 } },
  };
}
