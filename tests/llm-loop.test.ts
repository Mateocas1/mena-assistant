import { describe, expect, it } from "vitest";
import { TurnosNotConfiguredError } from "../src/adapters/turnos/client.js";
import { AuditLogger, type AuditEntry } from "../src/audit/index.js";
import { parseConfig } from "../src/config.js";
import { CAP_REPLY, INVALID_ARGUMENTS_REPLY, runToolLoop } from "../src/llm/loop.js";
import { buildSystemPrompt } from "../src/llm/prompt.js";
import { LlmError } from "../src/llm/types.js";
import { createToolRegistry } from "../src/mcp/tools/index.js";
import { fixedClock } from "../src/time/index.js";
import { makeTestContext, TEST_INSTANT } from "./helpers/context.js";
import {
  ScriptedTransport,
  textCompletion,
  toolCallCompletion,
  toolCallsCompletion,
  type ScriptStep,
} from "./helpers/llm.js";

interface SetupOptions {
  readonly model?: string;
  readonly fallbackModel?: string;
  readonly maxToolCalls?: number;
  readonly tools?: string[];
}

function setup(script: ScriptStep[], options: SetupOptions = {}) {
  const transport = new ScriptedTransport(script);
  const test = makeTestContext();
  const lines: string[] = [];
  const audit = new AuditLogger({
    sink: (line) => lines.push(line),
    clock: fixedClock(TEST_INSTANT),
  });
  const registry = createToolRegistry({ turnos: true, stock: false, tareas: false });
  const tools = options.tools
    ? registry.list().filter((tool) => options.tools?.includes(tool.name))
    : registry.forProfile("romi");

  const run = (userMessage = "¿Qué turnos tengo hoy?") =>
    runToolLoop({
      transport,
      tools,
      context: test.context,
      config: {
        model: options.model ?? "deepseek-v4-flash",
        fallbackModel: options.fallbackModel ?? "glm5.3-flash",
        timeoutMs: 30_000,
        maxToolCalls: options.maxToolCalls ?? 6,
      },
      audit,
      systemPrompt: "system prompt",
      userMessage,
    });

  return { transport, test, lines, audit, tools, run };
}

describe("LLM tool loop", () => {
  it("runs a read tool and returns the final answer", async () => {
    const { run, transport, test } = setup([
      toolCallCompletion("turnos.del_dia", {}),
      textCompletion("Tenés 2 turnos hoy."),
    ]);

    const result = await run();

    expect(result.reply).toBe("Tenés 2 turnos hoy.");
    expect(result.stoppedReason).toBe("completed");
    expect(result.usedFallback).toBe(false);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ tool: "turnos.del_dia", status: "ok" });
    expect(result.usage).toEqual({ prompt: 20, completion: 10, total: 30 });

    // The tool result was fed back to the model as a tool message.
    const secondRequest = transport.requests[1];
    const toolMessage = secondRequest?.messages.find((message) => message.role === "tool");
    expect(toolMessage?.toolCallId).toBe("call_1");
    expect(toolMessage?.content).toContain("apt_today_0800");

    // ARG date resolution happened inside the tool.
    expect(test.backend.servicioCalls).toBe(0);
  });

  it("passes the configured model and timeout on every call", async () => {
    const env = parseConfig({
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_ALLOWLIST: "111:romi",
      LLM_API_KEY: "sk",
      LLM_MODEL: "qwen3.8-flash",
    });
    const { run, transport } = setup([textCompletion("ok")], { model: env.llm.model });

    await run();

    expect(transport.requests[0]?.model).toBe("qwen3.8-flash");
    expect(transport.calls[0]?.timeoutMs).toBe(30_000);
  });

  it("retries once when the model sends invalid JSON arguments", async () => {
    const { run, test } = setup([
      toolCallCompletion("turnos.disponibilidad", "{not json"),
      toolCallCompletion("turnos.disponibilidad", { fecha: "hoy" }, "call_2"),
      textCompletion("Tenés libres 11:00 y 18:30."),
    ]);

    const result = await run();

    expect(result.stoppedReason).toBe("completed");
    expect(result.reply).toContain("11:00");
    expect(result.toolCalls.map((call) => call.status)).toEqual(["error", "ok"]);
    expect(test.backend.cancelCalls).toEqual([]);
  });

  it("gives up gracefully after the retry also fails", async () => {
    const { run } = setup([
      toolCallCompletion("turnos.disponibilidad", "{not json"),
      toolCallCompletion("turnos.disponibilidad", "{still not json", "call_2"),
    ]);

    const result = await run();

    expect(result.stoppedReason).toBe("invalid_arguments");
    expect(result.reply).toBe(INVALID_ARGUMENTS_REPLY);
    expect(result.toolCalls.every((call) => call.status === "error")).toBe(true);
  });

  it("retries once when arguments fail schema validation", async () => {
    const { run } = setup([
      // fecha must be a string.
      toolCallCompletion("turnos.del_dia", { fecha: 123 }),
      toolCallCompletion("turnos.del_dia", { fecha: "hoy" }, "call_2"),
      textCompletion("Listo."),
    ]);

    const result = await run();

    expect(result.toolCalls.map((call) => call.status)).toEqual(["error", "ok"]);
    expect(result.reply).toBe("Listo.");
  });

  it("enforces the hard cap of tool calls per turn", async () => {
    const script: ScriptStep[] = Array.from({ length: 8 }, (_value, index) =>
      toolCallCompletion("turnos.servicios", {}, `call_${index + 1}`),
    );
    const { run, test } = setup(script, { maxToolCalls: 6 });

    const result = await run();

    expect(result.stoppedReason).toBe("tool_call_cap");
    expect(result.reply).toBe(CAP_REPLY);
    expect(result.toolCalls).toHaveLength(6);
    expect(test.backend.servicioCalls).toBe(6);
  });

  it("falls back to the fallback model when the primary fails", async () => {
    const { run, transport } = setup([new Error("primary exploded"), textCompletion("Hola.")], {
      model: "deepseek-v4-flash",
      fallbackModel: "glm5.3-flash",
    });

    const result = await run();

    expect(result.usedFallback).toBe(true);
    expect(result.model).toBe("glm5.3-flash");
    expect(result.reply).toBe("Hola.");
    expect(transport.requests.map((request) => request.model)).toEqual([
      "deepseek-v4-flash",
      "glm5.3-flash",
    ]);
  });

  it("throws a typed error when both models fail", async () => {
    const { run } = setup([new Error("primary"), new Error("fallback")]);
    await expect(run()).rejects.toBeInstanceOf(LlmError);
  });

  it("caps to one write proposal per turn", async () => {
    const { run, test, lines } = setup([
      toolCallsCompletion([
        { name: "turnos.cancelar", args: { appointmentId: "apt_today_0800" }, id: "call_1" },
        { name: "turnos.cancelar", args: { appointmentId: "apt_today_1400" }, id: "call_2" },
      ]),
      textCompletion("Confirmá el primero."),
    ]);

    const result = await run();

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.args).toMatchObject({ appointmentId: "apt_today_0800" });
    expect(result.toolCalls.map((call) => call.status)).toEqual(["proposal", "denied"]);
    expect(test.backend.cancelCalls).toEqual([]);

    const denied = lines
      .map((line) => JSON.parse(line) as AuditEntry)
      .find((entry) => entry.status === "denied");
    expect(denied?.tool).toBe("turnos.cancelar");
  });

  it("tells the model to ask for the pending proposal before another write", async () => {
    const { run, transport } = setup([
      toolCallsCompletion([
        { name: "turnos.cancelar", args: { appointmentId: "apt_today_0800" }, id: "call_1" },
        { name: "turnos.cancelar", args: { appointmentId: "apt_today_1400" }, id: "call_2" },
      ]),
      textCompletion("ok"),
    ]);

    await run();

    const toolMessages =
      transport.requests[1]?.messages.filter((message) => message.role === "tool") ?? [];
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[1]?.content).toContain("confirm or cancel the pending proposal");
  });

  it("still allows read tools after a write proposal", async () => {
    const { run } = setup([
      toolCallsCompletion([
        { name: "turnos.cancelar", args: { appointmentId: "apt_today_0800" }, id: "call_1" },
        { name: "turnos.servicios", args: {}, id: "call_2" },
      ]),
      textCompletion("ok"),
    ]);

    const result = await run();

    expect(result.toolCalls.map((call) => call.status)).toEqual(["proposal", "ok"]);
  });

  it("hands the model fresh ART date anchors in the tool descriptions", async () => {
    const { run, transport } = setup([
      toolCallCompletion("turnos.del_dia", {}),
      textCompletion("ok"),
    ]);

    await run();

    const specs = transport.requests[0]?.tools ?? [];
    const delDia = specs.find((spec) => spec.function.name === "turnos.del_dia");
    const servicios = specs.find((spec) => spec.function.name === "turnos.servicios");

    // The loop uses the conversation clock (01:30 UTC = 22:30 ART on Jan 14).
    expect(delDia?.function.description).toContain("hoy=2026-01-14");
    expect(delDia?.function.description).toContain("esta semana=2026-01-12..2026-01-18");
    expect(servicios?.function.description).not.toContain("hoy=");
  });

  it("anchors the ART dates in the system prompt", () => {
    const prompt = buildSystemPrompt(fixedClock(TEST_INSTANT));
    expect(prompt).toContain("Hoy es 2026-01-14");
    expect(prompt).toContain("esta semana va del 2026-01-12 al 2026-01-18");
    expect(prompt).toContain("No calcules fechas");
  });

  it("relays a typed adapter error's user-facing copy to the model", async () => {
    const { run, transport, test } = setup([
      toolCallCompletion("turnos.servicios", {}),
      textCompletion("Aviso a Mateo."),
    ]);
    test.backend.servicios = async () => {
      throw new TurnosNotConfiguredError();
    };

    const result = await run();

    const toolMessage =
      transport.requests[1]?.messages.find((message) => message.role === "tool") ?? undefined;
    expect(toolMessage?.content).toContain("no está habilitado");
    expect(result.reply).toBe("Aviso a Mateo.");
    expect(result.toolCalls[0]).toMatchObject({ tool: "turnos.servicios", status: "error" });
    expect(test.backend.cancelCalls).toEqual([]);
  });

  it("turns a write tool call into a proposal without executing it", async () => {
    const { run, test } = setup([
      toolCallCompletion("turnos.cancelar", { appointmentId: "apt_today_0800", motivo: "viaje" }),
      textCompletion("Preparé la cancelación: confirmá con el botón."),
    ]);

    const result = await run("Cancelá el turno de Ana G. del 8:00");

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.tool).toBe("turnos.cancelar");
    expect(result.toolCalls[0]?.status).toBe("proposal");
    expect(test.backend.cancelCalls).toEqual([]);
    expect(test.proposals.get(result.proposals[0]!.id)?.status).toBe("pending");
  });

  it("reports an unknown tool back to the model instead of crashing", async () => {
    const { run, test } = setup([
      toolCallCompletion("tareas.listar", {}),
      textCompletion("No tengo esa herramienta."),
    ]);

    const result = await run();

    expect(result.toolCalls[0]).toMatchObject({ tool: "tareas.listar", status: "error" });
    expect(result.reply).toBe("No tengo esa herramienta.");
    expect(test.backend.cancelCalls).toEqual([]);
  });

  it("audits every tool call with model, latency and tokens", async () => {
    const { run, lines } = setup([
      toolCallCompletion("turnos.servicios", {}),
      textCompletion("Hay 6 servicios."),
    ]);

    await run();

    const toolEntries = lines
      .map((line) => JSON.parse(line) as AuditEntry)
      .filter((entry) => entry.event === "tool_call");
    expect(toolEntries).toHaveLength(1);
    expect(toolEntries[0]).toMatchObject({
      tool: "turnos.servicios",
      status: "ok",
      model: "deepseek-v4-flash",
      tokens: { prompt: 10, completion: 5, total: 15 },
    });
    expect(toolEntries[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
