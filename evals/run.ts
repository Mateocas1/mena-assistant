import { fixedClock } from "../src/time/index.js";
import { EVAL_CASES } from "./dataset.js";
import { formatReport, runEvals } from "./runner.js";
import { createScriptedTransport } from "./scripted-model.js";

/**
 * `pnpm eval` — deterministic, CI-safe. The scripted transport locks tool
 * selection and ART argument resolution; a real model is measured by
 * `pnpm eval:live`, never in CI.
 */
const clock = fixedClock("2026-01-14T15:00:00Z"); // 2026-01-14 12:00 ART (Wednesday)

const report = await runEvals({
  cases: EVAL_CASES,
  transport: createScriptedTransport(clock),
  clock,
});

console.log(formatReport(report, "Evals v0 (scripted, mock backend)"));
process.exitCode = report.passed === report.total ? 0 : 1;
