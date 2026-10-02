import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withSpan } from "../../telemetry/tracer.js";
import { artToday, systemClock, type Clock } from "../../time/index.js";
import {
  TurnosAuthError,
  TurnosHttpError,
  TurnosNetworkError,
  TurnosNotConfiguredError,
  TurnosRequestError,
  TurnosResponseError,
  TurnosTimeoutError,
  type Appointment,
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

/* ───────────────────────────────────────────────
   Response schemas (the 30a contract, validated)
   ─────────────────────────────────────────────── */

const appointmentSchema = z.object({
  id: z.string(),
  date: z.string(),
  timeSlot: z.string(),
  status: z.string(),
  serviceName: z.string(),
  clientName: z.string().nullable(),
});

const appointmentsSchema = z.array(appointmentSchema);
const availabilitySchema = z.array(z.object({ time: z.string(), available: z.boolean() }));
const servicesSchema = z.array(
  z.object({
    slug: z.string(),
    name: z.string(),
    price: z.number(),
    durationMinutes: z.number(),
  }),
);
const verificationSchema = z.object({
  id: z.string(),
  status: z.string(),
  reason: z.string().nullable(),
  amount: z.number().nullable(),
  date: z.string().nullable(),
  timeSlot: z.string().nullable(),
  clientName: z.string().nullable(),
  // Optional: today only the DB row has it.
  paymentId: z.string().optional(),
});
const verificationsSchema = z.array(verificationSchema);
const refundsSchema = z.object({
  count: z.number(),
  totalAmount: z.number(),
  byReason: z.record(z.string(), z.number()),
});
const summarySchema = z.object({
  date: z.string(),
  totalAppointments: z.number(),
  counts: z.record(z.string(), z.number()),
  revenue: z.number(),
  pendingVerifications: z.number(),
  refundsPending: z.number(),
});
const cancelSchema = z.object({
  success: z.literal(true),
  refunded: z.literal(false),
  refundRequired: z.boolean(),
  refundReason: z.enum(["client_cancellation", "admin_cancellation"]).nullable(),
  depositRetained: z.boolean(),
});

const simpleWriteSchema = z.object({ success: z.literal(true) });
const blockWriteSchema = z.object({ success: z.literal(true), blockedSlotId: z.string() });
const createWriteSchema = z.object({ success: z.literal(true), appointmentId: z.string() });
const rescheduleWriteSchema = z.object({
  success: z.literal(true),
  appointmentId: z.string(),
  date: z.string(),
  timeSlot: z.string(),
});

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpTurnosClientOptions {
  /** Convex `.convex.site` origin, e.g. `https://shiny-fox-123.convex.site`. */
  readonly baseUrl: string;
  /** Service token; the backend compares it in constant time. */
  readonly token: string;
  readonly timeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly clock?: Clock;
  readonly fetchImpl?: FetchLike;
  readonly requestIdFactory?: () => string;
}

interface RequestOptions {
  /** Reads retry once on 5xx/network; writes never retry. */
  readonly retry: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 250;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extracts `{error: "..."}` from a backend failure, falling back to the raw text. */
function serverMessage(text: string, fallback: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim().length > 0) return parsed.error;
  } catch {
    // not JSON: use the raw body below
  }
  return text.trim().length > 0 ? text.trim() : fallback;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof TurnosNetworkError || error instanceof TurnosTimeoutError) return true;
  // "Not configured" is a static server state: it will not change in a retry window.
  if (error instanceof TurnosNotConfiguredError) return false;
  return error instanceof TurnosHttpError && error.status >= 500;
}

/**
 * Real booking backend client (`test-kimi` 30a `/assistant/*` HTTP actions).
 *
 * Every route is a POST with a Bearer service token; reads retry once on 5xx or
 * a network failure, writes never retry, and every response is validated against
 * the contract before it reaches a tool.
 */
export class HttpTurnosClient implements TurnosBackend {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly clock: Clock;
  private readonly fetchImpl: FetchLike;
  private readonly requestIdFactory: () => string;

  constructor(options: HttpTurnosClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.clock = options.clock ?? systemClock;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.requestIdFactory = options.requestIdFactory ?? randomUUID;
  }

  async delDia(date: string): Promise<Appointment[]> {
    // The contract exposes both; today is the common case.
    if (date === artToday(this.clock)) {
      return await this.post("/assistant/appointments/today", {}, appointmentsSchema, {
        retry: true,
      });
    }
    return await this.post("/assistant/appointments/day", { date }, appointmentsSchema, {
      retry: true,
    });
  }

  async rango(from: string, to: string): Promise<Appointment[]> {
    return await this.post("/assistant/appointments/range", { from, to }, appointmentsSchema, {
      retry: true,
    });
  }

  async disponibilidad(date: string): Promise<AvailabilitySlot[]> {
    return await this.post("/assistant/availability", { date }, availabilitySchema, {
      retry: true,
    });
  }

  async servicios(): Promise<Service[]> {
    return await this.post("/assistant/services", {}, servicesSchema, { retry: true });
  }

  async pagosPendientes(): Promise<PendingPayments> {
    const [verificaciones, reintegros] = await Promise.all([
      this.post("/assistant/verifications/pending", {}, verificationsSchema, { retry: true }),
      this.post("/assistant/refunds/summary", {}, refundsSchema, { retry: true }),
    ]);
    return { verificaciones, reintegros };
  }

  async resumen(date: string): Promise<DailySummary> {
    return await this.post("/assistant/summary", { date }, summarySchema, { retry: true });
  }

  async cancelar(appointmentId: string, motivo?: string): Promise<CancelResult> {
    const body = motivo === undefined ? { appointmentId } : { appointmentId, reason: motivo };
    // Writes never retry: a retry could double-apply a state change.
    return await this.post("/assistant/appointments/cancel", body, cancelSchema, { retry: false });
  }

  async marcarCompletado(appointmentId: string): Promise<SimpleWriteResult> {
    return await this.post(
      "/assistant/appointments/complete",
      { appointmentId },
      simpleWriteSchema,
      { retry: false },
    );
  }

  async bloquear(input: BlockInput): Promise<BlockResult> {
    return await this.post(
      "/assistant/blocks/create",
      {
        date: input.date,
        isFullDay: input.isFullDay,
        ...(input.timeSlot === undefined ? {} : { timeSlot: input.timeSlot }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      },
      blockWriteSchema,
      { retry: false },
    );
  }

  async desbloquear(blockedSlotId: string): Promise<SimpleWriteResult> {
    return await this.post("/assistant/blocks/remove", { blockedSlotId }, simpleWriteSchema, {
      retry: false,
    });
  }

  async crearParaClienta(input: NewAppointmentInput): Promise<CreateAppointmentResult> {
    return await this.post(
      "/assistant/appointments/create",
      {
        clientName: input.clientName,
        clientPhone: input.clientPhone,
        serviceSlug: input.serviceSlug,
        date: input.date,
        timeSlot: input.timeSlot,
        ...(input.clientEmail === undefined ? {} : { clientEmail: input.clientEmail }),
        ...(input.removalAddOn === undefined ? {} : { removalAddOn: input.removalAddOn }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      },
      createWriteSchema,
      { retry: false },
    );
  }

  async reprogramar(
    appointmentId: string,
    date: string,
    timeSlot: string,
  ): Promise<RescheduleResult> {
    return await this.post(
      "/assistant/appointments/reschedule",
      { appointmentId, date, timeSlot },
      rescheduleWriteSchema,
      { retry: false },
    );
  }

  async confirmarTransferencia(
    paymentId: string,
    verificationId: string,
  ): Promise<SimpleWriteResult> {
    return await this.post(
      "/assistant/transfers/confirm",
      { paymentId, verificationId },
      simpleWriteSchema,
      { retry: false },
    );
  }

  async rechazarTransferencia(
    paymentId: string,
    verificationId: string,
    reason: string,
  ): Promise<SimpleWriteResult> {
    return await this.post(
      "/assistant/transfers/reject",
      { paymentId, verificationId, reason },
      simpleWriteSchema,
      { retry: false },
    );
  }

  private async post<T>(
    path: string,
    body: Record<string, unknown>,
    schema: z.ZodType<T>,
    options: RequestOptions,
  ): Promise<T> {
    const attempts = options.retry ? 2 : 1;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.attempt(path, body, schema);
      } catch (error) {
        if (attempt >= attempts || !isRetryable(error)) throw error;
        await delay(this.retryDelayMs);
      }
    }
  }

  private async attempt<T>(
    path: string,
    body: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    return await withSpan(
      "http.request",
      { backend: "turnos", "http.request.method": "POST", "url.path": path },
      () => this.attemptInner(path, body, schema),
    );
  }

  private async attemptInner<T>(
    path: string,
    body: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "x-request-id": this.requestIdFactory(),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new TurnosTimeoutError(`POST ${path} timed out after ${this.timeoutMs}ms`, {
          cause: error,
        });
      }
      throw new TurnosNetworkError(`POST ${path} failed: ${messageOf(error)}`, { cause: error });
    } finally {
      clearTimeout(timer);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new TurnosNetworkError(`POST ${path} response could not be read`, { cause: error });
    }

    if (!response.ok) {
      const message = serverMessage(text, `POST ${path} failed with ${response.status}`);
      if (response.status === 401) throw new TurnosAuthError(message);
      if (response.status === 503 && /not configured/i.test(message)) {
        throw new TurnosNotConfiguredError(message);
      }
      if (response.status === 400) throw new TurnosRequestError(message);
      throw new TurnosHttpError(response.status, message);
    }

    let payload: unknown;
    try {
      payload = text.trim().length === 0 ? null : JSON.parse(text);
    } catch (error) {
      throw new TurnosResponseError(`POST ${path} returned invalid JSON`, { cause: error });
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new TurnosResponseError(`POST ${path} response did not match the contract: ${detail}`);
    }
    return parsed.data;
  }
}
