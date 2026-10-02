/**
 * `pnpm eval:compare --models a,b,c` — runs the dataset against the real
 * OpenAI-compatible endpoint once per model and writes a comparison table.
 *
 * It is never run in CI and never runs without `LLM_API_KEY`; the metrics logic
 * is exercised by `tests/eval-compare.test.ts` with a fake transport factory.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  OpenAiTransport,
  type LlmCallOptions,
  type LlmCompletion,
  type LlmCompletionRequest,
  type LlmTransport,
} from "../src/llm/index.js";
import { fixedClock, type Clock } from "../src/time/index.js";
import { EVAL_CASES } from "./dataset.js";
import { runEvals } from "./runner.js";
import type { EvalCase, EvalCaseResult } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = join(HERE, "results");
export const PRICES_PATH = join(HERE, "prices.json");
export const README_PATH = join(HERE, "..", "README.md");

export const MODEL_COMPARISON_MARKERS = {
  start: "<!-- model-comparison:start -->",
  end: "<!-- model-comparison:end -->",
} as const;

export const DEFAULT_MODELS = [
  "deepseek-v4-flash",
  "qwen3.8-flash",
  "glm5.3-flash",
  "qwen3.6",
] as const;

/** The dataset is frozen at this instant so relative dates are reproducible. */
export const EVAL_CLOCK_INSTANT = "2026-01-14T15:00:00Z";

export interface PriceEntry {
  readonly inputPerMillion: number | null;
  readonly outputPerMillion: number | null;
  readonly source?: string;
}

export interface PriceTable {
  readonly note?: string;
  readonly models: Readonly<Record<string, PriceEntry>>;
}

export interface ModelRunResult {
  readonly model: string;
  readonly ranAt: string;
  readonly total: number;
  readonly passed: number;
  readonly toolAccuracy: number;
  readonly argsAccuracy: number;
  readonly hallucinatedToolRate: number;
  readonly writeProposalRate: number;
  readonly latencyMs: { readonly p50: number; readonly p95: number };
  readonly tokens: { readonly prompt: number; readonly completion: number; readonly total: number };
  readonly costUsd: number | null;
  readonly cases: readonly {
    readonly id: string;
    readonly ok: boolean;
    readonly expectedTool: string | null;
    readonly actualTool: string | null;
    readonly actualStatus?: string;
    readonly hallucinated: boolean;
    readonly latencyMs: number;
  }[];
  /** Populated when the model run itself failed (network, auth). */
  readonly error?: string;
}

export function loadPriceTable(path: string = PRICES_PATH): PriceTable {
  return JSON.parse(readFileSync(path, "utf8")) as PriceTable;
}

/** `--models a,b` (repeatable), falling back to the default list. */
export function parseModelsFlag(
  argv: readonly string[],
  fallback: readonly string[] = DEFAULT_MODELS,
): string[] {
  const models: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--models" || argument === "-m") {
      const value = argv[index + 1];
      if (value) {
        models.push(
          ...value
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
        );
        index += 1;
      }
      continue;
    }
    if (argument?.startsWith("--models=")) {
      models.push(
        ...argument
          .slice("--models=".length)
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
      );
    }
  }
  return models.length > 0 ? [...new Set(models)] : [...fallback];
}

export function estimateCostUsd(
  tokens: { readonly prompt: number; readonly completion: number },
  price: PriceEntry | undefined,
): number | null {
  if (!price || price.inputPerMillion === null || price.outputPerMillion === null) return null;
  return (
    (tokens.prompt / 1_000_000) * price.inputPerMillion +
    (tokens.completion / 1_000_000) * price.outputPerMillion
  );
}

const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function retryableStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown })?.status;
  if (typeof status === "number") return RETRYABLE_STATUSES.has(status) ? status : undefined;
  // No status means a transport-level failure (DNS, socket): retry it too.
  return 0;
}

/**
 * Wraps a transport so a 429/5xx (or a network failure) is retried with
 * exponential backoff. The tool loop owns model fallback; this only smooths the
 * provider's transient failures.
 */
export function withRetries(
  transport: LlmTransport,
  options: {
    readonly retries?: number;
    readonly baseDelayMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
  } = {},
): LlmTransport & { readonly retriesUsed: () => number } {
  const retries = options.retries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let retriesUsed = 0;

  return {
    retriesUsed: () => retriesUsed,
    async complete(
      request: LlmCompletionRequest,
      callOptions: LlmCallOptions,
    ): Promise<LlmCompletion> {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await transport.complete(request, callOptions);
        } catch (error) {
          if (attempt >= retries || retryableStatus(error) === undefined) throw error;
          retriesUsed += 1;
          await sleep(Math.min(baseDelayMs * 2 ** attempt, 8_000));
        }
      }
    },
  };
}

export interface RunComparisonOptions {
  readonly models: readonly string[];
  readonly transportFactory: (model: string) => LlmTransport;
  readonly clock?: Clock;
  readonly cases?: readonly EvalCase[];
  readonly concurrency?: number;
  readonly ranAt?: string;
  readonly priceTable?: PriceTable;
  readonly onModel?: (result: ModelRunResult) => void;
}

/** Runs the dataset once per model and returns one result per model. */
export async function runComparison(options: RunComparisonOptions): Promise<ModelRunResult[]> {
  const clock = options.clock ?? fixedClock(EVAL_CLOCK_INSTANT);
  const cases = options.cases ?? EVAL_CASES;
  const priceTable = options.priceTable ?? loadPriceTable();
  const ranAt = options.ranAt ?? new Date().toISOString();

  const results: ModelRunResult[] = [];

  for (const model of options.models) {
    try {
      const report = await runEvals({
        cases,
        transport: options.transportFactory(model),
        clock,
        model,
        // A comparison measures one model: no cross-model fallback.
        fallbackModel: model,
        concurrency: options.concurrency,
      });

      const result: ModelRunResult = {
        model,
        ranAt,
        total: report.total,
        passed: report.passed,
        toolAccuracy: report.toolAccuracy,
        argsAccuracy: report.argsAccuracy,
        hallucinatedToolRate: report.hallucinatedToolRate,
        writeProposalRate: report.writeProposalRate,
        latencyMs: report.latencyMs,
        tokens: report.tokens,
        costUsd: estimateCostUsd(report.tokens, priceTable.models[model]),
        cases: report.results.map(slimCase),
      };
      results.push(result);
      options.onModel?.(result);
    } catch (error) {
      const result: ModelRunResult = {
        model,
        ranAt,
        total: cases.length,
        passed: 0,
        toolAccuracy: 0,
        argsAccuracy: 0,
        hallucinatedToolRate: 0,
        writeProposalRate: 0,
        latencyMs: { p50: 0, p95: 0 },
        tokens: { prompt: 0, completion: 0, total: 0 },
        costUsd: null,
        cases: [],
        error: error instanceof Error ? error.message : String(error),
      };
      results.push(result);
      options.onModel?.(result);
    }
  }

  return results;
}

function slimCase(result: EvalCaseResult): ModelRunResult["cases"][number] {
  return {
    id: result.id,
    ok: result.ok,
    expectedTool: result.expectedTool,
    actualTool: result.actualTool,
    ...(result.actualStatus === undefined ? {} : { actualStatus: result.actualStatus }),
    hallucinated: result.hallucinated,
    latencyMs: result.latencyMs,
  };
}

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
const ms = (value: number): string => `${Math.round(value)} ms`;
const cost = (value: number | null): string => (value === null ? "n/d" : `$${value.toFixed(4)}`);

/** Markdown table, best tool accuracy first. */
export function renderComparisonTable(
  results: readonly ModelRunResult[],
  priceTable: PriceTable,
): string {
  const header = [
    "| Modelo | Tool | Args | Alucinaciones | Propuestas | p50 | p95 | Tokens (in/out) | Costo |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  const rows = [...results]
    .sort((left, right) => right.toolAccuracy - left.toolAccuracy)
    .map((result) => {
      if (result.error) {
        return `| \`${result.model}\` | — | — | — | — | — | — | — | error: ${result.error} |`;
      }
      return `| \`${result.model}\` | ${percent(result.toolAccuracy)} | ${percent(
        result.argsAccuracy,
      )} | ${percent(result.hallucinatedToolRate)} | ${percent(result.writeProposalRate)} | ${ms(
        result.latencyMs.p50,
      )} | ${ms(result.latencyMs.p95)} | ${result.tokens.prompt}/${result.tokens.completion} | ${cost(
        result.costUsd,
      )} |`;
    });

  const missingPrices = results
    .filter((result) => result.costUsd === null && !result.error)
    .map((result) => result.model);
  const notes: string[] = [];
  if (priceTable.note) notes.push(`> ${priceTable.note}`);
  if (missingPrices.length > 0) {
    notes.push(`> Sin precios configurados para: ${missingPrices.join(", ")}.`);
  }

  return [header.join("\n"), ...rows, ...notes].join("\n");
}

export function renderResultsTable(results: readonly ModelRunResult[]): string {
  const header = [
    "| Modelo | Casos | Pasan | Tool | Args | Alucinaciones | Propuestas | p50 | p95 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const rows = results.map(
    (result) =>
      `| \`${result.model}\` | ${result.total} | ${result.passed} | ${percent(
        result.toolAccuracy,
      )} | ${percent(result.argsAccuracy)} | ${percent(result.hallucinatedToolRate)} | ${percent(
        result.writeProposalRate,
      )} | ${ms(result.latencyMs.p50)} | ${ms(result.latencyMs.p95)} |`,
  );
  return [header.join("\n"), ...rows].join("\n");
}

export function writeModelResult(result: ModelRunResult, directory: string = RESULTS_DIR): string {
  mkdirSync(directory, { recursive: true });
  const date = result.ranAt.slice(0, 10);
  const path = join(directory, `${date}-${result.model}.json`);
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return path;
}

/** Latest result per model from the results directory. */
export function loadModelResults(directory: string = RESULTS_DIR): ModelRunResult[] {
  let files: string[];
  try {
    files = readdirSync(directory).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }

  const latest = new Map<string, ModelRunResult>();
  for (const file of files.sort()) {
    const parsed = JSON.parse(readFileSync(join(directory, file), "utf8")) as ModelRunResult;
    const previous = latest.get(parsed.model);
    if (!previous || previous.ranAt <= parsed.ranAt) latest.set(parsed.model, parsed);
  }
  return [...latest.values()];
}

/** Replaces the README block between the comparison markers. */
export function updateReadmeTable(table: string, readmePath: string = README_PATH): boolean {
  const content = readFileSync(readmePath, "utf8");
  const { start, end } = MODEL_COMPARISON_MARKERS;
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) return false;

  const updated =
    content.slice(0, startIndex + start.length) + `\n\n${table}\n\n` + content.slice(endIndex);
  writeFileSync(readmePath, updated, "utf8");
  return true;
}

export interface CompareCliOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly resultsDir?: string;
  readonly readmePath?: string;
  readonly concurrency?: number;
  readonly cases?: readonly EvalCase[];
  readonly clock?: Clock;
  readonly stdout?: (line: string) => void;
}

/** CLI entrypoint: returns the process exit code. */
export async function main(
  argv: readonly string[],
  options: CompareCliOptions = {},
): Promise<number> {
  const log = options.stdout ?? ((line: string) => console.log(line));
  const models = parseModelsFlag(argv);

  const apiKey = options.apiKey ?? process.env.LLM_API_KEY;
  if (!apiKey) {
    log("eval:compare necesita LLM_API_KEY (y opcionalmente LLM_BASE_URL). No se ejecutó nada.");
    return 2;
  }
  const baseUrl = options.baseUrl ?? process.env.LLM_BASE_URL ?? "https://api.nan.builders/v1";
  const priceTable = loadPriceTable();

  log(`Comparando ${models.length} modelos contra ${baseUrl} con el dataset de evaluación…`);
  const results = await runComparison({
    models,
    transportFactory: (model) => {
      const inner = new OpenAiTransport({ apiKey, baseUrl });
      const forced: LlmTransport = {
        complete: (request, callOptions) => inner.complete({ ...request, model }, callOptions),
      };
      return withRetries(forced, { retries: 2, baseDelayMs: 500 });
    },
    clock: options.clock ?? fixedClock(EVAL_CLOCK_INSTANT),
    ...(options.cases === undefined ? {} : { cases: options.cases }),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    onModel: (result) => {
      if (options.resultsDir) writeModelResult(result, options.resultsDir);
      log(
        `${result.model}: tool ${(result.toolAccuracy * 100).toFixed(1)}% · args ${(
          result.argsAccuracy * 100
        ).toFixed(1)}%${result.error ? ` · error: ${result.error}` : ""}`,
      );
    },
  });

  if (!options.resultsDir) {
    for (const result of results) writeModelResult(result);
  }

  const table = renderComparisonTable(results, priceTable);
  log(table);

  const readmePath = options.readmePath ?? README_PATH;
  if (!updateReadmeTable(table, readmePath)) {
    log(
      `No encontré los marcadores ${MODEL_COMPARISON_MARKERS.start} / ${MODEL_COMPARISON_MARKERS.end} en ${readmePath}; la tabla no se actualizó.`,
    );
  }

  return results.some((result) => result.error) ? 1 : 0;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
