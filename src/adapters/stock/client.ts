/**
 * Shape of the mena-nails stock API (PRD 30b). Field names and enums match
 * `openapi/v1/openapi.yaml` on `Mateocas1/mena-nails` main.
 *
 * The API is authenticated with a non-interactive service credential
 * (`Authorization: Bearer svc_...`) and answers failures with sanitized plain
 * text. Service credentials may only call `GET /stock`, `GET|POST /services`
 * and `GET /services/prices`.
 */

export type StockQuantityModel = "tip" | "pieces" | "pots" | "container";
export type StockAlertState = "low" | "okay" | "disabled" | "unknown";
export type StockServiceKey = "soft_gel" | "capping" | "semipermanente";

export const STOCK_SERVICE_KEYS: readonly StockServiceKey[] = [
  "soft_gel",
  "capping",
  "semipermanente",
];

/** Exact tip units a Soft Gel service consumes (mena-nails recipe rule). */
export const SOFT_GEL_TIP_UNITS = 10;

export interface StockForecast {
  readonly state: "insufficient_evidence" | "low" | "medium" | "high";
  readonly dailyRate?: number;
  readonly depletionDate?: string;
}

/** `GET /stock` row: confirmed stock plus derived alert/forecast. */
export interface StockEntry {
  readonly itemId: number;
  readonly label: string;
  readonly quantityModel: StockQuantityModel;
  readonly alertPolicy: string;
  readonly alert: StockAlertState;
  readonly tipShape: string | null;
  readonly tipSize: number | null;
  readonly units: number | null;
  readonly closed: number | null;
  readonly openFraction: number | null;
  readonly confirmedAt: string | null;
  readonly version: number | null;
  readonly uncounted: boolean;
  readonly movementUnits?: number;
  readonly forecast?: StockForecast | null;
}

/** `GET /catalog/items` row (owner-only route today). */
export interface CatalogItem {
  readonly id: number;
  readonly displayLabel: string;
  readonly ownerIdentifier: string | null;
  readonly quantityModel: StockQuantityModel;
  readonly tipShape: string | null;
  readonly tipSize: number | null;
  readonly alertPolicy: string;
  readonly canonicalRole: string | null;
  readonly intakeCategory: string | null;
  readonly isColor: boolean;
}

/** `GET /services` row. */
export interface ServiceLog {
  readonly id: number;
  readonly serviceKey: string;
  readonly priceArs: number;
  readonly performedAt: string;
  readonly snapshot: {
    readonly service?: string;
    readonly colorLabel?: string;
    readonly colorItemId?: number;
    readonly tipAllocations?: readonly unknown[];
  };
}

/** `GET /services/prices` row. */
export interface ServicePrice {
  readonly serviceKey: string;
  readonly priceArs: number;
  readonly effectiveFrom: string;
  readonly createdAt: string;
}

export interface StockTipAllocation {
  readonly itemId: number;
  readonly units: number;
}

/** `POST /services` body. */
export interface ServiceLogInput {
  readonly serviceKey: StockServiceKey;
  readonly colorItemId: number;
  readonly tips?: readonly StockTipAllocation[];
  /** External idempotency key; the assistant sends the booking appointment id. */
  readonly sourceAppointmentId?: string;
}

/** `POST /services` response. */
export interface ServiceLogResult {
  readonly logId: number;
  readonly movements: readonly { readonly itemId: number; readonly unitsDelta: number }[];
  readonly replayed: boolean;
}

/**
 * Stock backend used by the `stock.*` tools. Reads are safe; `registrarServicio`
 * is the only write and is reached exclusively through a confirmed proposal.
 */
export interface StockBackend {
  /** `GET /stock`. */
  actual(): Promise<StockEntry[]>;
  /** `GET /stock` filtered to items currently below their threshold. */
  alertas(): Promise<StockEntry[]>;
  /** `GET /services?limit=N`. */
  serviciosRecientes(limit: number): Promise<ServiceLog[]>;
  /** `GET /services/prices`. */
  precios(): Promise<ServicePrice[]>;
  /** `GET /catalog/items` (owner-only on the API today). */
  catalogo(): Promise<CatalogItem[]>;
  /** `POST /services` (write; confirm-gated, idempotent on `sourceAppointmentId`). */
  registrarServicio(input: ServiceLogInput): Promise<ServiceLogResult>;
}

export const STOCK_FORBIDDEN_USER_MESSAGE =
  "La credencial del asistente no tiene permiso para esta operación de stock.";
export const STOCK_AUTH_USER_MESSAGE =
  "El asistente no pudo autenticarse con el sistema de stock. Avisá a Mateo.";
export const STOCK_CATALOG_FORBIDDEN_USER_MESSAGE =
  "El sistema de stock todavía no deja leer el catálogo con la credencial del asistente. Avisá a Mateo.";

export interface StockErrorOptions {
  readonly userMessage?: string;
  readonly cause?: unknown;
}

/** Base class: every stock adapter failure is a typed `StockError`. */
export class StockError extends Error {
  readonly userMessage: string | undefined;

  constructor(message: string, options: StockErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "StockError";
    this.userMessage = options.userMessage;
  }
}

export class StockHttpError extends StockError {
  readonly status: number;

  constructor(status: number, message: string, options: StockErrorOptions = {}) {
    super(message, options);
    this.name = "StockHttpError";
    this.status = status;
  }
}

export class StockAuthError extends StockHttpError {
  constructor(message = "unauthorized") {
    super(401, message, { userMessage: STOCK_AUTH_USER_MESSAGE });
    this.name = "StockAuthError";
  }
}

export class StockForbiddenError extends StockHttpError {
  readonly path: string;

  constructor(path: string, message = "forbidden") {
    super(403, message, {
      userMessage: path.includes("catalog")
        ? STOCK_CATALOG_FORBIDDEN_USER_MESSAGE
        : STOCK_FORBIDDEN_USER_MESSAGE,
    });
    this.name = "StockForbiddenError";
    this.path = path;
  }
}

/** 409: the same `sourceAppointmentId` was already used with a different payload. */
export class StockConflictError extends StockHttpError {
  constructor(message: string) {
    super(409, message, {
      userMessage:
        "Ese turno ya tenía un servicio registrado con otros datos. No cambié nada: revisá el registro antes de reintentar.",
    });
    this.name = "StockConflictError";
  }
}

export class StockRequestError extends StockHttpError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = "StockRequestError";
  }
}

export class StockResponseError extends StockError {
  constructor(message: string, options: StockErrorOptions = {}) {
    super(message, options);
    this.name = "StockResponseError";
  }
}

export class StockNetworkError extends StockError {
  constructor(message: string, options: StockErrorOptions = {}) {
    super(message, options);
    this.name = "StockNetworkError";
  }
}

export class StockTimeoutError extends StockError {
  constructor(message: string, options: StockErrorOptions = {}) {
    super(message, options);
    this.name = "StockTimeoutError";
  }
}
