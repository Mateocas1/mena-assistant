import { artToday } from "../../time/index.js";
import {
  ACTIVE_BOOKING_STATUSES,
  NON_TERMINAL_VERIFICATION_STATUSES,
  REVENUE_STATUSES,
  createTurnosFixtures,
  type FixtureAppointment,
  type TurnosFixtures,
} from "./fixtures.js";
import {
  TurnosError,
  TurnosNotFoundError,
  type Appointment,
  type AvailabilitySlot,
  type CancelResult,
  type DailySummary,
  type PendingPayments,
  type Service,
  type TurnosBackend,
} from "./client.js";

function toAppointment(row: FixtureAppointment): Appointment {
  return {
    id: row.id,
    date: row.date,
    timeSlot: row.timeSlot,
    status: row.status,
    serviceName: row.serviceName,
    clientName: row.clientName,
  };
}

function byDateThenSlot(left: FixtureAppointment, right: FixtureAppointment): number {
  return left.date === right.date
    ? left.timeSlot.localeCompare(right.timeSlot)
    : left.date.localeCompare(right.date);
}

/**
 * In-memory booking backend backed by {@link createTurnosFixtures}. It mirrors
 * the real route semantics (raw appointment rows, availability derived from
 * active appointments plus blocks, admin cancellation outcome) so switching to
 * the HTTP backend does not change any tool behaviour.
 */
export class MockTurnosBackend implements TurnosBackend {
  private readonly fixtures: TurnosFixtures;
  private appointments: FixtureAppointment[];

  constructor(fixtures: TurnosFixtures = createTurnosFixtures(artToday())) {
    this.fixtures = fixtures;
    this.appointments = fixtures.appointments.map((appointment) => ({ ...appointment }));
  }

  async delDia(date: string): Promise<Appointment[]> {
    return this.appointments
      .filter((appointment) => appointment.date === date)
      .sort((left, right) => left.timeSlot.localeCompare(right.timeSlot))
      .map(toAppointment);
  }

  async rango(from: string, to: string): Promise<Appointment[]> {
    return this.appointments
      .filter((appointment) => appointment.date >= from && appointment.date <= to)
      .sort(byDateThenSlot)
      .map(toAppointment);
  }

  async disponibilidad(date: string): Promise<AvailabilitySlot[]> {
    const fullDayBlocked = this.fixtures.fullDayBlocks.includes(date);
    const blocked = new Set(this.fixtures.blockedSlots[date] ?? []);
    const occupied = new Set(
      this.appointments
        .filter(
          (appointment) =>
            appointment.date === date &&
            (ACTIVE_BOOKING_STATUSES as readonly string[]).includes(appointment.status),
        )
        .map((appointment) => appointment.timeSlot),
    );

    return this.fixtures.timeSlots.map((time) => ({
      time,
      available: !fullDayBlocked && !blocked.has(time) && !occupied.has(time),
    }));
  }

  async servicios(): Promise<Service[]> {
    return [...this.fixtures.services]
      .sort((left, right) => left.slug.localeCompare(right.slug))
      .map((service) => ({ ...service }));
  }

  async pagosPendientes(): Promise<PendingPayments> {
    const pending = this.fixtures.verifications.filter((verification) =>
      (NON_TERMINAL_VERIFICATION_STATUSES as readonly string[]).includes(verification.status),
    );

    return {
      verificaciones: pending.map((verification) => ({ ...verification })),
      reintegros: { ...this.fixtures.refunds, byReason: { ...this.fixtures.refunds.byReason } },
    };
  }

  async resumen(date: string): Promise<DailySummary> {
    const rows = this.appointments.filter((appointment) => appointment.date === date);
    const counts: Record<string, number> = {};
    let revenue = 0;

    for (const row of rows) {
      counts[row.status] = (counts[row.status] ?? 0) + 1;
      if ((REVENUE_STATUSES as readonly string[]).includes(row.status)) {
        revenue += row.depositPrice;
      }
    }

    return {
      date,
      totalAppointments: rows.length,
      counts,
      revenue,
      pendingVerifications: (await this.pagosPendientes()).verificaciones.length,
      refundsPending: this.fixtures.refunds.count,
    };
  }

  async cancelar(appointmentId: string, _motivo?: string): Promise<CancelResult> {
    const index = this.appointments.findIndex((appointment) => appointment.id === appointmentId);
    const appointment = this.appointments[index];
    if (index === -1 || !appointment) {
      throw new TurnosNotFoundError(appointmentId);
    }
    if (!(ACTIVE_BOOKING_STATUSES as readonly string[]).includes(appointment.status)) {
      throw new TurnosError("Cannot cancel this appointment");
    }

    this.appointments[index] = { ...appointment, status: "cancelled" };

    // Admin cancellations always leave the deposit decision to Romi (refund queue).
    return {
      success: true,
      refunded: false,
      refundRequired: true,
      refundReason: "admin_cancellation",
      depositRetained: false,
    };
  }
}
