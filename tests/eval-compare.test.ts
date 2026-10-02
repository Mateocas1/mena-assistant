import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MODELS,
  MODEL_COMPARISON_MARKERS,
  estimateCostUsd,
  loadModelResults,
  main,
  parseModelsFlag,
  parseConcurrencyFlag,
  renderComparisonTable,
  runComparison,
  updateReadmeTable,
  withRequestLimit,
  withRetries,
  writeModelResult,
  type ModelRunResult,
} from "../evals/compare.js";
import { CONCURRENCY_LIMIT_DRAIN_MS, RequestLimiter } from "../evals/rate-limit.js";
import { EVAL_CASES } from "../evals/dataset.js";
import { createScriptedTransport } from "../evals/scripted-model.js";
import type {
  LlmCallOptions,
  LlmCompletion,
  LlmCompletionRequest,
  LlmTransport,
} from "../src/llm/index.js";
import { fixedClock } from "../src/time/index.js";

const CLOCK = fixedClock("2026-01-14T15:00:00Z");
const CASES = EVAL_CASES.filter((evalCase) =>
  ["turnos-hoy", "servicios-que-tenes", "cancelar-hoy"].includes(evalCase.id),
);

describe("parseModelsFlag", () => {
  it("reads --models in every supported shape", () => {
    expect(parseModelsFlag(["--models", "a,b"])).toEqual(["a", "b"]);
    expect(parseModelsFlag(["--models=a,b"])).toEqual(["a", "b"]);
    expect(parseModelsFlag(["-m", "a"])).toEqual(["a"]);
    expect(parseModelsFlag(["--models", "a", "--models", "b"])).toEqual(["a", "b"]);
    expect(parseModelsFlag([])).toEqual([...DEFAULT_MODELS]);
  });
});

describe("parseConcurrencyFlag", () => {
  it("reads --concurrency in both shapes and clamps to a sane range", () => {
    expect(parseConcurrencyFlag(["--concurrency", "6"])).toBe(6);
    expect(parseConcurrencyFlag(["--concurrency=2"])).toBe(2);
    expect(parseConcurrencyFlag(["-c", "3"])).toBe(3);
    expect(parseConcurrencyFlag([], 2)).toBe(2);
    expect(parseConcurrencyFlag(["--concurrency", "0"], 2)).toBe(2);
    expect(parseConcurrencyFlag(["--concurrency", "99"], 2)).toBe(2);
  });
});

describe("estimateCostUsd", () => {
  it("prices tokens when the table has values and returns null otherwise", () => {
    expect(
      estimateCostUsd(
        { prompt: 1_000_000, completion: 1_000_000 },
        { inputPerMillion: 0.2, outputPerMillion: 0.6 },
      ),
    ).toBeCloseTo(0.8);
    expect(
      estimateCostUsd(
        { prompt: 500_000, completion: 0 },
        { inputPerMillion: 0.2, outputPerMillion: 0.6 },
      ),
    ).toBeCloseTo(0.1);
    expect(
      estimateCostUsd(
        { prompt: 10, completion: 10 },
        { inputPerMillion: null, outputPerMillion: null },
      ),
    ).toBeNull();
    expect(estimateCostUsd({ prompt: 10, completion: 10 }, undefined)).toBeNull();
  });
});

describe("withRetries", () => {
  const request: LlmCompletionRequest = { model: "m", messages: [], tools: [] };
  const options: LlmCallOptions = { timeoutMs: 100 };
  const completion: LlmCompletion = { content: "ok", toolCalls: [], model: "m" };

  it("retries a 429 and a 503 with backoff", async () => {
    const statuses = [429, 503];
    const sleeps: number[] = [];
    const inner: LlmTransport = {
      complete: async () => {
        const status = statuses.shift();
        if (status !== undefined) throw Object.assign(new Error(`HTTP ${status}`), { status });
        return completion;
      },
    };

    const transport = withRetries(inner, {
      retries: 3,
      baseDelayMs: 10,
      sleep: async (ms) => void sleeps.push(ms),
    });
    await expect(transport.complete(request, options)).resolves.toEqual(completion);
    expect(sleeps).toEqual([10, 20]);
    expect(transport.retriesUsed()).toBe(2);
  });

  it("waits for a concurrency-limit 429 to drain instead of backing off fast", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const inner: LlmTransport = {
      complete: async () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(
            new Error("429 gemma4 concurrency limit: max 5 simultaneous requests."),
            { status: 429 },
          );
        }
        return completion;
      },
    };

    const transport = withRetries(inner, {
      retries: 1,
      baseDelayMs: 10,
      sleep: async (ms) => void sleeps.push(ms),
    });
    await expect(transport.complete(request, options)).resolves.toEqual(completion);
    expect(sleeps).toEqual([CONCURRENCY_LIMIT_DRAIN_MS]);
  });

  it("does not retry a 400 and gives up after the budget", async () => {
    let calls = 0;
    const badRequest: LlmTransport = {
      complete: async () => {
        calls += 1;
        throw Object.assign(new Error("bad request"), { status: 400 });
      },
    };
    const transport = withRetries(badRequest, { retries: 2, sleep: async () => {} });
    await expect(transport.complete(request, options)).rejects.toThrow("bad request");
    expect(calls).toBe(1);

    let attempts = 0;
    const alwaysDown: LlmTransport = {
      complete: async () => {
        attempts += 1;
        throw Object.assign(new Error("down"), { status: 500 });
      },
    };
    const retrying = withRetries(alwaysDown, { retries: 2, baseDelayMs: 1, sleep: async () => {} });
    await expect(retrying.complete(request, options)).rejects.toThrow("down");
    expect(attempts).toBe(3);
  });

  it("retries a transport failure without a status", async () => {
    let calls = 0;
    const flaky: LlmTransport = {
      complete: async () => {
        calls += 1;
        if (calls === 1) throw new Error("socket hang up");
        return completion;
      },
    };
    const transport = withRetries(flaky, { retries: 1, baseDelayMs: 1, sleep: async () => {} });
    await expect(transport.complete(request, options)).resolves.toEqual(completion);
    expect(calls).toBe(2);
  });

  it("waits at least the 429 retry-after before retrying", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const limited: LlmTransport = {
      complete: async () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("429"), {
            status: 429,
            headers: { "retry-after": "3" },
          });
        }
        return completion;
      },
    };
    const transport = withRetries(limited, {
      retries: 1,
      baseDelayMs: 1,
      sleep: async (ms) => void sleeps.push(ms),
    });
    await expect(transport.complete(request, options)).resolves.toEqual(completion);
    expect(sleeps).toEqual([3_000]);
  });

  it("takes a limiter slot before every request", async () => {
    let time = 0;
    const sleeps: number[] = [];
    const limiter = new RequestLimiter({
      rpm: 1,
      now: () => time,
      sleep: async (ms) => {
        sleeps.push(ms);
        time += ms;
      },
    });
    let calls = 0;
    const inner: LlmTransport = {
      complete: async () => {
        calls += 1;
        return completion;
      },
    };
    const limited = withRequestLimit(inner, limiter);

    await limited.complete(request, options);
    await limited.complete(request, options);
    expect(calls).toBe(2);
    expect(sleeps).toHaveLength(1);
  });
});

describe("runComparison", () => {
  it("runs the dataset per model and reports the metrics", async () => {
    const seen: string[] = [];
    const results = await runComparison({
      models: ["fake-good", "fake-bad"],
      cases: CASES,
      clock: CLOCK,
      ranAt: "2026-01-14T18:00:00.000Z",
      priceTable: { models: { "fake-good": { inputPerMillion: 1, outputPerMillion: 1 } } },
      transportFactory: (model) =>
        model === "fake-good"
          ? createScriptedTransport(CLOCK)
          : {
              complete: async () => ({ content: "no sé", toolCalls: [], model }),
            },
      onModel: (result) => void seen.push(result.model),
    });

    expect(seen).toEqual(["fake-good", "fake-bad"]);
    expect(results).toHaveLength(2);

    const good = results[0]!;
    expect(good.toolAccuracy).toBe(1);
    expect(good.argsAccuracy).toBe(1);
    expect(good.fabricatedToolRate).toBe(0);
    expect(good.writeProposalRate).toBe(1);
    expect(good.costUsd).not.toBeNull();
    expect(good.cases.map((entry) => entry.id)).toEqual([
      "turnos-hoy",
      "servicios-que-tenes",
      "cancelar-hoy",
    ]);

    const bad = results[1]!;
    expect(bad.toolAccuracy).toBe(0);
    expect(bad.costUsd).toBeNull();
  });

  it("records a model failure instead of throwing", async () => {
    const results = await runComparison({
      models: ["boom"],
      cases: CASES,
      clock: CLOCK,
      transportFactory: () => ({
        complete: async () => {
          throw Object.assign(new Error("401 unauthorized"), { status: 401 });
        },
      }),
    });

    expect(results[0]?.error).toContain("boom");
    expect(results[0]?.passed).toBe(0);
    // Every case is kept as a diagnosed error instead of discarding the run.
    expect(results[0]?.cases).toHaveLength(3);
    expect(results[0]?.cases.every((entry) => entry.failure?.kind === "case_error")).toBe(true);
  });
});

describe("comparison artifacts", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("writes one JSON per model and keeps the latest per model", async () => {
    dir = mkdtempSync(join(tmpdir(), "mena-compare-"));
    const base: ModelRunResult = {
      model: "qwen3.8-flash",
      ranAt: "2026-01-14T18:00:00.000Z",
      total: 3,
      passed: 3,
      toolAccuracy: 1,
      argsAccuracy: 1,
      fabricatedToolRate: 0,
      writeProposalRate: 1,
      latencyMs: { p50: 10, p95: 20 },
      tokens: { prompt: 100, completion: 50, total: 150 },
      costUsd: null,
      skipped: 0,
      cases: [],
    };

    const first = writeModelResult(base, dir);
    expect(first.endsWith("2026-01-14-qwen3.8-flash.json")).toBe(true);
    writeModelResult({ ...base, ranAt: "2026-01-15T18:00:00.000Z", toolAccuracy: 0.5 }, dir);

    const loaded = loadModelResults(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.toolAccuracy).toBe(0.5);
  });

  it("renders the table with the missing-price note", () => {
    const table = renderComparisonTable(
      [
        {
          model: "a",
          ranAt: "2026-01-14T18:00:00.000Z",
          total: 3,
          passed: 3,
          toolAccuracy: 1,
          argsAccuracy: 0.9,
          fabricatedToolRate: 0,
          writeProposalRate: 1,
          latencyMs: { p50: 100, p95: 250 },
          tokens: { prompt: 1000, completion: 200, total: 1200 },
          costUsd: 0.0012,
          skipped: 0,
          cases: [],
        },
        {
          model: "b",
          ranAt: "2026-01-14T18:00:00.000Z",
          total: 3,
          passed: 1,
          toolAccuracy: 0.33,
          argsAccuracy: 0.33,
          fabricatedToolRate: 0.1,
          writeProposalRate: 0,
          latencyMs: { p50: 200, p95: 400 },
          tokens: { prompt: 900, completion: 100, total: 1000 },
          costUsd: null,
          skipped: 0,
          cases: [],
        },
      ],
      { note: "precios [VERIFY]", models: {} },
    );

    expect(table).toContain("| Modelo");
    expect(table).toContain("`a`");
    expect(table).toContain("100.0%");
    expect(table).toContain("$0.0012");
    expect(table).toContain("n/d");
    expect(table).toContain("Sin precios configurados para: b");
    expect(table).toContain("precios [VERIFY]");
    // Best tool accuracy first.
    expect(table.indexOf("`a`")).toBeLessThan(table.indexOf("`b`"));
  });

  it("emits a table Prettier would not reflow, with notes after a blank line", () => {
    const base: ModelRunResult = {
      model: "qwen3.6",
      ranAt: "2026-01-14T18:00:00.000Z",
      total: 87,
      passed: 60,
      toolAccuracy: 0.828,
      argsAccuracy: 0.563,
      fabricatedToolRate: 0.126,
      writeProposalRate: 1,
      latencyMs: { p50: 900, p95: 2400 },
      tokens: { prompt: 12_000, completion: 900, total: 12_900 },
      costUsd: null,
      skipped: 0,
      cases: [],
    };

    const table = renderComparisonTable(
      [
        base,
        {
          ...base,
          model: "deepseek-v4-flash",
          error: "Model deepseek-v4-flash failed",
          cases: [],
        },
      ],
      { note: "precios [VERIFY] y acentos: sí", models: {} },
    );

    const lines = table.split("\n");
    const tableLines = lines.filter((line) => line.startsWith("|"));
    // Every table row has the same width, so Prettier has nothing to pad.
    const widths = new Set(tableLines.map((line) => line.length));
    expect(widths.size).toBe(1);
    // The note is a blockquote and needs the blank line Prettier inserts.
    const noteIndex = lines.findIndex((line) => line.startsWith(">"));
    expect(noteIndex).toBeGreaterThan(0);
    expect(lines[noteIndex - 1]).toBe("");
    // The separator row is dashes only, filled to the column width.
    expect(tableLines[1]?.replace(/[\s|-]/gu, "")).toBe("");
    expect(tableLines[1]).toContain("----------");
  });

  it("replaces the README block between the markers", () => {
    dir = mkdtempSync(join(tmpdir(), "mena-readme-"));
    const readme = join(dir, "README.md");
    writeFileSync(
      readme,
      `# t\n\n${MODEL_COMPARISON_MARKERS.start}\n\nviejo\n\n${MODEL_COMPARISON_MARKERS.end}\n\ncola\n`,
      "utf8",
    );

    expect(updateReadmeTable("| nuevo |", readme)).toBe(true);
    const content = readFileSync(readme, "utf8");
    expect(content).toContain("| nuevo |");
    expect(content).not.toContain("viejo");
    expect(content).toContain("cola");

    writeFileSync(readme, "sin marcadores", "utf8");
    expect(updateReadmeTable("x", readme)).toBe(false);
  });
});

describe("eval:compare CLI", () => {
  it("refuses to run without an API key and touches nothing", async () => {
    const lines: string[] = [];
    const code = await main(["--models", "a,b"], {
      apiKey: "",
      stdout: (line) => void lines.push(line),
    });

    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("LLM_API_KEY");
  });
});
