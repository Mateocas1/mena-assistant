import { describe, expect, it } from "vitest";
import { createTurnosFixtures } from "../src/adapters/turnos/fixtures.js";
import { MockTurnosBackend } from "../src/adapters/turnos/mock.js";
import { TurnosError, TurnosNotFoundError } from "../src/adapters/turnos/client.js";
import { fixedClock } from "../src/time/index.js";

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

describe("MockTurnosBackend writes", () => {
  // 01:30 UTC is 22:30 on 2026-01-14 in Buenos Aires (the fixtures' "today").
  const clock = fixedClock("2026-01-15T01:30:00Z");
  const makeBackend = () => new MockTurnosBackend(fixtures, { clock });

  it("completes a past confirmed appointment only", async () => {
    const backend = makeBackend();

    await expect(backend.marcarCompletado("apt_past_0800")).resolves.toEqual({ success: true });
    const past = await backend.delDia("2026-01-07");
    expect(past[0]?.status).toBe("completed");

    await expect(backend.marcarCompletado("apt_today_0800")).rejects.toThrow(/not arrived yet/i);
    await expect(backend.marcarCompletado("apt_cancelled_today")).rejects.toThrow(
      /only confirmed/i,
    );
    await expect(backend.marcarCompletado("apt_nope")).rejects.toBeInstanceOf(TurnosNotFoundError);
  });

  it("blocks and unblocks a day or a single slot", async () => {
    const backend = makeBackend();

    const day = await backend.bloquear({ date: "2026-01-20", isFullDay: true, reason: "feriado" });
    expect(day.blockedSlotId).toBe("blk_1");
    expect((await backend.disponibilidad("2026-01-20")).every((slot) => !slot.available)).toBe(
      true,
    );

    const slot = await backend.bloquear({
      date: "2026-01-21",
      timeSlot: "11:00",
      isFullDay: false,
    });
    const availability = await backend.disponibilidad("2026-01-21");
    expect(availability.find((entry) => entry.time === "11:00")?.available).toBe(false);
    expect(availability.find((entry) => entry.time === "14:00")?.available).toBe(true);

    await backend.desbloquear(slot.blockedSlotId);
    expect(
      (await backend.disponibilidad("2026-01-21")).find((entry) => entry.time === "11:00")
        ?.available,
    ).toBe(true);

    await expect(backend.desbloquear("blk_nope")).rejects.toBeInstanceOf(TurnosNotFoundError);
  });

  it("creates an appointment for a client and rejects a taken slot", async () => {
    const backend = makeBackend();

    const created = await backend.crearParaClienta({
      clientName: "Ana Gomez",
      clientPhone: "1145556666",
      serviceSlug: "servicio-softgel",
      date: "2026-01-20",
      timeSlot: "16:30",
    });

    expect(created.success).toBe(true);
    const day = await backend.delDia("2026-01-20");
    expect(day).toEqual([
      {
        id: created.appointmentId,
        date: "2026-01-20",
        timeSlot: "16:30",
        status: "pending",
        serviceName: "Servicio Soft Gel",
        clientName: "Ana G.",
      },
    ]);

    await expect(
      backend.crearParaClienta({
        clientName: "Otra",
        clientPhone: "1145556667",
        serviceSlug: "servicio-softgel",
        date: "2026-01-20",
        timeSlot: "16:30",
      }),
    ).rejects.toThrow(/ya está ocupado/i);

    await expect(
      backend.crearParaClienta({
        clientName: "Otra",
        clientPhone: "1145556667",
        serviceSlug: "servicio-inexistente",
        date: "2026-01-20",
        timeSlot: "11:00",
      }),
    ).rejects.toThrow(TurnosError);
  });

  it("reschedules onto a free slot and refuses a taken one", async () => {
    const backend = makeBackend();

    const moved = await backend.reprogramar("apt_today_0800", "2026-01-20", "11:00");
    expect(moved).toEqual({
      success: true,
      appointmentId: "apt_today_0800",
      date: "2026-01-20",
      timeSlot: "11:00",
    });
    expect((await backend.delDia(REFERENCE)).map((a) => a.id)).not.toContain("apt_today_0800");
    expect((await backend.delDia("2026-01-20")).map((a) => a.id)).toEqual(["apt_today_0800"]);

    await expect(backend.reprogramar("apt_tomorrow_1100", "2026-01-20", "11:00")).rejects.toThrow(
      /ya está ocupado/i,
    );
    await expect(backend.reprogramar("apt_cancelled_today", "2026-01-20", "14:00")).rejects.toThrow(
      /cannot reschedule/i,
    );
  });

  it("confirms and rejects transfers, clearing them from the pending list", async () => {
    const backend = makeBackend();

    await backend.confirmarTransferencia("pay_today_pending", "ver_today_pending");
    await backend.rechazarTransferencia("pay_today_failed", "ver_today_failed", "no coincide");

    const pending = await backend.pagosPendientes();
    expect(pending.verificaciones).toEqual([]);

    await expect(backend.confirmarTransferencia("pay_x", "ver_nope")).rejects.toBeInstanceOf(
      TurnosNotFoundError,
    );
  });
});
