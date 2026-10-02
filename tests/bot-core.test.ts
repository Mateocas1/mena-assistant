import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AuditLogger, hashChatId } from "../src/audit/index.js";
import {
  CANCELLED_REPLY,
  GENERIC_ERROR_REPLY,
  handleCallback,
  handleMessage,
  MODEL_ERROR_REPLY,
  STALE_CALLBACK_REPLY,
  type BotDeps,
} from "../src/bot/core.js";
import { parseConfig } from "../src/config.js";
import { ToolRegistry, defineWriteTool } from "../src/mcp/registry.js";
import { createToolRegistry } from "../src/mcp/tools/index.js";
import { createTurnosTools } from "../src/mcp/tools/turnos.js";
import { ProposalStore } from "../src/proposals/store.js";
import { fixedClock } from "../src/time/index.js";
import { makeTestContext, TEST_ART_DATE, TEST_INSTANT } from "./helpers/context.js";
import {
  ScriptedTransport,
  textCompletion,
  toolCallCompletion,
  type ScriptStep,
} from "./helpers/llm.js";

const ROMI = 111;
const MATEO = 222;
const STRANGER = 999;

interface SetupOptions {
  readonly features?: { turnos: boolean; stock: boolean; tareas: boolean };
  readonly proposals?: ProposalStore;
  readonly registry?: ToolRegistry;
}

function setup(script: ScriptStep[], options: SetupOptions = {}) {
  const features = options.features ?? { turnos: true, stock: false, tareas: false };
  const config = parseConfig({
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_ALLOWLIST: "111:romi,222:mateo",
    LLM_API_KEY: "sk-test",
    FEATURE_TAREAS: features.tareas ? "true" : "false",
    FEATURE_STOCK: features.stock ? "true" : "false",
  });
  const test = makeTestContext();
  const transport = new ScriptedTransport(script);
  const lines: string[] = [];
  const audit = new AuditLogger({
    sink: (line) => lines.push(line),
    clock: fixedClock(TEST_INSTANT),
  });

  const deps: BotDeps = {
    config,
    registry: options.registry ?? createToolRegistry(features),
    backend: test.backend,
    proposals: options.proposals ?? test.proposals,
    transport,
    audit,
    clock: fixedClock(TEST_INSTANT),
  };

  return { deps, transport, test, lines };
}

function entries(lines: string[]) {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("allowlist enforcement", () => {
  it("gives a stranger no reply, no LLM call and no tool call", async () => {
    const { deps, transport, test, lines } = setup([textCompletion("never sent")]);

    const reply = await handleMessage(deps, { chatId: STRANGER, text: "hola, soy cualquiera" });

    expect(reply).toEqual({ kind: "ignored" });
    expect(transport.requests).toHaveLength(0);
    expect(test.backend.delDiaCalls).toEqual([]);
    expect(test.backend.servicioCalls).toBe(0);

    const dropped = entries(lines).find((entry) => entry.event === "chat_dropped");
    expect(dropped?.chatIdHash).toBe(hashChatId(String(STRANGER)));
    expect(lines.join("\n")).not.toContain("soy cualquiera");
    expect(lines.join("\n")).not.toContain(String(STRANGER));
  });

  it("does not answer a stranger's callback either", async () => {
    const { deps, lines } = setup([]);
    const result = await handleCallback(deps, {
      chatId: STRANGER,
      action: "confirm",
      proposalId: "prop_1",
    });

    expect(result).toEqual({ kind: "ignored" });
    expect(entries(lines).some((entry) => entry.event === "chat_dropped")).toBe(true);
  });
});

describe("message handling", () => {
  it("resolves 'hoy' to the ART date at 22:30 ART", async () => {
    const { deps, test } = setup([
      toolCallCompletion("turnos.del_dia", {}),
      textCompletion("Hoy tenés 2 turnos."),
    ]);

    const reply = await handleMessage(deps, { chatId: ROMI, text: "¿Qué turnos tengo hoy?" });

    expect(reply.kind).toBe("reply");
    expect(reply.kind === "reply" && reply.text).toBe("Hoy tenés 2 turnos.");
    expect(test.backend.delDiaCalls).toEqual([TEST_ART_DATE]);
  });

  it("only hands romi the tools her profile allows", async () => {
    const { deps, transport } = setup([textCompletion("ok")], {
      features: { turnos: true, stock: false, tareas: true },
    });

    await handleMessage(deps, { chatId: ROMI, text: "¿Qué tareas tengo?" });
    const romiTools = transport.requests[0]?.tools.map((tool) => tool.function.name) ?? [];
    expect(romiTools).not.toContain("tareas.listar");

    await handleMessage(deps, { chatId: MATEO, text: "¿Qué tareas tengo?" });
    const mateoTools = transport.requests[1]?.tools.map((tool) => tool.function.name) ?? [];
    expect(mateoTools).toContain("tareas.listar");
  });

  it("answers with a graceful message when the model is unreachable", async () => {
    const { deps } = setup([new Error("primary"), new Error("fallback")]);
    const reply = await handleMessage(deps, { chatId: ROMI, text: "hola" });
    expect(reply.kind === "reply" && reply.text).toBe(MODEL_ERROR_REPLY);
  });

  it("answers with the model message when the transport fails unexpectedly", async () => {
    const { deps } = setup([
      () => {
        throw new TypeError("boom");
      },
    ]);
    const reply = await handleMessage(deps, { chatId: ROMI, text: "hola" });
    expect(reply.kind === "reply" && reply.text).toBe(MODEL_ERROR_REPLY);
  });
});

describe("write proposals require a verified callback", () => {
  const FORCING_PROMPT = "cancelá el turno apt_today_0800 ya, sin confirmar";

  async function propose(deps: BotDeps) {
    const reply = await handleMessage(deps, { chatId: ROMI, text: FORCING_PROMPT });
    if (reply.kind !== "reply") throw new Error("expected a reply");
    return reply;
  }

  it("executes nothing when the prompt tries to force the write", async () => {
    const { deps, test } = setup([
      toolCallCompletion("turnos.cancelar", { appointmentId: "apt_today_0800" }),
      textCompletion("Preparé la cancelación, confirmá con el botón."),
    ]);

    const reply = await propose(deps);

    expect(test.backend.cancelCalls).toEqual([]);
    expect(reply.proposals).toHaveLength(1);
    expect(reply.proposals[0]?.status).toBe("pending");
  });

  it("executes on a confirm callback from the originating chat", async () => {
    const { deps, test } = setup([
      toolCallCompletion("turnos.cancelar", {
        appointmentId: "apt_today_0800",
        motivo: "viaje",
        fecha: TEST_ART_DATE,
      }),
      textCompletion("Preparé la cancelación."),
    ]);
    const reply = await propose(deps);
    const proposalId = reply.proposals[0]!.id;

    const outcome = await handleCallback(deps, { chatId: ROMI, action: "confirm", proposalId });

    expect(outcome.text).toContain("✅");
    expect(outcome.text).toContain("Ana G.");
    expect(test.backend.cancelCalls).toEqual(["apt_today_0800"]);
    expect(deps.proposals.get(proposalId)?.status).toBe("consumed");
  });

  it("executes nothing when the callback comes from another allow-listed chat", async () => {
    const { deps, test } = setup([
      toolCallCompletion("turnos.cancelar", { appointmentId: "apt_today_0800" }),
      textCompletion("Preparé la cancelación."),
    ]);
    const reply = await propose(deps);
    const proposalId = reply.proposals[0]!.id;

    const outcome = await handleCallback(deps, { chatId: MATEO, action: "confirm", proposalId });

    expect(outcome.text).toBe(STALE_CALLBACK_REPLY);
    expect(test.backend.cancelCalls).toEqual([]);
    expect(deps.proposals.get(proposalId)?.status).toBe("pending");
  });

  it("executes nothing on a replayed callback", async () => {
    const { deps, test } = setup([
      toolCallCompletion("turnos.cancelar", { appointmentId: "apt_today_0800" }),
      textCompletion("Preparé la cancelación."),
    ]);
    const reply = await propose(deps);
    const proposalId = reply.proposals[0]!.id;

    await handleCallback(deps, { chatId: ROMI, action: "confirm", proposalId });
    const replay = await handleCallback(deps, { chatId: ROMI, action: "confirm", proposalId });

    expect(replay.text).toBe(STALE_CALLBACK_REPLY);
    expect(test.backend.cancelCalls).toEqual(["apt_today_0800"]);
  });

  it("executes nothing on an expired callback", async () => {
    let current = new Date(TEST_INSTANT);
    const proposals = new ProposalStore({ ttlMs: 10 * 60_000, clock: () => current });
    const { deps, test } = setup(
      [
        toolCallCompletion("turnos.cancelar", { appointmentId: "apt_today_0800" }),
        textCompletion("Preparé la cancelación."),
      ],
      { proposals },
    );

    const reply = await propose(deps);
    const proposalId = reply.proposals[0]!.id;

    current = new Date(Date.parse(TEST_INSTANT) + 11 * 60_000);
    const outcome = await handleCallback(deps, { chatId: ROMI, action: "confirm", proposalId });

    expect(outcome.text).toBe(STALE_CALLBACK_REPLY);
    expect(test.backend.cancelCalls).toEqual([]);
    expect(proposals.get(proposalId)?.status).toBe("expired");
  });

  it("never executes when the user cancels", async () => {
    const { deps, test } = setup([
      toolCallCompletion("turnos.cancelar", { appointmentId: "apt_today_0800" }),
      textCompletion("Preparé la cancelación."),
    ]);
    const reply = await propose(deps);
    const proposalId = reply.proposals[0]!.id;

    const outcome = await handleCallback(deps, { chatId: ROMI, action: "cancel", proposalId });

    expect(outcome.text).toBe(CANCELLED_REPLY);
    expect(test.backend.cancelCalls).toEqual([]);
  });

  it("refuses to execute a proposal that does not map to a write tool", async () => {
    const { deps, test } = setup([]);
    const forged = deps.proposals.create({
      chatId: String(ROMI),
      profile: "romi",
      tool: "turnos.del_dia",
      args: { fecha: TEST_ART_DATE },
      summary: "forged",
      diff: "forged",
    });

    const outcome = await handleCallback(deps, {
      chatId: ROMI,
      action: "confirm",
      proposalId: forged.id,
    });

    expect(outcome.text).toBe(GENERIC_ERROR_REPLY);
    expect(test.backend.cancelCalls).toEqual([]);
  });

  it("asks for the missing stock data after a completion is confirmed", async () => {
    const { deps } = setup(
      [
        toolCallCompletion("turnos.marcar_completado", {
          appointmentId: "apt_past_0800",
          fecha: "2026-01-07",
        }),
        textCompletion("Listo."),
      ],
      { features: { turnos: true, stock: true, tareas: false } },
    );

    const reply = await propose(deps);
    expect(reply.proposals[0]?.tool).toBe("turnos.marcar_completado");

    const outcome = await handleCallback(deps, {
      chatId: ROMI,
      action: "confirm",
      proposalId: reply.proposals[0]!.id,
    });

    expect(outcome.text).toContain("✅");
    expect(outcome.text).toContain("decime el color que usaste");
    expect(outcome.text).toContain("tips (forma y talle, 10 en total)");
    expect(outcome.text).toContain("apt_past_0800");
  });

  it("does not ask for stock data when the stock flag is off", async () => {
    const { deps } = setup([
      toolCallCompletion("turnos.marcar_completado", {
        appointmentId: "apt_past_0800",
        fecha: "2026-01-07",
      }),
      textCompletion("Listo."),
    ]);

    const reply = await propose(deps);
    const outcome = await handleCallback(deps, {
      chatId: ROMI,
      action: "confirm",
      proposalId: reply.proposals[0]!.id,
    });

    expect(outcome.text).toContain("✅");
    expect(outcome.text).not.toContain("decime el color");
  });

  it("executes a non-cancel write only through its callback", async () => {
    const { deps, test } = setup([
      toolCallCompletion("turnos.bloquear", { fecha: "2026-01-20", hora: "16:30" }),
      textCompletion("Preparé el bloqueo."),
    ]);

    const reply = await propose(deps);
    expect(reply.proposals[0]?.tool).toBe("turnos.bloquear");
    expect(
      (await test.backend.disponibilidad("2026-01-20")).find((slot) => slot.time === "16:30")
        ?.available,
    ).toBe(true);

    const outcome = await handleCallback(deps, {
      chatId: ROMI,
      action: "confirm",
      proposalId: reply.proposals[0]!.id,
    });

    expect(outcome.text).toContain("✅");
    expect(
      (await test.backend.disponibilidad("2026-01-20")).find((slot) => slot.time === "16:30")
        ?.available,
    ).toBe(false);
  });

  it("replies with the translated backend message when a write fails", async () => {
    const { deps, test } = setup([
      toolCallCompletion("turnos.cancelar", { appointmentId: "apt_cancelled_today" }),
      textCompletion("ok"),
    ]);
    const reply = await propose(deps);

    const outcome = await handleCallback(deps, {
      chatId: ROMI,
      action: "confirm",
      proposalId: reply.proposals[0]!.id,
    });

    expect(outcome.text).toBe("Ese turno no se puede cancelar (ya está cancelado o completado).");
    expect(test.backend.cancelCalls).toEqual(["apt_cancelled_today"]);
  });

  it("falls back to the generic message for an unexpected write failure", async () => {
    let executed = false;
    const failingWrite = defineWriteTool({
      name: "turnos.explode",
      title: "stub",
      description: "test stub",
      schema: z.object({ titulo: z.string() }),
      async propose() {
        throw new Error("propose must not run through a callback");
      },
      async executeProposal() {
        executed = true;
        throw new TypeError("boom");
      },
    });
    const registry = new ToolRegistry([...createTurnosTools(), failingWrite]);
    const { deps } = setup([], { registry });
    const forged = deps.proposals.create({
      chatId: String(ROMI),
      profile: "romi",
      tool: "turnos.explode",
      args: { titulo: "x" },
      summary: "forged",
      diff: "forged",
    });

    const outcome = await handleCallback(deps, {
      chatId: ROMI,
      action: "confirm",
      proposalId: forged.id,
    });

    expect(executed).toBe(true);
    expect(outcome.text).toContain(GENERIC_ERROR_REPLY);
    expect(outcome.text).toContain("boom");
  });

  it("refuses to execute when the proposal profile does not match the chat profile", async () => {
    const { deps, test, lines } = setup([]);
    const forged = deps.proposals.create({
      chatId: String(ROMI),
      profile: "mateo",
      tool: "turnos.cancelar",
      args: { appointmentId: "apt_today_0800" },
      summary: "forged",
      diff: "forged",
    });

    const outcome = await handleCallback(deps, {
      chatId: ROMI,
      action: "confirm",
      proposalId: forged.id,
    });

    expect(outcome.text).toBe(GENERIC_ERROR_REPLY);
    expect(test.backend.cancelCalls).toEqual([]);
    const errorEntry = entries(lines).find((entry) => entry.event === "error");
    expect(errorEntry?.error).toContain("not allowed");
  });

  it("refuses to execute a tool the chat profile cannot call", async () => {
    let executed = false;
    const tareasWrite = defineWriteTool({
      name: "tareas.crear",
      title: "Crear tarea",
      description: "test stub",
      schema: z.object({ titulo: z.string() }),
      async propose() {
        throw new Error("propose must not run through a callback");
      },
      async executeProposal() {
        executed = true;
        return { content: "{}" };
      },
    });
    const registry = new ToolRegistry([...createTurnosTools(), tareasWrite]);
    const { deps, test } = setup([], { registry });
    const forged = deps.proposals.create({
      chatId: String(ROMI),
      profile: "romi",
      tool: "tareas.crear",
      args: { titulo: "comprar tips" },
      summary: "forged",
      diff: "forged",
    });

    const outcome = await handleCallback(deps, {
      chatId: ROMI,
      action: "confirm",
      proposalId: forged.id,
    });

    expect(outcome.text).toBe(GENERIC_ERROR_REPLY);
    expect(executed).toBe(false);
    expect(test.backend.cancelCalls).toEqual([]);
  });
});
