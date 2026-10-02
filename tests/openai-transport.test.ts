import { describe, expect, it } from "vitest";
import { OpenAiTransport, fromWireToolName, toWireToolName } from "../src/llm/openai-transport.js";

// OpenAI-compatible APIs only accept function names matching ^[a-zA-Z0-9_-]{1,64}$,
// so the dotted internal names (turnos.del_dia) must be encoded on the wire.
const WIRE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

describe("tool name wire encoding", () => {
  it("encodes dotted names into valid function names and decodes them back", () => {
    for (const name of [
      "turnos.del_dia",
      "pagos.confirmar_transferencia",
      "stock.actual",
      "tareas.crear",
    ]) {
      const wire = toWireToolName(name);
      expect(wire).toMatch(WIRE_NAME);
      expect(fromWireToolName(wire)).toBe(name);
    }
  });

  it("sends only valid names and maps the model's tool calls back to internal names", async () => {
    let sentBody:
      | {
          tools: Array<{ function: { name: string } }>;
          messages: Array<{ tool_calls?: Array<{ function: { name: string } }> }>;
        }
      | undefined;
    const fakeFetch = async (_url: unknown, init?: { body?: unknown }) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          id: "c1",
          object: "chat.completion",
          created: 0,
          model: "m",
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: sentBody!.tools[0]!.function.name, arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const transport = new OpenAiTransport({
      apiKey: "k",
      baseUrl: "http://llm.test/v1",
      fetch: fakeFetch as typeof fetch,
    });
    const completion = await transport.complete(
      {
        model: "m",
        messages: [
          { role: "user", content: "hola" },
          {
            role: "assistant",
            content: null,
            toolCalls: [{ id: "call_0", name: "turnos.servicios", arguments: "{}" }],
          },
          { role: "tool", toolCallId: "call_0", content: "[]" },
        ],
        tools: [
          {
            type: "function",
            function: { name: "turnos.del_dia", description: "d", parameters: { type: "object" } },
          },
        ],
      },
      { timeoutMs: 1000 },
    );

    expect(
      sentBody!.tools.map((tool) => tool.function.name).every((name) => WIRE_NAME.test(name)),
    ).toBe(true);
    expect(sentBody!.messages[1]!.tool_calls![0]!.function.name).toMatch(WIRE_NAME);
    expect(completion.toolCalls[0]!.name).toBe("turnos.del_dia");
  });
});
