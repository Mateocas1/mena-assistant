import { describe, expect, it } from "vitest";
import { ToolArgumentError, isWriteTool } from "../src/mcp/registry.js";
import { createTurnosTools } from "../src/mcp/tools/turnos.js";
import { InvalidDateError } from "../src/time/index.js";
import { makeTestContext, TEST_ART_DATE, TEST_CHAT_ID } from "./helpers/context.js";

const tools = createTurnosTools();
const delDia = tools.find((tool) => tool.name === "turnos.del_dia")!;
const disponibilidad = tools.find((tool) => tool.name === "turnos.disponibilidad")!;
const servicios = tools.find((tool) => tool.name === "turnos.servicios")!;
const cancelar = tools.find(isWriteTool)!;

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
    await expect(
      disponibilidad.execute({ fecha: "el jueves que viene" }, context),
    ).rejects.toBeInstanceOf(InvalidDateError);
  });

  it("fails with a typed error on invalid arguments", async () => {
    const { context } = makeTestContext();
    await expect(disponibilidad.execute({}, context)).rejects.toBeInstanceOf(ToolArgumentError);
  });
});

describe("turnos.cancelar (write tool)", () => {
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
    expect(result.proposal?.summary).toContain("Ana G.");
    expect(result.proposal?.diff).toContain("cancelled");
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
