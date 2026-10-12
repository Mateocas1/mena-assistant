import { describe, expect, it } from "vitest";
import { AuditLogger } from "../src/audit/index.js";
import { handleCallback, handleMessage, type BotDeps } from "../src/bot/core.js";
import { ConversationMemory } from "../src/bot/memory.js";
import { parseConfig } from "../src/config.js";
import { createToolRegistry } from "../src/mcp/tools/index.js";
import type { Clock } from "../src/time/index.js";
import { fixedClock } from "../src/time/index.js";
import { makeTestContext, TEST_INSTANT } from "./helpers/context.js";
import {
  ScriptedTransport,
  textCompletion,
  toolCallCompletion,
  type ScriptStep,
} from "./helpers/llm.js";

const ROMI = 111;
const MATEO = 222;

function movableClock(start: string) {
  let now = new Date(start).getTime();
  const clock: Clock = () => new Date(now);
  return { clock, advanceMinutes: (minutes: number) => (now += minutes * 60_000) };
}

function setup(script: ScriptStep[], memory: ConversationMemory) {
  const config = parseConfig({
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_ALLOWLIST: "111:romi,222:mateo",
    LLM_API_KEY: "sk-test",
    FEATURE_STOCK: "true",
  });
  const test = makeTestContext();
  const transport = new ScriptedTransport(script);
  const deps: BotDeps = {
    config,
    registry: createToolRegistry({ turnos: true, stock: true, tareas: false }),
    backend: test.backend,
    proposals: test.proposals,
    transport,
    audit: new AuditLogger({ sink: () => {}, clock: fixedClock(TEST_INSTANT) }),
    clock: fixedClock(TEST_INSTANT),
    memory,
  };
  return { deps, transport };
}

function conversation(request: { messages: readonly { role: string; content: string | null }[] }) {
  return request.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => `${message.role}: ${message.content ?? ""}`);
}

describe("ConversationMemory", () => {
  it("keeps the exchanges of one chat in order", () => {
    const memory = new ConversationMemory({ clock: fixedClock(TEST_INSTANT) });
    memory.record("111", "hola", "¿qué color usaste?");
    memory.record("111", "nude glitter 118", "¿y los tips?");

    expect(memory.history("111")).toEqual([
      { role: "user", content: "hola" },
      { role: "assistant", content: "¿qué color usaste?" },
      { role: "user", content: "nude glitter 118" },
      { role: "assistant", content: "¿y los tips?" },
    ]);
  });

  it("never shares history between chats", () => {
    const memory = new ConversationMemory({ clock: fixedClock(TEST_INSTANT) });
    memory.record("111", "hola", "hola Romi");

    expect(memory.history("222")).toEqual([]);
  });

  it("forgets a chat after the idle window", () => {
    const time = movableClock(TEST_INSTANT);
    const memory = new ConversationMemory({ clock: time.clock, idleMinutes: 30 });
    memory.record("111", "hola", "hola Romi");

    time.advanceMinutes(29);
    expect(memory.history("111")).toHaveLength(2);

    time.advanceMinutes(31);
    expect(memory.history("111")).toEqual([]);
  });

  it("keeps only the most recent exchanges", () => {
    const memory = new ConversationMemory({ clock: fixedClock(TEST_INSTANT), maxExchanges: 2 });
    memory.record("111", "uno", "1");
    memory.record("111", "dos", "2");
    memory.record("111", "tres", "3");

    expect(memory.history("111").map((message) => message.content)).toEqual([
      "dos",
      "2",
      "tres",
      "3",
    ]);
  });

  it("replaces the history with a single bot question", () => {
    const memory = new ConversationMemory({ clock: fixedClock(TEST_INSTANT) });
    memory.record("111", "completá el turno de ana", "Preparé la propuesta.");
    memory.replaceWithAssistant("111", "Decime el color que usaste.");

    expect(memory.history("111")).toEqual([
      { role: "assistant", content: "Decime el color que usaste." },
    ]);
  });
});

describe("multi-turn conversation", () => {
  it("sends the earlier answers of the same chat to the model", async () => {
    const memory = new ConversationMemory({ clock: fixedClock(TEST_INSTANT) });
    const { deps, transport } = setup(
      [textCompletion("¿Qué tips usaste?"), textCompletion("Anotado.")],
      memory,
    );

    await handleMessage(deps, {
      chatId: ROMI,
      text: "registrá el soft gel de ana, color Nude Glitter 118",
    });
    await handleMessage(deps, { chatId: ROMI, text: "4 del talle 3 y 6 del talle 5" });

    expect(conversation(transport.requests[1]!)).toEqual([
      "user: registrá el soft gel de ana, color Nude Glitter 118",
      "assistant: ¿Qué tips usaste?",
      "user: 4 del talle 3 y 6 del talle 5",
    ]);
  });

  it("does not leak one chat's conversation into another", async () => {
    const memory = new ConversationMemory({ clock: fixedClock(TEST_INSTANT) });
    const { deps, transport } = setup(
      [textCompletion("Hola Romi."), textCompletion("Hola.")],
      memory,
    );

    await handleMessage(deps, { chatId: ROMI, text: "color Nude Glitter 118" });
    await handleMessage(deps, { chatId: MATEO, text: "hola" });

    expect(conversation(transport.requests[1]!)).toEqual(["user: hola"]);
  });

  it("does not remember a turn the model never answered", async () => {
    const memory = new ConversationMemory({ clock: fixedClock(TEST_INSTANT) });
    const { deps } = setup([new Error("network down")], memory);

    await handleMessage(deps, { chatId: ROMI, text: "hola" });

    expect(memory.history(String(ROMI))).toEqual([]);
  });

  it("starts the next message from the stock question after a completion is confirmed", async () => {
    const memory = new ConversationMemory({ clock: fixedClock(TEST_INSTANT) });
    const { deps, transport } = setup(
      [
        toolCallCompletion("turnos.marcar_completado", {
          appointmentId: "apt_past_0800",
          fecha: "2026-01-07",
        }),
        textCompletion("Preparé la propuesta."),
        textCompletion("Anotado."),
      ],
      memory,
    );

    const reply = await handleMessage(deps, { chatId: ROMI, text: "completá el turno de ana" });
    if (reply.kind !== "reply") throw new Error("expected a reply");
    const outcome = await handleCallback(deps, {
      chatId: ROMI,
      action: "confirm",
      proposalId: reply.proposals[0]!.id,
    });
    await handleMessage(deps, { chatId: ROMI, text: "Nude Glitter 118" });

    expect(conversation(transport.requests[2]!)).toEqual([
      `assistant: ${outcome.text}`,
      "user: Nude Glitter 118",
    ]);
  });

  it("forgets the conversation once a proposal is confirmed without a follow-up", async () => {
    const memory = new ConversationMemory({ clock: fixedClock(TEST_INSTANT) });
    const { deps } = setup(
      [
        toolCallCompletion("turnos.cancelar", { appointmentId: "apt_today_0800", motivo: "viaje" }),
        textCompletion("Preparé la cancelación."),
      ],
      memory,
    );

    const reply = await handleMessage(deps, { chatId: ROMI, text: "cancelá el turno de las 8" });
    if (reply.kind !== "reply") throw new Error("expected a reply");
    await handleCallback(deps, {
      chatId: ROMI,
      action: "confirm",
      proposalId: reply.proposals[0]!.id,
    });

    expect(memory.history(String(ROMI))).toEqual([]);
  });
});

describe("reply formatting", () => {
  it("strips the markdown markers Telegram would print literally", async () => {
    const memory = new ConversationMemory({ clock: fixedClock(TEST_INSTANT) });
    const { deps } = setup(
      [textCompletion("### Turnos\n**Ana G.** a las __08:00__, color `Nude Glitter 118`")],
      memory,
    );

    const reply = await handleMessage(deps, { chatId: ROMI, text: "¿qué turnos hay hoy?" });

    expect(reply).toMatchObject({ text: "Turnos\nAna G. a las 08:00, color Nude Glitter 118" });
  });
});

describe("turn latency audit", () => {
  it("records how long a turn took and how many model calls it needed", async () => {
    const lines: string[] = [];
    const memory = new ConversationMemory({ clock: fixedClock(TEST_INSTANT) });
    const { deps } = setup(
      [
        toolCallCompletion("turnos.del_dia", { fecha: "hoy" }),
        textCompletion("Hoy tenés 2 turnos."),
      ],
      memory,
    );
    const audited: BotDeps = {
      ...deps,
      audit: new AuditLogger({ sink: (line) => lines.push(line), clock: fixedClock(TEST_INSTANT) }),
    };

    await handleMessage(audited, { chatId: ROMI, text: "¿qué turnos hay hoy?" });

    const turn = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.event === "llm_turn");
    expect(turn).toMatchObject({ modelCalls: 2, latencyMs: expect.any(Number) });
  });
});
