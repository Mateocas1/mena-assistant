import { describe, expect, it } from "vitest";
import { TurnosError } from "../src/adapters/turnos/client.js";
import { createTurnosFixtures } from "../src/adapters/turnos/fixtures.js";
import { createTurnosWriteTools } from "../src/mcp/tools/turnos-writes.js";
import { ToolArgumentError, isWriteTool, type ToolHandlerContext } from "../src/mcp/registry.js";
import {
  makeTestContext,
  SpyTurnosBackend,
  TEST_ART_DATE,
  TEST_INSTANT,
} from "./helpers/context.js";
import { fixedClock } from "../src/time/index.js";

const tools = createTurnosWriteTools();
const byName = (name: string) => {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool || !isWriteTool(tool)) throw new Error(`missing write tool ${name}`);
  return tool;
};

const marcarCompletado = byName("turnos.marcar_completado");
const bloquear = byName("turnos.bloquear");
const desbloquear = byName("turnos.desbloquear");
const crear = byName("turnos.crear_para_clienta");
const reprogramar = byName("turnos.reprogramar");
const confirmar = byName("pagos.confirmar_transferencia");
const rechazar = byName("pagos.rechazar_transferencia");

function run(tool: ReturnType<typeof byName>, args: unknown, context: ToolHandlerContext) {
  return tool.execute(args, context);
}

describe("write tools only create proposals", () => {
  it("marcar_completado proposes and never completes", async () => {
    const { context, backend, proposals } = makeTestContext();
    const result = await run(
      marcarCompletado,
      { appointmentId: "apt_past_0800", fecha: "2026-01-07" },
      context,
    );

    expect(result.proposal?.tool).toBe("turnos.marcar_completado");
    expect(result.proposal?.summary).toContain("Paula V.");
    expect(result.proposal?.diff).toContain("completed");
    expect(proposals.get(result.proposal!.id)?.status).toBe("pending");
    expect((await backend.delDia("2026-01-07"))[0]?.status).toBe("confirmed");

    await marcarCompletado.executeProposal(result.proposal!.args, context);
    expect((await backend.delDia("2026-01-07"))[0]?.status).toBe("completed");
  });

  it("bloquear proposes a slot and a full day", async () => {
    const { context, backend, proposals } = makeTestContext();

    const slot = await run(bloquear, { fecha: "2026-01-20", hora: "11:00" }, context);
    expect(slot.proposal?.summary).toBe("Bloquear el 2026-01-20 a las 11:00");
    expect(slot.proposal?.diff).toContain("+ 2026-01-20 11:00 · bloqueado");
    expect(
      (await backend.disponibilidad("2026-01-20")).find((entry) => entry.time === "11:00")
        ?.available,
    ).toBe(true);

    const day = await run(bloquear, { fecha: "2026-01-21", motivo: "curso" }, context);
    expect(day.proposal?.summary).toBe("Bloquear el 2026-01-21 completo (motivo: curso)");
    expect(day.proposal?.args).toMatchObject({ fecha: "2026-01-21", motivo: "curso" });

    await bloquear.executeProposal(slot.proposal!.args, context);
    expect(
      (await backend.disponibilidad("2026-01-20")).find((entry) => entry.time === "11:00")
        ?.available,
    ).toBe(false);

    await bloquear.executeProposal(day.proposal!.args, context);
    expect((await backend.disponibilidad("2026-01-21")).every((entry) => !entry.available)).toBe(
      true,
    );
    expect(proposals.get(day.proposal!.id)?.tool).toBe("turnos.bloquear");
  });

  it("desbloquear proposes removing a fixture block", async () => {
    const { context, backend } = makeTestContext();
    const result = await run(
      desbloquear,
      { blockedSlotId: "blk_seed_2026-01-14_0", fecha: TEST_ART_DATE, hora: "16:30" },
      context,
    );

    expect(result.proposal?.summary).toContain("blk_seed_2026-01-14_0");
    expect(
      (await backend.disponibilidad(TEST_ART_DATE)).find((entry) => entry.time === "16:30")
        ?.available,
    ).toBe(false);

    await desbloquear.executeProposal(result.proposal!.args, context);
    expect(
      (await backend.disponibilidad(TEST_ART_DATE)).find((entry) => entry.time === "16:30")
        ?.available,
    ).toBe(true);
  });

  it("crear_para_clienta proposes a booking and validates its inputs", async () => {
    const { context, backend } = makeTestContext();
    const args = {
      cliente: "Ana Gomez",
      telefono: "11 5555 6666",
      servicio: "servicio-softgel",
      fecha: "2026-01-20",
      hora: "16:30",
      retiro: true,
    };

    const result = await run(crear, args, context);
    expect(result.proposal?.summary).toContain("Ana Gomez");
    expect(result.proposal?.summary).toContain("con retiro");
    expect(result.proposal?.diff).toContain(
      "+ 2026-01-20 16:30 · servicio-softgel · Ana G. · pending",
    );
    expect(await backend.delDia("2026-01-20")).toEqual([]);

    await crear.executeProposal(result.proposal!.args, context);
    const created = await backend.delDia("2026-01-20");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      timeSlot: "16:30",
      status: "pending",
      clientName: "Ana G.",
    });

    // Bad inputs never reach the proposal store.
    await expect(run(crear, { ...args, email: "no-es-email" }, context)).rejects.toBeInstanceOf(
      ToolArgumentError,
    );
    await expect(run(crear, { ...args, telefono: "12" }, context)).rejects.toBeInstanceOf(
      ToolArgumentError,
    );
    expect(result.proposal).toBeDefined();
  });

  it("reprogramar shows the old and new slot", async () => {
    const { context, backend } = makeTestContext();
    const result = await run(
      reprogramar,
      {
        appointmentId: "apt_today_0800",
        fecha: "2026-01-20",
        hora: "11:00",
        fecha_actual: TEST_ART_DATE,
      },
      context,
    );

    expect(result.proposal?.summary).toContain("de 2026-01-14 08:00 a 2026-01-20 11:00");
    expect(result.proposal?.diff).toContain("- 2026-01-14 08:00");
    expect(result.proposal?.diff).toContain("+ 2026-01-20 11:00");

    await reprogramar.executeProposal(result.proposal!.args, context);
    expect((await backend.delDia(TEST_ART_DATE)).map((a) => a.id)).not.toContain("apt_today_0800");
    expect((await backend.delDia("2026-01-20")).map((a) => a.id)).toEqual(["apt_today_0800"]);
  });

  it("confirmar_transferencia resolves the payment id from the pending list", async () => {
    const { context, backend } = makeTestContext();
    const result = await run(confirmar, { verificationId: "ver_today_pending" }, context);

    expect(result.proposal?.summary).toContain("Ana G.");
    expect(result.proposal?.summary).toContain("$12500");
    expect(result.proposal?.args).toMatchObject({
      verificationId: "ver_today_pending",
      paymentId: "pay_today_pending",
    });

    await confirmar.executeProposal(result.proposal!.args, context);
    const pending = await backend.pagosPendientes();
    expect(pending.verificaciones.map((entry) => entry.id)).toEqual(["ver_today_failed"]);
  });

  it("rechazar_transferencia requires a reason", async () => {
    const { context, backend } = makeTestContext();

    await expect(
      run(rechazar, { verificationId: "ver_today_failed" }, context),
    ).rejects.toBeInstanceOf(ToolArgumentError);

    const result = await run(
      rechazar,
      { verificationId: "ver_today_failed", motivo: "el monto no coincide" },
      context,
    );
    expect(result.proposal?.summary).toContain("el monto no coincide");
    expect(result.proposal?.diff).toContain("rejected");

    await rechazar.executeProposal(result.proposal!.args, context);
    const pending = await backend.pagosPendientes();
    expect(pending.verificaciones.map((entry) => entry.id)).toEqual(["ver_today_pending"]);
  });

  it("accepts an explicit paymentId and rejects it when unknown", async () => {
    const { context } = makeTestContext();
    const result = await run(
      confirmar,
      { verificationId: "ver_today_pending", paymentId: "pay_explicit" },
      context,
    );
    expect(result.proposal?.args).toMatchObject({ paymentId: "pay_explicit" });

    await expect(run(confirmar, { verificationId: "ver_nope" }, context)).rejects.toBeInstanceOf(
      ToolArgumentError,
    );
  });

  it("explains clearly when the backend does not expose the payment id", async () => {
    const base = makeTestContext();
    const fixtures = createTurnosFixtures(TEST_ART_DATE);
    const backend = new SpyTurnosBackend(
      {
        ...fixtures,
        verifications: fixtures.verifications.map((verification) => {
          const { paymentId: _paymentId, ...rest } = verification;
          return rest;
        }),
      },
      { clock: fixedClock(TEST_INSTANT) },
    );
    const context = { ...base.context, backend };

    const error = await run(confirmar, { verificationId: "ver_today_pending" }, context).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(TurnosError);
    expect((error as TurnosError).userMessage).toContain("id del pago");
  });
});

describe("write input validation happens before any proposal", () => {
  it("rejects a block without a slot and without the full-day flag", async () => {
    const { context } = makeTestContext();

    await expect(
      run(bloquear, { fecha: "2026-01-20", dia_completo: false }, context),
    ).rejects.toBeInstanceOf(ToolArgumentError);
  });

  it("rejects a past booking date", async () => {
    const { context } = makeTestContext();
    await expect(run(bloquear, { fecha: "2026-01-01" }, context)).rejects.toBeInstanceOf(
      ToolArgumentError,
    );
    await expect(
      run(
        crear,
        {
          cliente: "Ana",
          telefono: "1145556666",
          servicio: "servicio-softgel",
          fecha: "2026-01-01",
          hora: "16:30",
        },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolArgumentError);
    await expect(
      run(
        reprogramar,
        { appointmentId: "apt_today_0800", fecha: "2027-01-01", hora: "11:00" },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolArgumentError);
  });

  it("rejects a malformed slot", async () => {
    const { context } = makeTestContext();
    await expect(
      run(bloquear, { fecha: "2026-01-20", hora: "11" }, context),
    ).rejects.toBeInstanceOf(ToolArgumentError);
  });
});
