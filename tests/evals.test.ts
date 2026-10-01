import { describe, expect, it } from "vitest";
import { EVAL_CASES } from "../evals/dataset.js";
import { matchesArgs, runEvals } from "../evals/runner.js";
import { createScriptedTransport } from "../evals/scripted-model.js";
import { fixedClock } from "../src/time/index.js";

const clock = fixedClock("2026-01-14T15:00:00Z"); // Wednesday 12:00 ART

describe("evals v0", () => {
  it("has 20 cases and passes all of them with the scripted model", async () => {
    expect(EVAL_CASES).toHaveLength(20);

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

  it("compares only the expected argument keys", () => {
    expect(matchesArgs({ fecha: "2026-01-14", extra: 1 }, { fecha: "2026-01-14" })).toBe(true);
    expect(matchesArgs({ fecha: "2026-01-15" }, { fecha: "2026-01-14" })).toBe(false);
    expect(matchesArgs(undefined, {})).toBe(true);
    expect(matchesArgs(undefined, { fecha: "2026-01-14" })).toBe(false);
  });
});
