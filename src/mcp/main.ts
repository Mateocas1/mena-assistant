import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { createTurnosBackend } from "../adapters/index.js";
import { parseConfig } from "../config.js";
import { ProposalStore } from "../proposals/store.js";
import { systemClock } from "../time/index.js";
import { createMcpServer } from "./server.js";
import { createToolRegistry } from "./tools/index.js";

/** Starts the MCP server over stdio (Claude Desktop, the operator's agent, …). */
export async function startMcpServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = parseConfig(env);
  const registry = createToolRegistry(config.features);
  const backend = createTurnosBackend(config, { clock: systemClock });

  const context = {
    backend,
    proposals: new ProposalStore({ ttlMs: config.proposalTtlMs }),
    clock: systemClock,
    profile: config.mcp.profile,
    chatId: `mcp:${config.mcp.profile}`,
  };

  const server = createMcpServer({
    registry,
    profile: config.mcp.profile,
    context,
  });

  await server.connect(new StdioServerTransport());
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  startMcpServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
