import { MockStockBackend } from "../src/adapters/stock/mock.js";
import { MockTurnosBackend } from "../src/adapters/turnos/mock.js";
import { createTurnosFixtures } from "../src/adapters/turnos/fixtures.js";
import { AuditLogger } from "../src/audit/index.js";
import { buildSystemPrompt, runToolLoop, type LlmTransport } from "../src/llm/index.js";
import { createToolRegistry } from "../src/mcp/tools/index.js";
import { ProposalStore } from "../src/proposals/store.js";
import { artToday, type Clock } from "../src/time/index.js";
import type { EvalCase, EvalCaseResult, EvalReport } from "./types.js";

export interface RunEvalsOptions {
  readonly cases: readonly EvalCase[];
  readonly transport: LlmTransport;
  readonly clock: Clock;
  readonly model?: string;
  readonly fallbackModel?: string;
  readonly maxToolCalls?: number;
}

function ratio(matched: number, total: number): number {
  if (total === 0) return 1;
  return matched / total;
}

/** `expected` is a subset: every listed key must match the actual arguments. */
export function matchesArgs(actual: unknown, expected: Readonly<Record<string, unknown>>): boolean {
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
    return Object.keys(expected).length === 0;
  }
  const record = actual as Record<string, unknown>;
  return Object.entries(expected).every(
    ([key, value]) => JSON.stringify(record[key]) === JSON.stringify(value),
  );
}

/** Runs the dataset through the real pipeline (allowlist → tool loop → mock backend). */
export async function runEvals(options: RunEvalsOptions): Promise<EvalReport> {
  const model = options.model ?? "deepseek-v4-flash";
  const fallbackModel = options.fallbackModel ?? "glm5.3-flash";
  const maxToolCalls = options.maxToolCalls ?? 6;
  const referenceDate = artToday(options.clock);
  const registry = createToolRegistry({ turnos: true, stock: true, tareas: false });

  const results: EvalCaseResult[] = [];

  for (const evalCase of options.cases) {
    const backend = new MockTurnosBackend(createTurnosFixtures(referenceDate));
    const proposals = new ProposalStore({ ttlMs: 10 * 60_000, clock: options.clock });
    const audit = new AuditLogger({ sink: () => {}, clock: options.clock });

    const result = await runToolLoop({
      transport: options.transport,
      tools: registry.forProfile(evalCase.profile),
      context: {
        backend,
        stock: new MockStockBackend(),
        proposals,
        clock: options.clock,
        profile: evalCase.profile,
        chatId: `eval:${evalCase.profile}`,
      },
      config: { model, fallbackModel, timeoutMs: 30_000, maxToolCalls },
      audit,
      systemPrompt: buildSystemPrompt(options.clock),
      userMessage: evalCase.question,
    });

    const selected = result.toolCalls.find((call) => call.status !== "error");
    const actualTool = selected?.tool ?? null;
    const actualArgs = selected?.args;
    const toolMatched = actualTool === evalCase.expectedTool;
    const argsMatched =
      evalCase.expectedTool === null
        ? true
        : toolMatched && matchesArgs(actualArgs, evalCase.expectedArgs ?? {});
    const ok = toolMatched && argsMatched && result.reply.trim().length > 0;

    results.push({
      id: evalCase.id,
      question: evalCase.question,
      ok,
      toolMatched,
      argsMatched,
      expectedTool: evalCase.expectedTool,
      actualTool,
      ...(actualArgs === undefined ? {} : { actualArgs }),
      reply: result.reply,
    });
  }

  const total = results.length;
  const passed = results.filter((result) => result.ok).length;
  const toolMatches = results.filter((result) => result.toolMatched).length;
  const argsMatches = results.filter((result) => result.argsMatched).length;

  return {
    total,
    passed,
    toolAccuracy: ratio(toolMatches, total),
    argsAccuracy: ratio(argsMatches, total),
    results,
  };
}

export function formatReport(report: EvalReport, label: string): string {
  const lines = report.results.map((result) => {
    const status = result.ok ? "PASS" : "FAIL";
    const expected = result.expectedTool ?? "(no tool)";
    const actual = result.actualTool ?? "(no tool)";
    const args = result.actualArgs ? ` args=${JSON.stringify(result.actualArgs)}` : "";
    return `[${status}] ${result.id.padEnd(24)} expected=${expected.padEnd(22)} actual=${actual}${args}`;
  });

  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  lines.push("");
  lines.push(
    `${label}: ${report.passed}/${report.total} passed · tool accuracy ${percent(
      report.toolAccuracy,
    )} · args accuracy ${percent(report.argsAccuracy)}`,
  );
  return lines.join("\n");
}
