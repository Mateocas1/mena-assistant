import { shortClientName } from "../../audit/pii.js";
import { artToday, systemClock, type Clock } from "../../time/index.js";
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
  type AssistantVerification,
  type AvailabilitySlot,
  type BlockInput,
  type BlockResult,
  type CancelResult,
  type CreateAppointmentResult,
  type DailySummary,
  type NewAppointmentInput,
  type PendingPayments,
  type RescheduleResult,
  type Service,
  type SimpleWriteResult,
  type TurnosBackend,
} from "./client.js";

const DEPOSIT_RATE = 0.5;

interface MockBlock {
  readonly id: string;
  readonly date: string;
  readonly timeSlot?: string;
  readonly isFullDay: boolean;
  readonly reason?: string;
}

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

export interface MockTurnosBackendOptions {
  readonly clock?: Clock;
}

/**
 * In-memory booking backend backed by {@link createTurnosFixtures}. It mirrors
 * the real route semantics (raw appointment rows, availability derived from
 * active appointments plus blocks, admin cancellation outcome, write validation)
 * so switching to the HTTP backend does not change any tool behaviour.
 *
 * Writes mutate instance state only; the shared fixtures are never touched.
 */
export class MockTurnosBackend implements TurnosBackend {
  private readonly fixtures: TurnosFixtures;
  private appointments: FixtureAppointment[];
  private verifications: AssistantVerification[];
  private blocks: MockBlock[];
  private readonly clock: Clock;
  private blockSequence = 0;
  private appointmentSequence = 0;

  constructor(
    fixtures: TurnosFixtures = createTurnosFixtures(artToday()),
    options: MockTurnosBackendOptions = {},
  ) {
    this.fixtures = fixtures;
    this.appointments = fixtures.appointments.map((appointment) => ({ ...appointment }));
    this.verifications = fixtures.verifications.map((verification) => ({ ...verification }));
    this.clock = options.clock ?? systemClock;
    this.blocks = [
      ...Object.entries(fixtures.blockedSlots).flatMap(([date, slots]) =>
        slots.map((timeSlot, index) => ({
          id: `blk_seed_${date}_${index}`,
          date,
          timeSlot,
          isFullDay: false,
        })),
      ),
      ...fixtures.fullDayBlocks.map((date, index) => ({
        id: `blk_seed_full_${index}`,
        date,
        isFullDay: true,
      })),
    ];
  }

  /* ── reads ──────────────────────────────────────────────────────────────── */

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
    const fullDayBlocked = this.blocks.some((block) => block.date === date && block.isFullDay);
    const blocked = new Set(
      this.blocks
        .filter((block) => block.date === date && !block.isFullDay && block.timeSlot)
        .map((block) => block.timeSlot),
    );

    return this.fixtures.timeSlots.map((time) => ({
      time,
      available: !fullDayBlocked && !blocked.has(time) && !this.isOccupied(date, time),
    }));
  }

  async servicios(): Promise<Service[]> {
    return [...this.fixtures.services]
      .sort((left, right) => left.slug.localeCompare(right.slug))
      .map((service) => ({ ...service }));
  }

  async pagosPendientes(): Promise<PendingPayments> {
    return {
      verificaciones: this.pendingVerifications().map((verification) => ({ ...verification })),
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
      pendingVerifications: this.pendingVerifications().length,
      refundsPending: this.fixtures.refunds.count,
    };
  }

  /* ── writes (only reached through a confirmed proposal) ─────────────────── */

  async marcarCompletado(appointmentId: string): Promise<SimpleWriteResult> {
    const index = this.indexOfAppointment(appointmentId);
    const appointment = this.appointments[index]!;

    if (appointment.status !== "confirmed") {
      throw new TurnosError("Only confirmed appointments can be completed");
    }
    if (appointment.date >= artToday(this.clock)) {
      throw new TurnosError("The appointment date has not arrived yet");
    }

    this.appointments[index] = { ...appointment, status: "completed" };
    return { success: true };
  }

  async cancelar(appointmentId: string, _motivo?: string): Promise<CancelResult> {
    const index = this.indexOfAppointment(appointmentId);
    const appointment = this.appointments[index]!;

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

  async bloquear(input: BlockInput): Promise<BlockResult> {
    const blockedSlotId = `blk_${++this.blockSequence}`;
    this.blocks.push({
      id: blockedSlotId,
      date: input.date,
      isFullDay: input.isFullDay,
      ...(input.timeSlot === undefined ? {} : { timeSlot: input.timeSlot }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    return { success: true, blockedSlotId };
  }

  async desbloquear(blockedSlotId: string): Promise<SimpleWriteResult> {
    const index = this.blocks.findIndex((block) => block.id === blockedSlotId);
    if (index === -1) throw new TurnosNotFoundError(blockedSlotId);
    this.blocks.splice(index, 1);
    return { success: true };
  }

  async crearParaClienta(input: NewAppointmentInput): Promise<CreateAppointmentResult> {
    const service = this.fixtures.services.find(
      (candidate) => candidate.slug === input.serviceSlug,
    );
    if (!service) throw new TurnosError(`Unknown service slug: ${input.serviceSlug}`);
    if (this.isOccupied(input.date, input.timeSlot)) {
      throw new TurnosError("Este horario ya está ocupado. Por favor seleccioná otro.");
    }

    const appointmentId = `apt_new_${++this.appointmentSequence}`;
    this.appointments.push({
      id: appointmentId,
      date: input.date,
      timeSlot: input.timeSlot,
      status: "pending",
      serviceName: service.name,
      clientName: shortClientName(input.clientName) ?? null,
      depositPrice: Math.round(service.price * DEPOSIT_RATE),
    });

    return { success: true, appointmentId };
  }

  async reprogramar(
    appointmentId: string,
    date: string,
    timeSlot: string,
  ): Promise<RescheduleResult> {
    const index = this.indexOfAppointment(appointmentId);
    const appointment = this.appointments[index]!;

    if (!(ACTIVE_BOOKING_STATUSES as readonly string[]).includes(appointment.status)) {
      throw new TurnosError("Cannot reschedule this appointment");
    }
    if (this.isOccupied(date, timeSlot, appointmentId)) {
      throw new TurnosError("Este horario ya está ocupado. Por favor seleccioná otro.");
    }

    this.appointments[index] = { ...appointment, date, timeSlot };
    return { success: true, appointmentId, date, timeSlot };
  }

  async confirmarTransferencia(
    _paymentId: string,
    verificationId: string,
  ): Promise<SimpleWriteResult> {
    const index = this.indexOfVerification(verificationId);
    this.verifications[index] = { ...this.verifications[index]!, status: "matched" };
    return { success: true };
  }

  async rechazarTransferencia(
    _paymentId: string,
    verificationId: string,
    _reason: string,
  ): Promise<SimpleWriteResult> {
    const index = this.indexOfVerification(verificationId);
    this.verifications[index] = { ...this.verifications[index]!, status: "rejected" };
    return { success: true };
  }

  /* ── internals ──────────────────────────────────────────────────────────── */

  private pendingVerifications(): AssistantVerification[] {
    return this.verifications.filter((verification) =>
      (NON_TERMINAL_VERIFICATION_STATUSES as readonly string[]).includes(verification.status),
    );
  }

  private isOccupied(date: string, timeSlot: string, excludeAppointmentId?: string): boolean {
    return this.appointments.some(
      (appointment) =>
        appointment.date === date &&
        appointment.timeSlot === timeSlot &&
        appointment.id !== excludeAppointmentId &&
        (ACTIVE_BOOKING_STATUSES as readonly string[]).includes(appointment.status),
    );
  }

  private indexOfAppointment(appointmentId: string): number {
    const index = this.appointments.findIndex((appointment) => appointment.id === appointmentId);
    if (index === -1) throw new TurnosNotFoundError(appointmentId);
    return index;
  }

  private indexOfVerification(verificationId: string): number {
    const index = this.verifications.findIndex(
      (verification) => verification.id === verificationId,
    );
    if (index === -1) throw new TurnosNotFoundError(verificationId);
    return index;
  }
}
