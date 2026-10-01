import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import type { ProfileName } from "../src/config.js";
import { createMcpServer } from "../src/mcp/server.js";
import { createToolRegistry } from "../src/mcp/tools/index.js";
import { makeTestContext, type TestContext } from "./helpers/context.js";

const open: Array<{ client: Client; server: McpServer }> = [];

async function connect(
  profile: ProfileName,
): Promise<{ client: Client; test: TestContext; server: McpServer }> {
  const test = makeTestContext({ profile });
  const registry = createToolRegistry({ turnos: true, stock: false, tareas: true });
  const server = createMcpServer({ registry, profile, context: test.context });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  open.push({ client, server });
  return { client, test, server };
}

afterEach(async () => {
  while (open.length > 0) {
    const entry = open.pop();
    if (!entry) continue;
    await entry.client.close();
    await entry.server.close();
  }
});

describe("MCP server", () => {
  it("exposes the tool set allowed for the profile", async () => {
    const { client } = await connect("romi");
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);

    expect(names).toContain("turnos.del_dia");
    expect(names).not.toContain("tareas.listar");
  });

  it("exposes tareas.* to mateo", async () => {
    const { client } = await connect("mateo");
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("tareas.listar");
  });

  it("runs a read tool against the mock backend", async () => {
    const { client } = await connect("romi");
    const result = await client.callTool({ name: "turnos.servicios", arguments: {} });

    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    const parsed = JSON.parse(text) as { servicios: unknown[] };
    expect(parsed.servicios).toHaveLength(6);
  });

  it("returns a proposal for a write tool and never executes it", async () => {
    const { client, test } = await connect("romi");
    const result = await client.callTool({
      name: "turnos.cancelar",
      arguments: { appointmentId: "apt_today_0800" },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    const parsed = JSON.parse(text) as { proposal_id: string; requires_confirmation: boolean };
    expect(parsed.requires_confirmation).toBe(true);
    expect(test.backend.cancelCalls).toEqual([]);
    expect(test.proposals.get(parsed.proposal_id)?.status).toBe("pending");
  });
});
