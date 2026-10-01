import { describe, expect, it } from "vitest";
import { EVAL_CASES } from "../evals/dataset.js";
import { matchesArgs, runEvals } from "../evals/runner.js";
import { createScriptedTransport } from "../evals/scripted-model.js";
import { fixedClock } from "../src/time/index.js";

const clock = fixedClock("2026-01-14T15:00:00Z"); // Wednesday 12:00 ART

describe("evals v0", () => {
  it("has at least 35 cases and passes all of them with the scripted model", async () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(55);

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
    ]) {
      expect(covered).toContain(tool);
    }
    expect(covered).toContain(null);
  });

  it("never executes a write while evaluating", async () => {
    const report = await runEvals({
      cases: EVAL_CASES.filter((evalCase) => evalCase.expectedTool?.startsWith("turnos.")),
      transport: createScriptedTransport(clock),
      clock,
    });
    // Write cases count as proposals, never executions or tool errors.
    expect(report.results.every((result) => result.ok)).toBe(true);
  });

  it("compares only the expected argument keys", () => {
    expect(matchesArgs({ fecha: "2026-01-14", extra: 1 }, { fecha: "2026-01-14" })).toBe(true);
    expect(matchesArgs({ fecha: "2026-01-15" }, { fecha: "2026-01-14" })).toBe(false);
    expect(matchesArgs(undefined, {})).toBe(true);
    expect(matchesArgs(undefined, { fecha: "2026-01-14" })).toBe(false);
  });
});
