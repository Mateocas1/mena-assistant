/**
 * Shape of the Mena Nails booking backend. Every field matches the real
 * `/assistant/*` responses documented in `test-kimi/docs/assistant-api.md` and
 * implemented in `convex/assistant.ts`, so M1 only swaps the transport.
 */

/**
 * Statuses the backend uses today. The union stays open (`string & {}`) so a new
 * backend status is treated as data instead of failing response validation.
 */
export type AppointmentStatus =
  "pending" | "paid" | "confirmed" | "completed" | "cancelled" | "no_show" | (string & {});

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

/** `POST /assistant/verifications/pending` row (PII-minimised). */
export interface AssistantVerification {
  readonly id: string;
  readonly status: string;
  readonly reason: string | null;
  readonly amount: number | null;
  readonly date: string | null;
  readonly timeSlot: string | null;
  readonly clientName: string | null;
}

/** `POST /assistant/refunds/summary`. */
export interface RefundSummary {
  readonly count: number;
  readonly totalAmount: number;
  readonly byReason: Readonly<Record<string, number>>;
}

/** `POST /assistant/summary` response. */
export interface DailySummary {
  readonly date: string;
  readonly totalAppointments: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly revenue: number;
  readonly pendingVerifications: number;
  readonly refundsPending: number;
}

/** Combined `turnos.pagos_pendientes` payload (verifications + refund queue). */
export interface PendingPayments {
  readonly verificaciones: readonly AssistantVerification[];
  readonly reintegros: RefundSummary;
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
  /** Projection of `POST /assistant/appointments/day` (or `/today`). */
  delDia(date: string): Promise<Appointment[]>;
  /** Projection of `POST /assistant/appointments/range` (max 31 days). */
  rango(from: string, to: string): Promise<Appointment[]>;
  /** Projection of `POST /assistant/availability`. */
  disponibilidad(date: string): Promise<AvailabilitySlot[]>;
  /** Projection of `POST /assistant/services`. */
  servicios(): Promise<Service[]>;
  /** `POST /assistant/verifications/pending` + `POST /assistant/refunds/summary`. */
  pagosPendientes(): Promise<PendingPayments>;
  /** Projection of `POST /assistant/summary`. */
  resumen(date: string): Promise<DailySummary>;
  /** Projection of `POST /assistant/appointments/cancel` (write; confirm-gated). */
  cancelar(appointmentId: string, motivo?: string): Promise<CancelResult>;
}

/** User-facing copy for the failure modes the bot must explain clearly. */
export const NOT_CONFIGURED_USER_MESSAGE =
  "El asistente todavía no está habilitado del lado del servidor. Avisá a Mateo.";
export const AUTH_USER_MESSAGE =
  "El asistente no pudo autenticarse con el sistema de turnos. Avisá a Mateo.";

export interface TurnosErrorOptions {
  readonly userMessage?: string;
  readonly cause?: unknown;
}

/** Base class: every adapter failure is a typed `TurnosError`. */
export class TurnosError extends Error {
  /** Spanish copy the assistant may relay verbatim when the failure is user-visible. */
  readonly userMessage: string | undefined;

  constructor(message: string, options: TurnosErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TurnosError";
    this.userMessage = options.userMessage;
  }
}

/** Non-2xx response. */
export class TurnosHttpError extends TurnosError {
  readonly status: number;

  constructor(status: number, message: string, options: TurnosErrorOptions = {}) {
    super(message, options);
    this.name = "TurnosHttpError";
    this.status = status;
  }
}

/** 401: the service token is missing or invalid. */
export class TurnosAuthError extends TurnosHttpError {
  constructor(message = "Unauthorized") {
    super(401, message, { userMessage: AUTH_USER_MESSAGE });
    this.name = "TurnosAuthError";
  }
}

/** 503: the backend has no `ASSISTANT_TOKEN` configured (fail closed). */
export class TurnosNotConfiguredError extends TurnosHttpError {
  constructor(message = "Assistant endpoints are not configured") {
    super(503, message, { userMessage: NOT_CONFIGURED_USER_MESSAGE });
    this.name = "TurnosNotConfiguredError";
  }
}

/** 400: the backend rejected the request body. */
export class TurnosRequestError extends TurnosHttpError {
  constructor(message: string) {
    super(400, message);
    this.name = "TurnosRequestError";
  }
}

/** The response body did not match the contract (invalid JSON or wrong shape). */
export class TurnosResponseError extends TurnosError {
  constructor(message: string, options: TurnosErrorOptions = {}) {
    super(message, options);
    this.name = "TurnosResponseError";
  }
}

/** The request never completed (DNS, TLS, connection reset, …). */
export class TurnosNetworkError extends TurnosError {
  constructor(message: string, options: TurnosErrorOptions = {}) {
    super(message, options);
    this.name = "TurnosNetworkError";
  }
}

/** The per-call timeout elapsed. */
export class TurnosTimeoutError extends TurnosError {
  constructor(message: string, options: TurnosErrorOptions = {}) {
    super(message, options);
    this.name = "TurnosTimeoutError";
  }
}

export class TurnosNotFoundError extends TurnosError {
  constructor(appointmentId: string) {
    super(`Appointment not found: ${appointmentId}`);
    this.name = "TurnosNotFoundError";
  }
}
