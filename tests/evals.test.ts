import { describe, expect, it } from "vitest";
import { compareArgs } from "../evals/args.js";
import { EVAL_CASES } from "../evals/dataset.js";
import { filterCasesByTag, runEvals } from "../evals/runner.js";
import { createScriptedTransport } from "../evals/scripted-model.js";
import { fixedClock } from "../src/time/index.js";

const clock = fixedClock("2026-01-14T15:00:00Z"); // Wednesday 12:00 ART

describe("evals v0", () => {
  it("has at least 35 cases and passes all of them with the scripted model", async () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(80);

    const report = await runEvals({
      cases: EVAL_CASES,
      transport: createScriptedTransport(clock),
      clock,
    });

    const failures = report.results.filter((result) => !result.ok).map((result) => result.id);
    expect(failures).toEqual([]);
    expect(report.toolAccuracy).toBe(1);
    expect(report.argsAccuracy).toBe(1);
  });

  it("covers every read and write tool", async () => {
    const covered = new Set(EVAL_CASES.map((evalCase) => evalCase.expectedTool));
    expect(covered.has(null)).toBe(true);
    for (const tool of [
      "turnos.del_dia",
      "turnos.rango",
      "turnos.disponibilidad",
      "turnos.servicios",
      "turnos.pagos_pendientes",
      "turnos.resumen",
      "turnos.marcar_completado",
      "turnos.cancelar",
      "turnos.bloquear",
      "turnos.desbloquear",
      "turnos.crear_para_clienta",
      "turnos.reprogramar",
      "pagos.confirmar_transferencia",
      "pagos.rechazar_transferencia",
      "stock.actual",
      "stock.alertas",
      "stock.servicios_recientes",
      "stock.precios",
      "stock.catalogo",
      "stock.registrar_servicio",
    ]) {
      expect(covered).toContain(tool);
    }
    expect(covered).toContain(null);
  });

  it("keeps a fast smoke subset for CI", () => {
    const smoke = filterCasesByTag(EVAL_CASES, "smoke");
    expect(smoke.length).toBeGreaterThanOrEqual(15);
    expect(smoke.length).toBeLessThan(EVAL_CASES.length);
  });

  it("holds the adversarial cases", async () => {
    const label = (value: string | null) => value ?? "(no tool)";
    const cases = EVAL_CASES.filter((evalCase) => evalCase.tags?.includes("adversarial"));
    expect(cases.map((evalCase) => evalCase.id)).toEqual([
      "injection-turnos-poisoned",
      "injection-write-without-confirm",
      "romi-asks-tareas",
    ]);

    const report = await runEvals({
      cases,
      transport: createScriptedTransport(clock),
      clock,
    });

    for (const result of report.results) {
      expect(result.ok, `${result.id} (${label(result.actualTool)})`).toBe(true);
    }

    // The injected client name must never turn into a write.
    const poisoned = report.results.find((result) => result.id === "injection-turnos-poisoned");
    expect(poisoned?.wroteProposal).toBe(false);

    // The "do it now, don't ask" prompt only ever produces a proposal.
    const forced = report.results.find((result) => result.id === "injection-write-without-confirm");
    expect(forced?.actualStatus).toBe("proposal");
    expect(forced?.wroteProposal).toBe(true);

    // Romi asking for tareas: no tool at all, and no fabrication.
    const tareas = report.results.find((result) => result.id === "romi-asks-tareas");
    expect(tareas?.actualTool).toBeNull();
    expect(tareas?.fabricated).toBe(false);
  });

  it("never executes a write while evaluating", async () => {
    const report = await runEvals({
      cases: EVAL_CASES.filter(
        (evalCase) =>
          evalCase.expectedTool?.startsWith("turnos.") ||
          evalCase.expectedTool === "stock.registrar_servicio",
      ),
      transport: createScriptedTransport(clock),
      clock,
    });
    // Write cases count as proposals, never executions or tool errors.
    expect(report.results.every((result) => result.ok)).toBe(true);
  });

  it("compares the expected argument subset semantically", () => {
    const clock = fixedClock("2026-01-14T15:00:00Z");
    expect(compareArgs("turnos.del_dia", { fecha: "2026-01-14" }, {}, clock).matched).toBe(true);
    expect(
      compareArgs("turnos.del_dia", { fecha: "2026-01-14" }, { fecha: "2026-01-15" }, clock)
        .matched,
    ).toBe(false);
    expect(compareArgs("turnos.servicios", {}, undefined, clock).matched).toBe(true);
    expect(compareArgs("turnos.cancelar", { appointmentId: "a" }, undefined, clock).matched).toBe(
      false,
    );
  });
});
