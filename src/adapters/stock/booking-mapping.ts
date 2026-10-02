import type { StockServiceKey } from "./client.js";

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Maps a booking service (test-kimi slug or display name) to the mena-nails
 * service key. `retiro-*` ("Retiro Soft Gel", …) consumes no stock, so it maps
 * to nothing and the assistant must not register a service log for it.
 */
export function mapBookingServiceToStockKey(bookingService: string): StockServiceKey | undefined {
  const text = normalize(bookingService);
  if (text.includes("retiro")) return undefined;
  if (text.includes("soft") && text.includes("gel")) return "soft_gel";
  if (text.includes("capping")) return "capping";
  if (text.includes("semi")) return "semipermanente";
  return undefined;
}

/** Soft Gel is the only recipe that consumes tips (10, one shape/size). */
export function serviceRequiresTips(serviceKey: StockServiceKey): boolean {
  return serviceKey === "soft_gel";
}
