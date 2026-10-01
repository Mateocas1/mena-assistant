/**
 * Shape of the Mena Nails booking backend. Every field matches the real
 * `/assistant/*` responses documented in `test-kimi/docs/assistant-api.md` and
 * implemented in `convex/assistant.ts`, so M1 only swaps the transport.
 */

export type AppointmentStatus =
  "pending" | "paid" | "confirmed" | "completed" | "cancelled" | "no_show";

export interface Appointment {
  readonly id: string;
  /** ART calendar date, `YYYY-MM-DD`. */
  readonly date: string;
  readonly timeSlot: string;
  readonly status: AppointmentStatus;
  readonly serviceName: string;
  /** Short name only (`"Ana G."`); never full name, phone or email. */
  readonly clientName: string | null;
}

export interface AvailabilitySlot {
  readonly time: string;
  readonly available: boolean;
}

export interface Service {
  readonly slug: string;
  readonly name: string;
  readonly price: number;
  readonly durationMinutes: number;
}

/** Result of the admin cancellation route (`cancelAppointmentCore`). */
export interface CancelResult {
  readonly success: true;
  readonly refunded: false;
  readonly refundRequired: boolean;
  readonly refundReason: "client_cancellation" | "admin_cancellation" | null;
  readonly depositRetained: boolean;
}

/** Booking backend used by the `turnos.*` tools. */
export interface TurnosBackend {
  /** Projection of `POST /assistant/appointments/day`. */
  delDia(date: string): Promise<Appointment[]>;
  /** Projection of `POST /assistant/availability`. */
  disponibilidad(date: string): Promise<AvailabilitySlot[]>;
  /** Projection of `POST /assistant/services`. */
  servicios(): Promise<Service[]>;
  /** Projection of `POST /assistant/appointments/cancel` (write; confirm-gated). */
  cancelar(appointmentId: string, motivo?: string): Promise<CancelResult>;
}

export class TurnosError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnosError";
  }
}

export class TurnosNotFoundError extends TurnosError {
  constructor(appointmentId: string) {
    super(`Appointment not found: ${appointmentId}`);
    this.name = "TurnosNotFoundError";
  }
}
