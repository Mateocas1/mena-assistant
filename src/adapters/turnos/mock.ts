import { artToday } from "../../time/index.js";
import { ACTIVE_BOOKING_STATUSES, createTurnosFixtures, type TurnosFixtures } from "./fixtures.js";
import {
  TurnosError,
  TurnosNotFoundError,
  type Appointment,
  type AvailabilitySlot,
  type CancelResult,
  type Service,
  type TurnosBackend,
} from "./client.js";

/**
 * In-memory booking backend backed by {@link createTurnosFixtures}. It mirrors
 * the real route semantics (raw appointment rows, availability derived from
 * active appointments plus blocks, admin cancellation outcome) so switching to
 * the HTTP backend does not change any tool behaviour.
 */
export class MockTurnosBackend implements TurnosBackend {
  private readonly fixtures: TurnosFixtures;
  private appointments: Appointment[];

  constructor(fixtures: TurnosFixtures = createTurnosFixtures(artToday())) {
    this.fixtures = fixtures;
    this.appointments = fixtures.appointments.map((appointment) => ({ ...appointment }));
  }

  async delDia(date: string): Promise<Appointment[]> {
    return this.appointments
      .filter((appointment) => appointment.date === date)
      .sort((left, right) => left.timeSlot.localeCompare(right.timeSlot))
      .map((appointment) => ({ ...appointment }));
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
