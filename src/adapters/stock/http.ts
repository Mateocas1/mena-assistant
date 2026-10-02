import { z } from "zod";
import { withSpan } from "../../telemetry/tracer.js";
import {
  StockAuthError,
  StockConflictError,
  StockForbiddenError,
  StockHttpError,
  StockNetworkError,
  StockRequestError,
  StockResponseError,
  StockTimeoutError,
  type CatalogItem,
  type ServiceLog,
  type ServiceLogInput,
  type ServiceLogResult,
  type ServicePrice,
  type StockBackend,
  type StockEntry,
} from "./client.js";

/* ───────────────────────────────────────────────
   Response schemas (mena-nails openapi/v1)
   ─────────────────────────────────────────────── */

const quantityModelSchema = z.enum(["tip", "pieces", "pots", "container"]);
const alertSchema = z.enum(["low", "okay", "disabled", "unknown"]);

const forecastSchema = z.object({
  state: z.enum(["insufficient_evidence", "low", "medium", "high"]),
  dailyRate: z.number().optional(),
  depletionDate: z.string().optional(),
});

const stockEntrySchema = z.object({
  itemId: z.number(),
  label: z.string(),
  quantityModel: quantityModelSchema,
  alertPolicy: z.string(),
  alert: alertSchema,
  tipShape: z.string().nullable(),
  tipSize: z.number().nullable(),
  units: z.number().nullable(),
  closed: z.number().nullable(),
  openFraction: z.number().nullable(),
  confirmedAt: z.string().nullable(),
  version: z.number().nullable(),
  uncounted: z.boolean(),
  movementUnits: z.number().optional(),
  forecast: forecastSchema.nullable().optional(),
});

const stockResponseSchema = z.object({ items: z.array(stockEntrySchema) });

const catalogItemSchema = z.object({
  id: z.number(),
  displayLabel: z.string(),
  ownerIdentifier: z.string().nullable(),
  quantityModel: quantityModelSchema,
  tipShape: z.string().nullable(),
  tipSize: z.number().nullable(),
  alertPolicy: z.string(),
  canonicalRole: z.string().nullable(),
  intakeCategory: z.string().nullable(),
  isColor: z.boolean(),
});

const serviceLogSchema = z.object({
  id: z.number(),
  serviceKey: z.string(),
  priceArs: z.number(),
  performedAt: z.string(),
  snapshot: z.object({
    service: z.string().optional(),
    colorLabel: z.string().optional(),
    colorItemId: z.number().optional(),
    tipAllocations: z.array(z.unknown()).optional(),
  }),
});

const serviceLogsResponseSchema = z.object({ logs: z.array(serviceLogSchema) });

const servicePriceSchema = z.object({
  serviceKey: z.string(),
  priceArs: z.number(),
  effectiveFrom: z.string(),
  createdAt: z.string(),
});

const servicePricesResponseSchema = z.object({ prices: z.array(servicePriceSchema) });

const serviceCreateResponseSchema = z.object({
  logId: z.number(),
  movements: z.array(z.object({ itemId: z.number(), unitsDelta: z.number() })),
  replayed: z.boolean(),
});

export type StockFetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpStockClientOptions {
  /** mena-nails API origin, e.g. `http://api:8080` on the VM network. */
  readonly baseUrl: string;
  /** Service credential (`svc_...`) whose digest is in `API_SERVICE_TOKENS`. */
  readonly token: string;
  readonly timeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly fetchImpl?: StockFetchLike;
}

interface RequestOptions {
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

function isRetryable(error: unknown): boolean {
  if (error instanceof StockNetworkError || error instanceof StockTimeoutError) return true;
  return error instanceof StockHttpError && error.status >= 500;
}

/**
 * Real mena-nails stock client. Reads retry once on 5xx or a network failure,
 * writes never retry, every response is validated, and failures keep the
 * backend's sanitized plain-text message.
 */
export class HttpStockClient implements StockBackend {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: StockFetchLike;

  constructor(options: HttpStockClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async actual(): Promise<StockEntry[]> {
    return (await this.request("GET", "/stock", stockResponseSchema, { retry: true })).items;
  }

  async alertas(): Promise<StockEntry[]> {
    const items = await this.actual();
    return items.filter((item) => item.alert === "low");
  }

  async serviciosRecientes(limit: number): Promise<ServiceLog[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    return (
      await this.request("GET", `/services?limit=${safeLimit}`, serviceLogsResponseSchema, {
        retry: true,
      })
    ).logs;
  }

  async precios(): Promise<ServicePrice[]> {
    return (
      await this.request("GET", "/services/prices", servicePricesResponseSchema, { retry: true })
    ).prices;
  }

  async catalogo(): Promise<CatalogItem[]> {
    return await this.request("GET", "/catalog/items", z.array(catalogItemSchema), { retry: true });
  }

  async registrarServicio(input: ServiceLogInput): Promise<ServiceLogResult> {
    // Writes never retry: the backend is idempotent on sourceAppointmentId, but a
    // retry from here could still double-report a conflict as a success.
    return await this.request(
      "POST",
      "/services",
      serviceCreateResponseSchema,
      { retry: false },
      {
        serviceKey: input.serviceKey,
        colorItemId: input.colorItemId,
        ...(input.tips === undefined ? {} : { tips: input.tips.map((tip) => ({ ...tip })) }),
        ...(input.sourceAppointmentId === undefined
          ? {}
          : { sourceAppointmentId: input.sourceAppointmentId }),
      },
    );
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    schema: z.ZodType<T>,
    options: RequestOptions,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const attempts = options.retry ? 2 : 1;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.attempt(method, path, schema, body);
      } catch (error) {
        if (attempt >= attempts || !isRetryable(error)) throw error;
        await delay(this.retryDelayMs);
      }
    }
  }

  private async attempt<T>(
    method: "GET" | "POST",
    path: string,
    schema: z.ZodType<T>,
    body?: Record<string, unknown>,
  ): Promise<T> {
    return await withSpan(
      "http.request",
      { backend: "stock", "http.request.method": method, "url.path": path },
      () => this.attemptInner(method, path, schema, body),
    );
  }

  private async attemptInner<T>(
    method: "GET" | "POST",
    path: string,
    schema: z.ZodType<T>,
    body?: Record<string, unknown>,
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
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new StockTimeoutError(`${method} ${path} timed out after ${this.timeoutMs}ms`, {
          cause: error,
        });
      }
      throw new StockNetworkError(`${method} ${path} failed: ${messageOf(error)}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new StockNetworkError(`${method} ${path} response could not be read`, { cause: error });
    }

    if (!response.ok) {
      // mena-nails answers with sanitized plain text, never JSON.
      const message = text.trim().length > 0 ? text.trim() : `${method} ${path} failed`;
      if (response.status === 401) throw new StockAuthError(message);
      if (response.status === 403) throw new StockForbiddenError(path, message);
      if (response.status === 409) throw new StockConflictError(message);
      if (response.status === 400 || response.status === 415) {
        throw new StockRequestError(response.status, message);
      }
      throw new StockHttpError(response.status, message, {
        ...(response.status >= 500
          ? { userMessage: "El sistema de stock no está disponible. Probá de nuevo en un momento." }
          : {}),
      });
    }

    let payload: unknown;
    try {
      payload = text.trim().length === 0 ? null : JSON.parse(text);
    } catch (error) {
      throw new StockResponseError(`${method} ${path} returned invalid JSON`, { cause: error });
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new StockResponseError(
        `${method} ${path} response did not match the contract: ${detail}`,
      );
    }
    return parsed.data;
  }
}
