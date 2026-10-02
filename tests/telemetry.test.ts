import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { safeAttributes, startTelemetry, withSpan } from "../src/telemetry/tracer.js";

const exporter = new InMemorySpanExporter();

function useMemoryTracer(): void {
  exporter.reset();
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
}

afterEach(() => {
  trace.disable();
  exporter.reset();
});

describe("telemetry", () => {
  it("stays a no-op without an OTLP endpoint", async () => {
    const stop = startTelemetry({});
    await withSpan("should.not.be.recorded", {}, () => undefined);
    expect(exporter.getFinishedSpans()).toEqual([]);
    await expect(stop()).resolves.toBeUndefined();
  });

  it("records a span with redacted attributes", async () => {
    useMemoryTracer();

    await withSpan(
      "tool.call",
      {
        tool: "turnos.cancelar",
        args: { appointmentId: "apt_1", clientPhone: "+54 9 11 5555 6666", fecha: "2026-01-14" },
      },
      (span) => {
        span.setAttribute("outcome", "proposal");
      },
    );

    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("tool.call");
    expect(span?.attributes).toMatchObject({
      tool: "turnos.cancelar",
      outcome: "proposal",
    });
    const serialized = JSON.stringify(span?.attributes);
    expect(serialized).not.toContain("5555");
    expect(serialized).not.toContain("+54");
    expect(serialized).toContain("apt_1");
  });

  it("marks a failing span as error and rethrows", async () => {
    useMemoryTracer();

    await expect(
      withSpan("http.request", { "url.path": "/assistant/summary" }, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(2);
    expect(span?.events.some((event) => event.name === "exception")).toBe(true);
  });

  it("drops unusable attribute values and serialises objects", () => {
    expect(
      safeAttributes({
        keep: "value",
        count: 3,
        flag: true,
        list: ["a", "b"],
        object: { nested: 1 },
        missing: undefined,
        nothing: null,
      }),
    ).toEqual({
      keep: "value",
      count: 3,
      flag: true,
      list: ["a", "b"],
      object: '{"nested":1}',
    });
  });

  it("wires bot, LLM and tool spans through the real pipeline", async () => {
    useMemoryTracer();

    const { AuditLogger } = await import("../src/audit/index.js");
    const { runToolLoop } = await import("../src/llm/loop.js");
    const { createToolRegistry } = await import("../src/mcp/tools/index.js");
    const { fixedClock } = await import("../src/time/index.js");
    const { makeTestContext, TEST_INSTANT } = await import("./helpers/context.js");
    const { ScriptedTransport, textCompletion, toolCallCompletion } =
      await import("./helpers/llm.js");

    const test = makeTestContext();
    const registry = createToolRegistry({ turnos: true, stock: false, tareas: false });

    await runToolLoop({
      transport: new ScriptedTransport([
        toolCallCompletion("turnos.del_dia", {}),
        textCompletion("Listo."),
      ]),
      tools: registry.forProfile("romi"),
      context: test.context,
      config: {
        model: "test-model",
        fallbackModel: "test-fallback",
        timeoutMs: 1_000,
        maxToolCalls: 6,
      },
      audit: new AuditLogger({ sink: () => {}, clock: fixedClock(TEST_INSTANT) }),
      systemPrompt: "system",
      userMessage: "¿Qué turnos tengo hoy?",
    });

    const names = exporter.getFinishedSpans().map((span) => span.name);
    expect(names).toContain("tool.call");
    expect(names.filter((name) => name === "llm.call")).toHaveLength(2);
    const toolSpan = exporter.getFinishedSpans().find((span) => span.name === "tool.call");
    expect(toolSpan?.attributes).toMatchObject({ tool: "turnos.del_dia" });
  });
});
