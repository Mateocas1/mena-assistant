import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAiTransport, toWireToolName } from "../src/llm/openai-transport.js";
import { createStreamedMessage } from "../src/bot/streaming.js";

function sse(chunks: readonly unknown[]): Response {
  const body =
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: "m" };

describe("OpenAiTransport streaming", () => {
  it("streams the text to onText and returns the whole completion", async () => {
    let sent: { stream?: boolean } | undefined;
    const transport = new OpenAiTransport({
      apiKey: "k",
      baseUrl: "https://example.test/v1",
      fetch: (async (_url: unknown, init?: { body?: unknown }) => {
        sent = JSON.parse(String(init?.body));
        return sse([
          { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Ho" } }] },
          { ...base, choices: [{ index: 0, delta: { content: "la Romi" }, finish_reason: "stop" }] },
          {
            ...base,
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
          },
        ]);
      }) as unknown as typeof fetch,
    });
    const partials: string[] = [];

    const completion = await transport.complete(
      { model: "m", messages: [{ role: "user", content: "hola" }], tools: [] },
      { timeoutMs: 5_000, onText: (text) => partials.push(text) },
    );

    expect(sent?.stream).toBe(true);
    expect(partials).toEqual(["Ho", "Hola Romi"]);
    expect(completion).toMatchObject({
      content: "Hola Romi",
      toolCalls: [],
      usage: { prompt: 10, completion: 3, total: 13 },
    });
  });

  it("rebuilds tool calls from streamed fragments", async () => {
    const wire = toWireToolName("turnos.del_dia");
    const transport = new OpenAiTransport({
      apiKey: "k",
      baseUrl: "https://example.test/v1",
      fetch: (async () =>
        sse([
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: { name: wire, arguments: '{"fecha"' },
                    },
                  ],
                },
              },
            ],
          },
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: ':"hoy"}' } }] },
                finish_reason: "tool_calls",
              },
            ],
          },
        ])) as unknown as typeof fetch,
    });

    const completion = await transport.complete(
      { model: "m", messages: [{ role: "user", content: "hoy" }], tools: [] },
      { timeoutMs: 5_000, onText: () => {} },
    );

    expect(completion.toolCalls).toEqual([
      { id: "call_1", name: "turnos.del_dia", arguments: '{"fecha":"hoy"}' },
    ]);
    expect(completion.content).toBeNull();
  });
});

describe("createStreamedMessage", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function fake() {
    const calls: string[] = [];
    const message = createStreamedMessage({
      send: async (text) => {
        calls.push(`send:${text}`);
      },
      edit: async (text) => {
        calls.push(`edit:${text}`);
      },
      intervalMs: 1_000,
      minChars: 5,
    });
    return { calls, message };
  }

  it("waits for a few characters, then edits at most once per interval", async () => {
    const { calls, message } = fake();

    message.update("Hol");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]);

    message.update("Hola Romi");
    await vi.advanceTimersByTimeAsync(0);
    message.update("Hola Romi, tenés");
    message.update("Hola Romi, tenés dos");
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toEqual(["send:Hola Romi"]);

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(["send:Hola Romi", "edit:Hola Romi, tenés dos"]);
  });

  it("finishes with the final text, editing the streamed message", async () => {
    const { calls, message } = fake();
    message.update("Hola Romi");
    await vi.advanceTimersByTimeAsync(0);

    await message.finish("Hola Romi, tenés dos turnos.");

    expect(calls).toEqual(["send:Hola Romi", "edit:Hola Romi, tenés dos turnos."]);
  });

  it("sends the final text when the streamed message cannot be edited", async () => {
    const calls: string[] = [];
    const message = createStreamedMessage({
      send: async (text) => {
        calls.push(`send:${text}`);
      },
      edit: async () => {
        throw new Error("message to edit not found");
      },
      minChars: 5,
    });
    message.update("Hola Romi");
    await vi.advanceTimersByTimeAsync(0);

    await message.finish("Hola Romi, listo.");

    expect(calls).toEqual(["send:Hola Romi", "send:Hola Romi, listo."]);
  });

  it("sends the final text once when nothing was streamed", async () => {
    const { calls, message } = fake();

    await message.finish("Listo.");

    expect(calls).toEqual(["send:Listo."]);
  });

  it("does not edit when the final text is what is already on screen", async () => {
    const { calls, message } = fake();
    message.update("Hola Romi");
    await vi.advanceTimersByTimeAsync(0);

    await message.finish("Hola Romi");

    expect(calls).toEqual(["send:Hola Romi"]);
  });
});
