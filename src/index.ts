import { createTurnosBackend } from "./adapters/index.js";
import { AuditLogger, createFileSink } from "./audit/index.js";
import { createBot } from "./bot/index.js";
import type { BotDeps } from "./bot/core.js";
import { ConfigError, parseConfig, type AppConfig } from "./config.js";
import { createLlmTransport, type LlmTransport } from "./llm/index.js";
import { checkLiveness, parseRunMode, startLiveness } from "./health.js";
import { createToolRegistry } from "./mcp/tools/index.js";
import { ProposalStore } from "./proposals/store.js";
import { systemClock, type Clock } from "./time/index.js";

export interface CreateDepsOptions {
  readonly transport?: LlmTransport;
  readonly clock?: Clock;
  readonly audit?: AuditLogger;
}

/** Wires the configuration into the objects the bot core needs. */
export function createBotDeps(config: AppConfig, options: CreateDepsOptions = {}): BotDeps {
  return {
    config,
    registry: createToolRegistry(config.features),
    backend: createTurnosBackend(config, options.clock ? { clock: options.clock } : {}),
    proposals: new ProposalStore({
      ttlMs: config.proposalTtlMs,
      ...(options.clock ? { clock: options.clock } : {}),
    }),
    transport: options.transport ?? createLlmTransport(config),
    audit:
      options.audit ??
      new AuditLogger({
        ...(options.clock ? { clock: options.clock } : {}),
        ...(config.auditLogFile ? { sink: createFileSink(config.auditLogFile) } : {}),
      }),
    ...(options.clock ? { clock: options.clock } : {}),
  };
}

async function main(): Promise<void> {
  const mode = parseRunMode(process.argv.slice(2));

  let config: AppConfig;
  try {
    config = parseConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[mena-assistant] ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  if (mode === "check") {
    console.log(
      `[mena-assistant] config ok — model=${config.llm.model} fallback=${config.llm.fallbackModel} turnos=${config.turnos.backend} chats=${Object.keys(config.telegram.allowlist).length}`,
    );
    return;
  }

  if (mode === "healthcheck") {
    // Three missed heartbeats means unhealthy; needs no Telegram and no network.
    const status = checkLiveness(config.health.file, config.health.intervalMs * 3);
    if (!status.ok) {
      console.error(`[mena-assistant] unhealthy: ${status.reason ?? "unknown"}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[mena-assistant] healthy (heartbeat ${status.ageMs ?? 0}ms old)`);
    return;
  }

  const bot = createBot(config.telegram.botToken, createBotDeps(config, { clock: systemClock }));
  const stopLiveness = startLiveness({
    file: config.health.file,
    intervalMs: config.health.intervalMs,
  });
  console.error(
    `[mena-assistant] starting long polling — model=${config.llm.model} fallback=${config.llm.fallbackModel} turnos=${config.turnos.backend} health=${config.health.file}`,
  );

  const stop = async (signal: string): Promise<void> => {
    console.error(`[mena-assistant] stopping (${signal})`);
    stopLiveness();
    await bot.stop();
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));

  await bot.start();
}

main().catch((error: unknown) => {
  console.error(
    `[mena-assistant] fatal: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
