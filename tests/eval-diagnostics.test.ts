import { describe, expect, it } from "vitest";
import { runEvals } from "../evals/runner.js";
import type { EvalCase } from "../evals/types.js";
import { fixedClock } from "../src/time/index.js";
import { ScriptedTransport, textCompletion, toolCallCompletion } from "./helpers/llm.js";

const CLOCK = fixedClock("2026-01-14T15:00:00Z");

function makeCase(overrides: Partial<EvalCase> & Pick<EvalCase, "id" | "expectedTool">): EvalCase {
  return {
    question: "¿Qué turnos tengo hoy?",
    profile: "romi",
    ...overrides,
  };
}

async function runOne(evalCase: EvalCase, transport: ScriptedTransport) {
  const report = await runEvals({
    cases: [evalCase],
    transport,
    clock: CLOCK,
    model: "scripted",
    fallbackModel: "scripted",
  });
  return report.results[0]!;
}

describe("eval case diagnosis", () => {
  it("lets a read prerequisite run without hiding the expected write tool", async () => {
    const evalCase = makeCase({
      id: "read-then-write",
      question: "Marcá el turno apt_past_0800 como completado",
      expectedTool: "turnos.marcar_completado",
      expectedArgs: { appointmentId: "apt_past_0800" },
    });
    const transport = new ScriptedTransport([
      toolCallCompletion("turnos.del_dia", {}),
      toolCallCompletion("turnos.marcar_completado", { appointmentId: "apt_past_0800" }, "call_2"),
      textCompletion("Listo, te preparo la confirmación."),
    ]);

    const result = await runOne(evalCase, transport);

    expect(result.toolMatched).toBe(true);
    expect(result.argsMatched).toBe(true);
    expect(result.actualTool).toBe("turnos.marcar_completado");
    expect(result.actualStatus).toBe("proposal");
    expect(result.fabricated).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.calls.map((call) => call.tool)).toEqual([
      "turnos.del_dia",
      "turnos.marcar_completado",
    ]);
  });

  it("classifies a wrong-but-real tool as tool confusion, not fabrication", async () => {
    const evalCase = makeCase({
      id: "confusion",
      question: "Cancelá el turno apt_today_1400",
      expectedTool: "turnos.cancelar",
      expectedArgs: { appointmentId: "apt_today_1400" },
    });
    const transport = new ScriptedTransport([
      toolCallCompletion("turnos.del_dia", {}),
      textCompletion("Hoy tenés dos turnos."),
    ]);

    const result = await runOne(evalCase, transport);

    expect(result.toolMatched).toBe(false);
    expect(result.fabricated).toBe(false);
    expect(result.actualTool).toBe("turnos.del_dia");
    expect(result.failure).toEqual({ kind: "tool_confusion", detail: "turnos.del_dia" });
    expect(result.unexpectedTools).toEqual(["turnos.del_dia"]);
  });

  it("classifies an unknown or unwanted tool as hallucination", async () => {
    const evalCase = makeCase({
      id: "no-tool",
      question: "¿Qué tareas tengo?",
      expectedTool: null,
    });
    const transport = new ScriptedTransport([
      toolCallCompletion("turnos.pagos_pendientes", {}),
      textCompletion("No pude ver tareas."),
    ]);

    const result = await runOne(evalCase, transport);

    expect(result.toolMatched).toBe(false);
    expect(result.fabricated).toBe(true);
    expect(result.failure?.kind).toBe("hallucinated_tool");
  });

  it("records both argument sets and the mismatch reason for a wrong day", async () => {
    const evalCase = makeCase({
      id: "wrong-day",
      expectedTool: "turnos.del_dia",
      expectedArgs: { fecha: "2026-01-15" },
    });
    const transport = new ScriptedTransport([
      toolCallCompletion("turnos.del_dia", { fecha: "2026-01-14" }),
      textCompletion("Listo."),
    ]);

    const result = await runOne(evalCase, transport);

    expect(result.toolMatched).toBe(true);
    expect(result.argsMatched).toBe(false);
    expect(result.expectedArgs).toEqual({ fecha: "2026-01-15" });
    expect(result.actualArgs).toEqual({ fecha: "2026-01-14" });
    expect(result.failure).toEqual({
      kind: "wrong_date",
      detail: "fecha: esperado 2026-01-15, llegó 2026-01-14",
    });
  });

  it("classifies an omitted non-default argument as missing_arg", async () => {
    const evalCase = makeCase({
      id: "missing-arg",
      expectedTool: "stock.servicios_recientes",
      expectedArgs: { limit: 5 },
    });
    const transport = new ScriptedTransport([
      toolCallCompletion("stock.servicios_recientes", {}),
      textCompletion("Listo."),
    ]);

    const result = await runOne(evalCase, transport);

    expect(result.argsMatched).toBe(false);
    expect(result.failure?.kind).toBe("missing_arg");
    expect(result.failure?.detail).toContain("limit");
  });

  it("accepts an omitted `fecha` when the tool's default is today", async () => {
    const evalCase = makeCase({
      id: "omitted-default",
      expectedTool: "turnos.del_dia",
      expectedArgs: { fecha: "2026-01-14" },
    });
    const transport = new ScriptedTransport([
      toolCallCompletion("turnos.del_dia", {}),
      textCompletion("Listo."),
    ]);

    const result = await runOne(evalCase, transport);

    expect(result.argsMatched).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("flags a write proposal the case did not ask for", async () => {
    const evalCase = makeCase({
      id: "unexpected-write",
      question: "¿Qué servicios tenés?",
      expectedTool: "turnos.servicios",
      expectedArgs: {},
    });
    const transport = new ScriptedTransport([
      toolCallCompletion("turnos.cancelar", { appointmentId: "apt_today_1400" }),
      textCompletion("Te preparo la cancelación."),
    ]);

    const result = await runOne(evalCase, transport);

    expect(result.toolMatched).toBe(false);
    expect(result.actualStatus).toBe("proposal");
    expect(result.failure?.kind).toBe("unexpected_write");
  });

  it("asks for a missing question instead of counting it as a pass", async () => {
    const evalCase = makeCase({
      id: "should-ask",
      question: "No sé qué turno cancelar",
      expectedTool: null,
      expectsQuestion: true,
    });
    const transport = new ScriptedTransport([textCompletion("Ya está, cancelado.")]);

    const result = await runOne(evalCase, transport);

    expect(result.failure?.kind).toBe("should_have_asked");
    expect(result.ok).toBe(false);
  });

  it("records a provider failure as a case_error instead of aborting the model", async () => {
    const evalCase = makeCase({ id: "provider-down", expectedTool: "turnos.del_dia" });
    const transport = new ScriptedTransport([
      new Error("503 service unavailable"),
      new Error("503 service unavailable"),
    ]);

    const report = await runEvals({
      cases: [evalCase],
      transport,
      clock: CLOCK,
      model: "scripted",
      fallbackModel: "scripted",
    });

    expect(report.total).toBe(1);
    expect(report.passed).toBe(0);
    expect(report.results[0]?.failure).toMatchObject({ kind: "case_error" });
    expect(report.results[0]?.calls).toEqual([]);
  });

  it("excludes a rate-limited case from accuracy instead of calling it a failure", async () => {
    const ok = makeCase({ id: "scored", expectedTool: "turnos.del_dia", expectedArgs: {} });
    const limited = makeCase({ id: "limited", expectedTool: "turnos.del_dia", expectedArgs: {} });
    const transport = new ScriptedTransport([
      toolCallCompletion("turnos.del_dia", {}),
      textCompletion("Listo."),
      Object.assign(
        new Error("429 Rate limit exceeded. Limit resets at: 2026-10-02 02:46:16 UTC"),
        {
          status: 429,
        },
      ),
    ]);

    const report = await runEvals({
      cases: [ok, limited],
      transport,
      clock: CLOCK,
      model: "scripted",
      fallbackModel: "",
    });

    expect(report.total).toBe(2);
    expect(report.skipped).toBe(1);
    expect(report.passed).toBe(1);
    // The skipped case is out of the denominator, so the scored case is 100%.
    expect(report.toolAccuracy).toBe(1);
    expect(report.argsAccuracy).toBe(1);
    expect(report.results.find((entry) => entry.id === "limited")?.failure?.kind).toBe(
      "skipped_rate_limit",
    );
  });
});
