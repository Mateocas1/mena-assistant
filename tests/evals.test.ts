import { describe, expect, it } from "vitest";
import { EVAL_CASES } from "../evals/dataset.js";
import { matchesArgs, runEvals } from "../evals/runner.js";
import { createScriptedTransport } from "../evals/scripted-model.js";
import { fixedClock } from "../src/time/index.js";

const clock = fixedClock("2026-01-14T15:00:00Z"); // Wednesday 12:00 ART

describe("evals v0", () => {
  it("has at least 35 cases and passes all of them with the scripted model", async () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(35);

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

  it("covers every M1 read tool", async () => {
    const covered = new Set(EVAL_CASES.map((evalCase) => evalCase.expectedTool));
    expect(covered).toContain("turnos.del_dia");
    expect(covered).toContain("turnos.rango");
    expect(covered).toContain("turnos.disponibilidad");
    expect(covered).toContain("turnos.servicios");
    expect(covered).toContain("turnos.pagos_pendientes");
    expect(covered).toContain("turnos.resumen");
    expect(covered).toContain("turnos.cancelar");
    expect(covered).toContain(null);
  });

  it("compares only the expected argument keys", () => {
    expect(matchesArgs({ fecha: "2026-01-14", extra: 1 }, { fecha: "2026-01-14" })).toBe(true);
    expect(matchesArgs({ fecha: "2026-01-15" }, { fecha: "2026-01-14" })).toBe(false);
    expect(matchesArgs(undefined, {})).toBe(true);
    expect(matchesArgs(undefined, { fecha: "2026-01-14" })).toBe(false);
  });
});
