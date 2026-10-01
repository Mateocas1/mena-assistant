import { describe, expect, it } from "vitest";
import { createTurnosFixtures } from "../src/adapters/turnos/fixtures.js";
import { MockTurnosBackend } from "../src/adapters/turnos/mock.js";
import { TurnosNotFoundError } from "../src/adapters/turnos/client.js";

const REFERENCE = "2026-01-14"; // Wednesday
const fixtures = createTurnosFixtures(REFERENCE);

describe("MockTurnosBackend (mirrors the 30a contract shapes)", () => {
  it("returns the appointments of one ART day, sorted by time slot", async () => {
    const backend = new MockTurnosBackend(fixtures);
    const appointments = await backend.delDia(REFERENCE);

    expect(appointments.map((appointment) => appointment.timeSlot)).toEqual([
      "08:00",
      "14:00",
      "18:30",
    ]);
    expect(appointments[0]).toEqual({
      id: "apt_today_0800",
      date: REFERENCE,
      timeSlot: "08:00",
      status: "confirmed",
      serviceName: "Servicio Soft Gel",
      clientName: "Ana G.",
    });
    // Cancelled appointments are still listed (the backend returns raw rows).
    expect(appointments.map((appointment) => appointment.status)).toContain("cancelled");
  });

  it("returns an empty list for a day with no appointments", async () => {
    const backend = new MockTurnosBackend(fixtures);
    await expect(backend.delDia("2026-06-01")).resolves.toEqual([]);
  });

  it("computes availability from active appointments and blocks", async () => {
    const backend = new MockTurnosBackend(fixtures);
    const slots = await backend.disponibilidad(REFERENCE);

    // Reference blocks 16:30; 08:00 and 14:00 are taken by active appointments.
    expect(slots).toEqual([
      { time: "08:00", available: false },
      { time: "11:00", available: true },
      { time: "14:00", available: false },
      { time: "16:30", available: false },
      { time: "18:30", available: true },
    ]);
  });

  it("returns the canonical service catalog", async () => {
    const backend = new MockTurnosBackend(fixtures);
    const services = await backend.servicios();

    expect(services).toHaveLength(6);
    expect(services[0]).toEqual({
      slug: "retiro-capping",
      name: "Retiro Capping",
      price: 7000,
      durationMinutes: 40,
    });
  });

  it("cancels an appointment and reports the admin cancellation outcome", async () => {
    const backend = new MockTurnosBackend(fixtures);
    const result = await backend.cancelar("apt_today_0800", "indicación de la clienta");

    expect(result).toEqual({
      success: true,
      refunded: false,
      refundRequired: true,
      refundReason: "admin_cancellation",
      depositRetained: false,
    });

    const after = await backend.delDia(REFERENCE);
    expect(after.find((appointment) => appointment.id === "apt_today_0800")?.status).toBe(
      "cancelled",
    );
  });

  it("does not mutate the shared fixtures", async () => {
    const backend = new MockTurnosBackend(fixtures);
    await backend.cancelar("apt_today_1400");
    const fresh = new MockTurnosBackend(fixtures);
    const freshList = await fresh.delDia(REFERENCE);
    expect(freshList.find((appointment) => appointment.id === "apt_today_1400")?.status).toBe(
      "paid",
    );
  });

  it("rejects an unknown appointment id", async () => {
    const backend = new MockTurnosBackend(fixtures);
    await expect(backend.cancelar("apt_nope")).rejects.toBeInstanceOf(TurnosNotFoundError);
  });

  it("rejects cancelling an appointment that is already cancelled", async () => {
    const backend = new MockTurnosBackend(fixtures);
    await expect(backend.cancelar("apt_cancelled_today")).rejects.toThrow(/cannot cancel/i);
  });
});

describe("MockTurnosBackend M1 reads", () => {
  it("returns a date range sorted by day and slot, without the deposit", async () => {
    const backend = new MockTurnosBackend(fixtures);
    const range = await backend.rango(REFERENCE, "2026-01-15");

    expect(range.map((appointment) => `${appointment.date} ${appointment.timeSlot}`)).toEqual([
      "2026-01-14 08:00",
      "2026-01-14 14:00",
      "2026-01-14 18:30",
      "2026-01-15 11:00",
      "2026-01-15 16:30",
    ]);
    expect(range[0]).toEqual({
      id: "apt_today_0800",
      date: REFERENCE,
      timeSlot: "08:00",
      status: "confirmed",
      serviceName: "Servicio Soft Gel",
      clientName: "Ana G.",
    });
    expect(Object.keys(range[0] ?? {})).not.toContain("depositPrice");
  });

  it("returns only non-terminal verifications plus the refund queue", async () => {
    const backend = new MockTurnosBackend(fixtures);
    const pending = await backend.pagosPendientes();

    expect(pending.verificaciones.map((verification) => verification.status)).toEqual([
      "pending",
      "failed",
    ]);
    expect(pending.verificaciones[0]).toMatchObject({ id: "ver_today_pending", amount: 12500 });
    expect(pending.reintegros).toEqual({
      count: 1,
      totalAmount: 5000,
      byReason: { admin_cancellation: 1 },
    });
  });

  it("summarises a day like the backend does", async () => {
    const backend = new MockTurnosBackend(fixtures);
    const summary = await backend.resumen(REFERENCE);

    expect(summary).toEqual({
      date: REFERENCE,
      totalAppointments: 3,
      counts: { confirmed: 1, paid: 1, cancelled: 1 },
      revenue: 24000,
      pendingVerifications: 2,
      refundsPending: 1,
    });
  });

  it("summarises an empty day", async () => {
    const backend = new MockTurnosBackend(fixtures);
    const summary = await backend.resumen("2026-06-01");
    expect(summary.totalAppointments).toBe(0);
    expect(summary.counts).toEqual({});
    expect(summary.revenue).toBe(0);
  });
});
