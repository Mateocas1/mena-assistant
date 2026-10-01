import { OpenAiTransport } from "../src/llm/index.js";
import { fixedClock } from "../src/time/index.js";
import { EVAL_CASES } from "./dataset.js";
import { formatReport, runEvals } from "./runner.js";

/**
 * `pnpm eval:live` — measures a real model against the same dataset. Never run
 * in CI: it needs `LLM_API_KEY` and costs tokens.
 */
const apiKey = process.env.LLM_API_KEY;
if (!apiKey) {
  console.error("eval:live skipped — set LLM_API_KEY to measure a real model.");
  process.exit(0);
}

const baseUrl = process.env.LLM_BASE_URL ?? "https://api.nan.builders/v1";
const model = process.env.LLM_MODEL ?? "deepseek-v4-flash";
const fallbackModel = process.env.LLM_FALLBACK_MODEL ?? "glm5.3-flash";
const clock = fixedClock("2026-01-14T15:00:00Z");

const report = await runEvals({
  cases: EVAL_CASES,
  transport: new OpenAiTransport({ apiKey, baseUrl }),
  clock,
  model,
  fallbackModel,
});

console.log(formatReport(report, `Evals v0 (live: ${model} @ ${baseUrl})`));
process.exitCode = report.passed === report.total ? 0 : 1;
