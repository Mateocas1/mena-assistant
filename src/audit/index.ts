import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { ProfileName } from "../config.js";
import { systemClock, type Clock } from "../time/index.js";
import { redactArgs } from "./pii.js";

export { redactArgs, shortClientName } from "./pii.js";

export type AuditEvent =
  | "tool_call"
  | "chat_dropped"
  | "llm_turn"
  | "proposal_created"
  | "proposal_confirmed"
  | "proposal_cancelled"
  | "daily_summary"
  | "health_alert"
  | "error";

export type AuditStatus = "ok" | "error" | "proposal" | "denied";

export interface AuditTokens {
  readonly prompt: number;
  readonly completion: number;
  readonly total: number;
}

export interface AuditEntry {
  readonly event: AuditEvent;
  readonly profile?: ProfileName;
  /** SHA-256 prefix of the chat id: correlation without storing the identifier. */
  readonly chatIdHash?: string;
  readonly tool?: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly status?: AuditStatus;
  readonly latencyMs?: number;
  readonly model?: string;
  readonly tokens?: AuditTokens;
  readonly proposalId?: string;
  readonly detail?: string;
  readonly error?: string;
}

export type AuditSink = (line: string) => void;

export interface AuditLoggerOptions {
  readonly sink?: AuditSink;
  readonly clock?: Clock;
}

/** Stable, non-reversible chat identifier for audit correlation. */
export function hashChatId(chatId: number | string): string {
  return createHash("sha256").update(String(chatId)).digest("hex").slice(0, 16);
}

export function stdoutSink(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Appends each audit line to `path` (JSONL), creating it if needed. */
export function createFileSink(path: string): AuditSink {
  return (line: string): void => {
    appendFileSync(path, `${line}\n`, "utf8");
  };
}

/** Structured JSON-lines audit log: one self-contained record per event. */
export class AuditLogger {
  private readonly sink: AuditSink;
  private readonly clock: Clock;

  constructor(options: AuditLoggerOptions = {}) {
    this.sink = options.sink ?? stdoutSink;
    this.clock = options.clock ?? systemClock;
  }

  log(entry: AuditEntry): void {
    const record = {
      timestamp: this.clock().toISOString(),
      ...entry,
      ...(entry.args ? { args: redactArgs(entry.args) } : {}),
    };
    this.sink(JSON.stringify(record));
  }
}
