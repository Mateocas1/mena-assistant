import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProfileName } from "../config.js";
import type { ToolHandlerContext, ToolRegistry } from "./registry.js";

export interface McpServerOptions {
  readonly registry: ToolRegistry;
  readonly profile: ProfileName;
  readonly context: ToolHandlerContext;
  readonly name?: string;
  readonly version?: string;
}

/**
 * Exposes the profile-filtered tool registry over MCP. Write tools still only
 * return proposals: an external MCP client cannot confirm them, so they expire.
 */
export function createMcpServer(options: McpServerOptions): McpServer {
  const server = new McpServer({
    name: options.name ?? "mena-assistant-mcp",
    version: options.version ?? "0.1.0",
  });

  for (const tool of options.registry.forProfile(options.profile)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema,
      },
      async (args) => {
        try {
          const result = await tool.execute(args, options.context);
          return { content: [{ type: "text" as const, text: result.content }] };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
        }
      },
    );
  }

  return server;
}
