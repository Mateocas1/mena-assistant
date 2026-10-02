import type { CatalogItem, ServiceLog, ServicePrice, StockEntry } from "./client.js";

/** Fixture-only: the threshold the mock uses to derive `alert`. */
export interface FixtureStockEntry extends StockEntry {
  readonly lowThreshold: number;
}

export interface StockFixtures {
  readonly catalog: readonly CatalogItem[];
  readonly stock: readonly FixtureStockEntry[];
  readonly prices: readonly ServicePrice[];
  readonly logs: readonly (ServiceLog & { readonly sourceAppointmentId?: string })[];
}

const CONFIRMED_AT = "2026-01-13T11:00:00Z";

function container(
  id: number,
  label: string,
  units: number,
  lowThreshold: number,
  isColor: boolean,
  canonicalRole: string | null = null,
): { catalog: CatalogItem; stock: FixtureStockEntry } {
  return {
    catalog: {
      id,
      displayLabel: label,
      ownerIdentifier: null,
      quantityModel: "container",
      tipShape: null,
      tipSize: null,
      alertPolicy: isColor || canonicalRole !== null ? "closed_container_reserve" : "disabled",
      canonicalRole,
      intakeCategory: null,
      isColor,
    },
    stock: {
      itemId: id,
      label,
      quantityModel: "container",
      alertPolicy: "closed_container_reserve",
      alert: units <= lowThreshold ? "low" : "okay",
      tipShape: null,
      tipSize: null,
      units,
      closed: units,
      openFraction: null,
      confirmedAt: CONFIRMED_AT,
      version: 1,
      uncounted: false,
      movementUnits: 0,
      forecast: null,
      lowThreshold,
    },
  };
}

function tips(
  id: number,
  shape: string,
  size: number,
  units: number,
): { catalog: CatalogItem; stock: FixtureStockEntry } {
  return {
    catalog: {
      id,
      displayLabel: `Tips ${shape} ${size}`,
      ownerIdentifier: null,
      quantityModel: "tip",
      tipShape: shape,
      tipSize: size,
      alertPolicy: "exact_units",
      canonicalRole: null,
      intakeCategory: null,
      isColor: false,
    },
    stock: {
      itemId: id,
      label: `Tips ${shape} ${size}`,
      quantityModel: "tip",
      alertPolicy: "exact_units",
      alert: units <= 20 ? "low" : "okay",
      tipShape: shape,
      tipSize: size,
      units,
      closed: units,
      openFraction: null,
      confirmedAt: CONFIRMED_AT,
      version: 1,
      uncounted: false,
      movementUnits: 0,
      forecast: { state: "insufficient_evidence" },
      lowThreshold: 20,
    },
  };
}

const ENTRIES = [
  container(1, "City 22", 6, 2, true),
  container(2, "Nude Glitter 118", 1, 2, true),
  container(3, "Base", 4, 2, false, "base"),
  container(4, "Top", 9, 2, false, "top"),
  tips(10, "almond", 5, 100),
  tips(11, "almond", 6, 15),
  tips(12, "square", 4, 60),
];

/** Catalog/stock/prices/logs mirroring the mena-nails seeded catalog. */
export const STOCK_FIXTURES: StockFixtures = {
  catalog: ENTRIES.map((entry) => entry.catalog),
  stock: ENTRIES.map((entry) => entry.stock),
  prices: [
    {
      serviceKey: "soft_gel",
      priceArs: 25000,
      effectiveFrom: "2026-01-01",
      createdAt: CONFIRMED_AT,
    },
    {
      serviceKey: "capping",
      priceArs: 23000,
      effectiveFrom: "2026-01-01",
      createdAt: CONFIRMED_AT,
    },
    {
      serviceKey: "semipermanente",
      priceArs: 21000,
      effectiveFrom: "2026-01-01",
      createdAt: CONFIRMED_AT,
    },
  ],
  logs: [
    {
      id: 99,
      serviceKey: "capping",
      priceArs: 23000,
      performedAt: "2026-01-12T13:00:00Z",
      sourceAppointmentId: "apt_previous_1400",
      snapshot: { service: "capping", colorLabel: "City 22", colorItemId: 1, tipAllocations: [] },
    },
  ],
};
