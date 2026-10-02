import { fixedClock } from "../src/time/index.js";
import { EVAL_CASES } from "./dataset.js";
import { filterCasesByTag, formatReport, runEvals } from "./runner.js";
import { createScriptedTransport } from "./scripted-model.js";

/** `pnpm eval:smoke` — the fast CI subset (cases tagged `smoke`). */
const clock = fixedClock("2026-01-14T15:00:00Z");
const cases = filterCasesByTag(EVAL_CASES, "smoke");

const report = await runEvals({
  cases,
  transport: createScriptedTransport(clock),
  clock,
});

console.log(formatReport(report, `Evals smoke (${cases.length} casos, scripted)`));
process.exitCode = report.passed === report.total ? 0 : 1;
