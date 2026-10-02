import { describe, expect, it } from "vitest";
import {
  mapBookingServiceToStockKey,
  serviceRequiresTips,
} from "../src/adapters/stock/booking-mapping.js";
import { StockConflictError, StockRequestError } from "../src/adapters/stock/client.js";
import { MockStockBackend } from "../src/adapters/stock/mock.js";

function unitsOf(entries: readonly { itemId: number; units: number | null }[], itemId: number) {
  return entries.find((entry) => entry.itemId === itemId)?.units;
}

describe("booking service → stock service key", () => {
  it("maps the served services and ignores removals", () => {
    expect(mapBookingServiceToStockKey("Servicio Soft Gel")).toBe("soft_gel");
    expect(mapBookingServiceToStockKey("servicio-softgel")).toBe("soft_gel");
    expect(mapBookingServiceToStockKey("Servicio Capping")).toBe("capping");
    expect(mapBookingServiceToStockKey("servicio-capping")).toBe("capping");
    expect(mapBookingServiceToStockKey("Servicio Semipermanente")).toBe("semipermanente");
    expect(mapBookingServiceToStockKey("servicio-semi")).toBe("semipermanente");

    // Removals consume no stock, so nothing is registered for them.
    expect(mapBookingServiceToStockKey("Retiro Soft Gel")).toBeUndefined();
    expect(mapBookingServiceToStockKey("retiro-capping")).toBeUndefined();
    expect(mapBookingServiceToStockKey("Retiro Semipermanente")).toBeUndefined();
    expect(mapBookingServiceToStockKey("Algo raro")).toBeUndefined();
  });

  it("only Soft Gel consumes tips", () => {
    expect(serviceRequiresTips("soft_gel")).toBe(true);
    expect(serviceRequiresTips("capping")).toBe(false);
    expect(serviceRequiresTips("semipermanente")).toBe(false);
  });
});

describe("MockStockBackend", () => {
  it("derives alerts from the confirmed units", async () => {
    const backend = new MockStockBackend();

    const alerts = await backend.alertas();
    expect(alerts.map((entry) => entry.itemId).sort((a, b) => a - b)).toEqual([2, 11]);
    expect(alerts.every((entry) => entry.alert === "low")).toBe(true);

    const all = await backend.actual();
    expect(all).toHaveLength(7);
    expect(all.find((entry) => entry.itemId === 4)?.alert).toBe("okay");
  });

  it("serves recent logs newest first and the price history", async () => {
    const backend = new MockStockBackend();
    expect((await backend.serviciosRecientes(10)).map((log) => log.id)).toEqual([99]);
    expect((await backend.precios()).map((price) => price.serviceKey)).toEqual([
      "soft_gel",
      "capping",
      "semipermanente",
    ]);
    expect(await backend.catalogo()).toHaveLength(7);
  });

  it("consumes the colour and the tips once per service", async () => {
    const backend = new MockStockBackend();

    const result = await backend.registrarServicio({
      serviceKey: "soft_gel",
      colorItemId: 1,
      tips: [{ itemId: 10, units: 10 }],
      sourceAppointmentId: "apt_today_0800",
    });

    expect(result.replayed).toBe(false);
    expect(result.movements).toEqual([
      { itemId: 1, unitsDelta: -1 },
      { itemId: 10, unitsDelta: -10 },
    ]);

    const after = await backend.actual();
    expect(unitsOf(after, 1)).toBe(5);
    expect(unitsOf(after, 10)).toBe(90);
    expect(unitsOf(after, 10) !== null && after.find((e) => e.itemId === 10)?.movementUnits).toBe(
      -10,
    );
  });

  it("replays an identical retry without consuming twice", async () => {
    const backend = new MockStockBackend();
    const input = {
      serviceKey: "soft_gel" as const,
      colorItemId: 1,
      tips: [{ itemId: 10, units: 10 }],
      sourceAppointmentId: "apt_today_0800",
    };

    const first = await backend.registrarServicio(input);
    const before = await backend.actual();
    const second = await backend.registrarServicio(input);
    const after = await backend.actual();

    expect(second.replayed).toBe(true);
    expect(second.logId).toBe(first.logId);
    expect(after).toEqual(before);
  });

  it("refuses the same appointment with a different payload", async () => {
    const backend = new MockStockBackend();
    await backend.registrarServicio({
      serviceKey: "semipermanente",
      colorItemId: 1,
      sourceAppointmentId: "apt_today_0800",
    });

    await expect(
      backend.registrarServicio({
        serviceKey: "capping",
        colorItemId: 2,
        sourceAppointmentId: "apt_today_0800",
      }),
    ).rejects.toBeInstanceOf(StockConflictError);
  });

  it("enforces the recipe rules", async () => {
    const backend = new MockStockBackend();

    await expect(
      backend.registrarServicio({
        serviceKey: "soft_gel",
        colorItemId: 1,
        tips: [{ itemId: 10, units: 9 }],
      }),
    ).rejects.toBeInstanceOf(StockRequestError);

    await expect(
      backend.registrarServicio({
        serviceKey: "capping",
        colorItemId: 1,
        tips: [{ itemId: 10, units: 10 }],
      }),
    ).rejects.toBeInstanceOf(StockRequestError);

    // Item 3 ("Base") is a container but not a colour.
    await expect(
      backend.registrarServicio({ serviceKey: "capping", colorItemId: 3 }),
    ).rejects.toBeInstanceOf(StockRequestError);

    // Item 4 ("Top") is not a tip.
    await expect(
      backend.registrarServicio({
        serviceKey: "soft_gel",
        colorItemId: 1,
        tips: [{ itemId: 4, units: 10 }],
      }),
    ).rejects.toBeInstanceOf(StockRequestError);
  });

  it("does not share state between instances", async () => {
    const backend = new MockStockBackend();
    await backend.registrarServicio({ serviceKey: "capping", colorItemId: 1 });

    const fresh = await new MockStockBackend().actual();
    expect(unitsOf(fresh, 1)).toBe(6);
  });
});
