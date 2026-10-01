import { z } from "zod";

export const PROFILE_NAMES = ["romi", "mateo"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

export interface AppConfig {
  readonly telegram: {
    readonly botToken: string;
    /** Telegram chat id (as a string) → permission profile. */
    readonly allowlist: Readonly<Record<string, ProfileName>>;
  };
  readonly llm: {
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly model: string;
    readonly fallbackModel: string;
    readonly timeoutMs: number;
    readonly maxToolCalls: number;
  };
  readonly turnos: {
    readonly backend: "mock" | "http";
    /** Convex `.convex.site` origin; required when `backend` is `http`. */
    readonly apiBaseUrl?: string;
    readonly token?: string;
    readonly timeoutMs: number;
  };
  readonly features: {
    readonly turnos: boolean;
    readonly stock: boolean;
    readonly tareas: boolean;
  };
  readonly proposalTtlMs: number;
  /** When set, the audit log is appended there as JSONL instead of stdout. */
  readonly auditLogFile?: string;
  /** Heartbeat file and interval used by the offline container healthcheck. */
  readonly health: { readonly file: string; readonly intervalMs: number };
  /** Profile the standalone MCP server (non-Telegram clients) acts as. */
  readonly mcp: { readonly profile: ProfileName };
}

/** Thrown by {@link parseConfig}; the process must exit instead of starting half-configured. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type AllowlistResult =
  | { readonly ok: true; readonly value: Record<string, ProfileName> }
  | { readonly ok: false; readonly error: string };

/** Parses `chatId:profile,chatId:profile` and reports the first offending entry. */
export function parseAllowlist(raw: string): AllowlistResult {
  const entries: Record<string, ProfileName> = {};
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;

    const separator = trimmed.lastIndexOf(":");
    if (separator <= 0 || separator === trimmed.length - 1) {
      return { ok: false, error: `invalid entry "${trimmed}", expected chatId:profile` };
    }

    const chatId = trimmed.slice(0, separator).trim();
    const profile = trimmed.slice(separator + 1).trim();

    if (!/^-?\d+$/.test(chatId)) {
      return { ok: false, error: `invalid chat id "${chatId}"` };
    }
    if (!(PROFILE_NAMES as readonly string[]).includes(profile)) {
      return { ok: false, error: `unknown profile "${profile}"` };
    }

    entries[chatId] = profile as ProfileName;
  }

  if (Object.keys(entries).length === 0) {
    return { ok: false, error: "must list at least one chatId:profile entry" };
  }
  return { ok: true, value: entries };
}

const boolFromEnv = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((value) => value === "true");

const envSchema = z
  .object({
    TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
    TELEGRAM_ALLOWLIST: z.string().transform((raw, ctx) => {
      const result = parseAllowlist(raw);
      if (!result.ok) {
        ctx.addIssue({ code: "custom", message: result.error });
        return z.NEVER;
      }
      return result.value;
    }),

    LLM_BASE_URL: z.string().url().default("https://api.nan.builders/v1"),
    LLM_API_KEY: z.string().min(1, "LLM_API_KEY is required"),
    LLM_MODEL: z.string().min(1).default("deepseek-v4-flash"),
    LLM_FALLBACK_MODEL: z.string().min(1).default("glm5.3-flash"),
    LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    LLM_MAX_TOOL_CALLS: z.coerce.number().int().positive().max(20).default(6),

    TURNOS_BACKEND: z.enum(["mock", "http"]).default("mock"),
    ASSISTANT_API_BASE_URL: z.string().url().optional(),
    ASSISTANT_TOKEN: z.string().min(1).optional(),
    TURNOS_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

    FEATURE_TURNOS: boolFromEnv("true"),
    FEATURE_STOCK: boolFromEnv("false"),
    FEATURE_TAREAS: boolFromEnv("false"),

    PROPOSAL_TTL_MINUTES: z.coerce.number().int().positive().default(10),
    AUDIT_LOG_FILE: z.string().min(1).optional(),
    HEALTH_FILE: z.string().min(1).default("/tmp/mena-assistant-alive"),
    HEALTH_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
    MCP_PROFILE: z.enum(PROFILE_NAMES).default("mateo"),
  })
  .superRefine((env, ctx) => {
    if (env.TURNOS_BACKEND === "http") {
      if (!env.ASSISTANT_API_BASE_URL) {
        ctx.addIssue({
          code: "custom",
          path: ["ASSISTANT_API_BASE_URL"],
          message: "ASSISTANT_API_BASE_URL is required when TURNOS_BACKEND=http",
        });
      }
      if (!env.ASSISTANT_TOKEN) {
        ctx.addIssue({
          code: "custom",
          path: ["ASSISTANT_TOKEN"],
          message: "ASSISTANT_TOKEN is required when TURNOS_BACKEND=http",
        });
      }
    }
  });

export type EnvRecord = Readonly<Record<string, string | undefined>>;

/**
 * Parses the environment and fails fast: any problem throws a {@link ConfigError}
 * whose message names the offending variables.
 */
export function parseConfig(env: EnvRecord): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");
    throw new ConfigError(`Invalid configuration — ${details}`);
  }

  const value = parsed.data;
  return {
    telegram: {
      botToken: value.TELEGRAM_BOT_TOKEN,
      allowlist: value.TELEGRAM_ALLOWLIST,
    },
    llm: {
      baseUrl: value.LLM_BASE_URL,
      apiKey: value.LLM_API_KEY,
      model: value.LLM_MODEL,
      fallbackModel: value.LLM_FALLBACK_MODEL,
      timeoutMs: value.LLM_TIMEOUT_MS,
      maxToolCalls: value.LLM_MAX_TOOL_CALLS,
    },
    turnos: {
      backend: value.TURNOS_BACKEND,
      apiBaseUrl: value.ASSISTANT_API_BASE_URL,
      token: value.ASSISTANT_TOKEN,
      timeoutMs: value.TURNOS_TIMEOUT_MS,
    },
    features: {
      turnos: value.FEATURE_TURNOS,
      stock: value.FEATURE_STOCK,
      tareas: value.FEATURE_TAREAS,
    },
    proposalTtlMs: value.PROPOSAL_TTL_MINUTES * 60_000,
    auditLogFile: value.AUDIT_LOG_FILE,
    health: { file: value.HEALTH_FILE, intervalMs: value.HEALTH_INTERVAL_SECONDS * 1000 },
    mcp: { profile: value.MCP_PROFILE },
  };
}
