import { describe, expect, it } from "vitest";
import { ToolArgumentError, type WriteToolDefinition } from "../src/mcp/registry.js";
import { createTurnosTools } from "../src/mcp/tools/turnos.js";
import { makeTestContext, TEST_ART_DATE, TEST_CHAT_ID } from "./helpers/context.js";

const tools = createTurnosTools();
const delDia = tools.find((tool) => tool.name === "turnos.del_dia")!;
const rango = tools.find((tool) => tool.name === "turnos.rango")!;
const disponibilidad = tools.find((tool) => tool.name === "turnos.disponibilidad")!;
const servicios = tools.find((tool) => tool.name === "turnos.servicios")!;
const pagosPendientes = tools.find((tool) => tool.name === "turnos.pagos_pendientes")!;
const resumen = tools.find((tool) => tool.name === "turnos.resumen")!;
const cancelar = tools.find(
  (tool): tool is WriteToolDefinition => tool.name === "turnos.cancelar",
)!;

describe("turnos read tools", () => {
  it("uses the ART date for 'hoy' at 22:30 ART (01:30 UTC)", async () => {
    const { context } = makeTestContext();
    const result = await delDia.execute({}, context);
    const data = result.data as Array<{ date: string; id: string }>;

    expect(data.every((appointment) => appointment.date === TEST_ART_DATE)).toBe(true);
    expect(data.map((appointment) => appointment.id)).toEqual([
      "apt_today_0800",
      "apt_today_1400",
      "apt_cancelled_today",
    ]);
    expect(JSON.parse(result.content)).toMatchObject({ fecha: TEST_ART_DATE });
  });

  it("resolves 'mañana' relative to the ART day", async () => {
    const { context } = makeTestContext();
    const result = await delDia.execute({ fecha: "mañana" }, context);
    const data = result.data as Array<{ date: string }>;
    expect(data.every((appointment) => appointment.date === "2026-01-15")).toBe(true);
    expect(data).toHaveLength(2);
  });

  it("lists free and taken slots", async () => {
    const { context } = makeTestContext();
    const result = await disponibilidad.execute({ fecha: TEST_ART_DATE }, context);
    const parsed = JSON.parse(result.content) as { libres: string[] };
    expect(parsed.libres).toEqual(["11:00", "18:30"]);
  });

  it("lists the service catalog", async () => {
    const { context } = makeTestContext();
    const result = await servicios.execute({}, context);
    const data = result.data as Array<{ slug: string; price: number }>;
    expect(data).toHaveLength(6);
    expect(data.find((service) => service.slug === "servicio-softgel")?.price).toBe(25000);
  });

  it("fails loudly on an unresolvable date", async () => {
    const { context } = makeTestContext();
    const error = await disponibilidad
      .execute({ fecha: "en unos días" }, context)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ToolArgumentError);
    expect((error as Error).message).toContain("Cannot resolve");
  });

  it("defaults to today in ART server-side when no date is given", async () => {
    const { context, backend } = makeTestContext();
    const result = await disponibilidad.execute({}, context);

    expect(backend.disponibilidadCalls).toEqual([TEST_ART_DATE]);
    expect(JSON.parse(result.content)).toMatchObject({ fecha: TEST_ART_DATE });
  });

  it("still resolves an explicit disponibilidad date", async () => {
    const { context, backend } = makeTestContext();
    const result = await disponibilidad.execute({ fecha: "mañana" }, context);

    expect(backend.disponibilidadCalls).toEqual(["2026-01-15"]);
    expect(JSON.parse(result.content)).toMatchObject({ fecha: "2026-01-15" });
  });

  it("resolves a weekday phrase for a single day", async () => {
    const { context, backend } = makeTestContext();
    const result = await delDia.execute({ fecha: "el jueves" }, context);
    expect(backend.delDiaCalls).toEqual(["2026-01-15"]);
    expect(JSON.parse(result.content)).toMatchObject({ fecha: "2026-01-15" });
  });
});

describe("turnos.rango", () => {
  it("resolves an explicit range and lists the days in between", async () => {
    const { context, backend } = makeTestContext();
    const result = await rango.execute({ desde: TEST_ART_DATE, hasta: "2026-01-15" }, context);

    expect(backend.rangoCalls).toEqual([[TEST_ART_DATE, "2026-01-15"]]);
    expect(JSON.parse(result.content)).toMatchObject({
      desde: TEST_ART_DATE,
      hasta: "2026-01-15",
    });
    expect(result.data).toHaveLength(5);
  });

  it("expands 'esta semana' at 22:30 ART", async () => {
    const { context, backend } = makeTestContext();
    const result = await rango.execute({ desde: "esta semana" }, context);

    expect(backend.rangoCalls).toEqual([["2026-01-12", "2026-01-18"]]);
    expect(JSON.parse(result.content)).toMatchObject({
      desde: "2026-01-12",
      hasta: "2026-01-18",
    });
    expect(result.data).toHaveLength(6);
  });

  it("defaults an open range to a single day", async () => {
    const { context, backend } = makeTestContext();
    await rango.execute({}, context);
    expect(backend.rangoCalls).toEqual([[TEST_ART_DATE, TEST_ART_DATE]]);
  });

  it("rejects a range longer than the cap", async () => {
    const { context, backend } = makeTestContext();
    await expect(
      rango.execute({ desde: "2026-01-01", hasta: "2026-02-15" }, context),
    ).rejects.toBeInstanceOf(ToolArgumentError);
    expect(backend.rangoCalls).toEqual([]);
  });
});

describe("turnos.pagos_pendientes and turnos.resumen", () => {
  it("returns pending verifications plus the refund queue", async () => {
    const { context } = makeTestContext();
    const result = await pagosPendientes.execute({}, context);
    const parsed = JSON.parse(result.content) as {
      verificaciones: Array<{ status: string }>;
      reintegros: { count: number };
    };

    expect(parsed.verificaciones.map((verification) => verification.status)).toEqual([
      "pending",
      "failed",
    ]);
    expect(parsed.reintegros.count).toBe(1);
  });

  it("summarises the ART day when no date is given", async () => {
    const { context } = makeTestContext();
    const result = await resumen.execute({}, context);

    expect(result.data).toEqual({
      date: TEST_ART_DATE,
      totalAppointments: 3,
      counts: { confirmed: 1, paid: 1, cancelled: 1 },
      revenue: 24000,
      pendingVerifications: 2,
      refundsPending: 1,
    });
  });
});

describe("turnos.cancelar (write tool)", () => {
  it("finds a future appointment without a date within the backend's 31-day range", async () => {
    const { context, backend } = makeTestContext();
    const calls: [string, string][] = [];
    const rango = backend.rango.bind(backend);
    backend.rango = async (from: string, to: string) => {
      calls.push([from, to]);
      return await rango(from, to);
    };

    const result = await cancelar.execute({ appointmentId: "apt_tomorrow_1100" }, context);

    expect(result.proposal?.summary).toContain("mañana");
    for (const [from, to] of calls) {
      const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
      expect(days).toBeLessThanOrEqual(31);
    }
  });

  it("names the client even when the model sends no date", async () => {
    const { context } = makeTestContext();
    const result = await cancelar.execute({ appointmentId: "apt_today_0800" }, context);

    expect(result.proposal?.summary).toBe(
      "Cancelar el turno de Ana G. (Servicio Soft Gel, hoy 08:00)",
    );
  });

  it("returns a proposal and never touches the backend", async () => {
    const { context, backend, proposals } = makeTestContext();
    const result = await cancelar.execute(
      { appointmentId: "apt_today_0800", motivo: "viaje", fecha: TEST_ART_DATE },
      context,
    );

    expect(backend.cancelCalls).toEqual([]);
    expect(result.proposal).toBeDefined();
    expect(result.proposal?.chatId).toBe(TEST_CHAT_ID);
    expect(result.proposal?.tool).toBe("turnos.cancelar");
    expect(result.proposal?.summary).toBe(
      "Cancelar el turno de Ana G. (Servicio Soft Gel, hoy 08:00) — motivo: viaje",
    );
    expect(result.proposal?.diff).toContain("· cancelado");
    expect(proposals.get(result.proposal!.id)?.status).toBe("pending");

    const payload = JSON.parse(result.content) as {
      proposal_id: string;
      requires_confirmation: boolean;
    };
    expect(payload.proposal_id).toBe(result.proposal?.id);
    expect(payload.requires_confirmation).toBe(true);
  });

  it("executes the action only through executeProposal", async () => {
    const { context, backend } = makeTestContext();
    const proposalResult = await cancelar.execute({ appointmentId: "apt_today_0800" }, context);
    expect(proposalResult.proposal).toBeDefined();

    const executed = await cancelar.executeProposal(proposalResult.proposal!.args, context);

    expect(backend.cancelCalls).toEqual(["apt_today_0800"]);
    expect(JSON.parse(executed.content)).toMatchObject({
      cancelled: true,
      appointmentId: "apt_today_0800",
      success: true,
    });
  });

  it("rejects a proposal without an appointmentId", async () => {
    const { context, backend } = makeTestContext();
    await expect(cancelar.execute({}, context)).rejects.toBeInstanceOf(ToolArgumentError);
    expect(backend.cancelCalls).toEqual([]);
  });
});
