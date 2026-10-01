import { z } from "zod";
import type { TurnosBackend } from "../adapters/turnos/client.js";
import { isToolAllowed } from "../bot/allowlist.js";
import type { ProfileName } from "../config.js";
import type { Proposal, ProposalStore } from "../proposals/store.js";
import { systemClock, type Clock } from "../time/index.js";

/** Everything a tool handler may touch, assembled once per conversation. */
export interface ToolHandlerContext {
  readonly backend: TurnosBackend;
  readonly proposals: ProposalStore;
  readonly clock: Clock;
  readonly profile: ProfileName;
  readonly chatId: string;
}

export interface ToolResult {
  /** Model-facing text; for reads it is the JSON payload, for writes the proposal. */
  readonly content: string;
  readonly data?: unknown;
  readonly proposal?: Proposal;
}

export class ToolArgumentError extends Error {
  constructor(toolName: string, detail: string) {
    super(`Invalid arguments for ${toolName}: ${detail}`);
    this.name = "ToolArgumentError";
  }
}

type ToolSchema = z.ZodObject<z.ZodRawShape>;

interface BaseToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly schema: ToolSchema;
  /**
   * Fresh date anchors appended to the description the model reads, evaluated at
   * serialisation time so a long-running process never hands out stale dates.
   */
  readonly hint?: (clock: Clock) => string;
  /** Parse args and run the tool. For writes this returns a proposal only. */
  execute(rawArgs: unknown, context: ToolHandlerContext): Promise<ToolResult>;
}

export interface ReadToolDefinition extends BaseToolDefinition {
  readonly kind: "read";
}

export interface WriteToolDefinition extends BaseToolDefinition {
  readonly kind: "write";
  /** Runs the confirmed action against the backend. Never called by the LLM. */
  executeProposal(rawArgs: unknown, context: ToolHandlerContext): Promise<ToolResult>;
}

export type ToolDefinition = ReadToolDefinition | WriteToolDefinition;

/** Narrows a tool to its write variant (the only one with `executeProposal`). */
export function isWriteTool(tool: ToolDefinition): tool is WriteToolDefinition {
  return tool.kind === "write";
}

export interface ToolConfig<S extends ToolSchema> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly schema: S;
  readonly hint?: (clock: Clock) => string;
  readonly handler: (args: z.infer<S>, context: ToolHandlerContext) => Promise<ToolResult>;
}

export interface WriteToolConfig<S extends ToolSchema> extends Omit<ToolConfig<S>, "handler"> {
  readonly propose: (args: z.infer<S>, context: ToolHandlerContext) => Promise<ToolResult>;
  readonly executeProposal: (args: z.infer<S>, context: ToolHandlerContext) => Promise<ToolResult>;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

function parseArgs<S extends ToolSchema>(
  toolName: string,
  schema: S,
  rawArgs: unknown,
): z.infer<S> {
  const parsed = schema.safeParse(rawArgs ?? {});
  if (!parsed.success) throw new ToolArgumentError(toolName, formatIssues(parsed.error));
  return parsed.data as z.infer<S>;
}

export function defineReadTool<S extends ToolSchema>(config: ToolConfig<S>): ReadToolDefinition {
  return {
    kind: "read",
    name: config.name,
    title: config.title,
    description: config.description,
    schema: config.schema,
    ...(config.hint ? { hint: config.hint } : {}),
    async execute(rawArgs, context) {
      return config.handler(parseArgs(config.name, config.schema, rawArgs), context);
    },
  };
}

export function defineWriteTool<S extends ToolSchema>(
  config: WriteToolConfig<S>,
): WriteToolDefinition {
  return {
    kind: "write",
    name: config.name,
    title: config.title,
    description: config.description,
    schema: config.schema,
    async execute(rawArgs, context) {
      return config.propose(parseArgs(config.name, config.schema, rawArgs), context);
    },
    async executeProposal(rawArgs, context) {
      return config.executeProposal(parseArgs(config.name, config.schema, rawArgs), context);
    },
  };
}

/** OpenAI-compatible tool descriptor (structurally compatible with the SDK type). */
export interface JsonFunctionToolSpec {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

/**
 * Holds every registered tool and answers "what may this profile call?".
 * The LLM is only ever handed the filtered list.
 */
export class ToolRegistry {
  private readonly tools: readonly ToolDefinition[];
  private readonly byName: ReadonlyMap<string, ToolDefinition>;

  constructor(tools: readonly ToolDefinition[]) {
    const byName = new Map<string, ToolDefinition>();
    for (const tool of tools) {
      if (byName.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
      byName.set(tool.name, tool);
    }
    this.tools = [...tools];
    this.byName = byName;
  }

  list(): readonly ToolDefinition[] {
    return this.tools;
  }

  get(name: string): ToolDefinition | undefined {
    return this.byName.get(name);
  }

  forProfile(profile: ProfileName): ToolDefinition[] {
    return this.tools.filter((tool) => isToolAllowed(profile, tool.name));
  }

  toOpenAiTools(profile: ProfileName, clock: Clock = systemClock): JsonFunctionToolSpec[] {
    return serializeTools(this.forProfile(profile), clock);
  }
}

/** Description the model reads: fixed copy plus the fresh date anchors. */
export function describeTool(tool: ToolDefinition, clock: Clock): string {
  return tool.hint ? `${tool.description}\n${tool.hint(clock)}` : tool.description;
}

/** Serialises tool definitions as OpenAI function specs (JSON Schema parameters). */
export function serializeTools(
  tools: readonly ToolDefinition[],
  clock: Clock = systemClock,
): JsonFunctionToolSpec[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: describeTool(tool, clock),
      parameters: z.toJSONSchema(tool.schema) as Record<string, unknown>,
    },
  }));
}
