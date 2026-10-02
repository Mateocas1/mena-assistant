import {
  SOFT_GEL_TIP_UNITS,
  STOCK_SERVICE_KEYS,
  StockConflictError,
  StockError,
  StockRequestError,
  type CatalogItem,
  type ServiceLog,
  type ServiceLogInput,
  type ServiceLogResult,
  type ServicePrice,
  type StockBackend,
  type StockEntry,
} from "./client.js";
import { STOCK_FIXTURES, type FixtureStockEntry, type StockFixtures } from "./fixtures.js";

export interface MockStockBackendOptions {
  readonly fixtures?: StockFixtures;
}

function toEntry(row: FixtureStockEntry): StockEntry {
  const { lowThreshold: _lowThreshold, ...entry } = row;
  return { ...entry };
}

/**
 * In-memory stock backend with the same semantics as mena-nails: alerts are
 * derived, and `POST /services` is idempotent on `sourceAppointmentId`
 * (identical retry replays, different payload conflicts).
 */
export class MockStockBackend implements StockBackend {
  private readonly fixtures: StockFixtures;
  private stock: FixtureStockEntry[];
  private logs: (ServiceLog & { readonly sourceAppointmentId?: string })[];
  private nextLogId: number;

  constructor(options: MockStockBackendOptions = {}) {
    this.fixtures = options.fixtures ?? STOCK_FIXTURES;
    this.stock = this.fixtures.stock.map((entry) => ({ ...entry }));
    this.logs = this.fixtures.logs.map((log) => ({ ...log }));
    this.nextLogId = Math.max(0, ...this.logs.map((log) => log.id)) + 1;
  }

  async actual(): Promise<StockEntry[]> {
    return this.stock.map((row) => toEntry(this.withAlert(row)));
  }

  async alertas(): Promise<StockEntry[]> {
    return (await this.actual()).filter((entry) => entry.alert === "low");
  }

  async serviciosRecientes(limit: number): Promise<ServiceLog[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    return [...this.logs]
      .sort((left, right) => right.performedAt.localeCompare(left.performedAt))
      .slice(0, safeLimit)
      .map((log) => ({ ...log }));
  }

  async precios(): Promise<ServicePrice[]> {
    return this.fixtures.prices.map((price) => ({ ...price }));
  }

  async catalogo(): Promise<CatalogItem[]> {
    return this.fixtures.catalog.map((item) => ({ ...item }));
  }

  async registrarServicio(input: ServiceLogInput): Promise<ServiceLogResult> {
    this.assertRequest(input);

    const source = input.sourceAppointmentId;
    if (source) {
      const existing = this.logs.find((log) => log.sourceAppointmentId === source);
      if (existing) {
        if (!this.samePayload(existing, input)) {
          throw new StockConflictError(
            "the source appointment already has a service log with a different payload",
          );
        }
        return { logId: existing.id, movements: [], replayed: true };
      }
    }

    const movements = this.applyConsumption(input);
    const log: ServiceLog & { sourceAppointmentId?: string } = {
      id: this.nextLogId++,
      serviceKey: input.serviceKey,
      priceArs:
        this.fixtures.prices.find((price) => price.serviceKey === input.serviceKey)?.priceArs ?? 0,
      performedAt: new Date().toISOString(),
      snapshot: {
        service: input.serviceKey,
        colorLabel: this.stock.find((row) => row.itemId === input.colorItemId)?.label ?? "",
        colorItemId: input.colorItemId,
        tipAllocations: (input.tips ?? []).map((tip) => ({ ...tip })),
      },
      ...(source === undefined ? {} : { sourceAppointmentId: source }),
    };
    this.logs.push(log);

    return { logId: log.id, movements, replayed: false };
  }

  /* ── internals ──────────────────────────────────────────────────────────── */

  private assertRequest(input: ServiceLogInput): void {
    if (!STOCK_SERVICE_KEYS.includes(input.serviceKey)) {
      throw new StockRequestError(400, "unsupported service key");
    }
    const color = this.stock.find((row) => row.itemId === input.colorItemId);
    const colorItem = this.fixtures.catalog.find((item) => item.id === input.colorItemId);
    if (!color || !colorItem || color.quantityModel !== "container" || !colorItem.isColor) {
      throw new StockRequestError(400, "the selected color is invalid");
    }

    const tips = input.tips ?? [];
    if (input.serviceKey === "soft_gel") {
      const total = tips.reduce((sum, tip) => sum + tip.units, 0);
      if (tips.length === 0 || total !== SOFT_GEL_TIP_UNITS) {
        throw new StockRequestError(400, "Soft Gel requires exactly ten allocated tips");
      }
      for (const tip of tips) {
        const item = this.fixtures.catalog.find((candidate) => candidate.id === tip.itemId);
        if (!item || item.quantityModel !== "tip" || tip.units <= 0) {
          throw new StockRequestError(400, "invalid tip allocation");
        }
      }
    } else if (tips.length > 0) {
      throw new StockRequestError(400, "tip allocations require Soft Gel");
    }
  }

  private samePayload(
    log: ServiceLog & { readonly sourceAppointmentId?: string },
    input: ServiceLogInput,
  ): boolean {
    if (log.serviceKey !== input.serviceKey) return false;
    if (log.snapshot.colorItemId !== input.colorItemId) return false;
    const existingTips = JSON.stringify(
      (log.snapshot.tipAllocations ?? []) as { itemId: number; units: number }[],
    );
    const incomingTips = JSON.stringify(
      (input.tips ?? []).map((tip) => ({ itemId: tip.itemId, units: tip.units })),
    );
    return existingTips === incomingTips;
  }

  private applyConsumption(input: ServiceLogInput): { itemId: number; unitsDelta: number }[] {
    const movements: { itemId: number; unitsDelta: number }[] = [];
    const consume = (itemId: number, units: number): void => {
      const index = this.stock.findIndex((row) => row.itemId === itemId);
      const row = this.stock[index];
      if (index === -1 || !row) throw new StockError(`unknown stock item ${itemId}`);
      const current = row.units ?? 0;
      const next = Math.max(0, current - units);
      this.stock[index] = {
        ...row,
        units: next,
        closed: row.quantityModel === "container" ? next : row.closed,
        movementUnits: (row.movementUnits ?? 0) - units,
      };
      movements.push({ itemId, unitsDelta: -units });
    };

    // One colour unit plus, for Soft Gel, the allocated tips.
    consume(input.colorItemId, 1);
    for (const tip of input.tips ?? []) consume(tip.itemId, tip.units);
    return movements;
  }

  private withAlert(row: FixtureStockEntry): FixtureStockEntry {
    if (row.alertPolicy === "disabled") return { ...row, alert: "disabled" };
    if (row.units === null) return { ...row, alert: "unknown" };
    return { ...row, alert: row.units <= row.lowThreshold ? "low" : "okay" };
  }
}
