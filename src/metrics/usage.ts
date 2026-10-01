import { artDate, isoWeekLabel } from "../time/index.js";

/** One parsed JSONL audit record; only the fields metrics care about are typed. */
export interface AuditRecord {
  readonly timestamp?: unknown;
  readonly event?: unknown;
  readonly profile?: unknown;
  readonly tool?: unknown;
}

export interface WeeklyUsageRow {
  readonly profile: string;
  /** ISO-8601 week in ART, e.g. `2026-W03`. */
  readonly week: string;
  /** Conversation turns (`llm_turn`), i.e. one per user message answered. */
  readonly queries: number;
  readonly toolCalls: number;
}

export interface WeeklyUsageReport {
  readonly rows: readonly WeeklyUsageRow[];
  readonly droppedChats: number;
  /** Distinct weeks with at least one answered query — the "does Romi use it?" signal. */
  readonly weeksWithQueries: number;
}

/** Parses JSONL, skipping blank lines and anything that is not an object. */
export function parseAuditLines(text: string): AuditRecord[] {
  const records: AuditRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        records.push(parsed as AuditRecord);
      }
    } catch {
      // A truncated last line (process killed mid-write) must not break metrics.
    }
  }
  return records;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Groups the audit log by profile and ISO week, counting queries and tool calls. */
export function computeWeeklyUsage(records: readonly AuditRecord[]): WeeklyUsageReport {
  const rows = new Map<
    string,
    { profile: string; week: string; queries: number; toolCalls: number }
  >();
  let droppedChats = 0;

  for (const record of records) {
    const event = asString(record.event);
    if (event === "chat_dropped") {
      droppedChats += 1;
      continue;
    }
    if (event !== "llm_turn" && event !== "tool_call") continue;

    const timestamp = asString(record.timestamp);
    if (!timestamp) continue;
    const instant = new Date(timestamp);
    if (Number.isNaN(instant.getTime())) continue;

    const profile = asString(record.profile) ?? "unknown";
    const week = isoWeekLabel(artDate(instant));
    const key = `${profile}\u0000${week}`;

    const row = rows.get(key) ?? { profile, week, queries: 0, toolCalls: 0 };
    if (event === "llm_turn") row.queries += 1;
    else row.toolCalls += 1;
    rows.set(key, row);
  }

  const sorted = [...rows.values()].sort((left, right) =>
    left.week === right.week
      ? left.profile.localeCompare(right.profile)
      : left.week.localeCompare(right.week),
  );

  return {
    rows: sorted,
    droppedChats,
    weeksWithQueries: new Set(sorted.filter((row) => row.queries > 0).map((row) => row.week)).size,
  };
}

export function formatUsageReport(report: WeeklyUsageReport): string {
  const header = `${"profile".padEnd(8)} ${"week".padEnd(10)} ${"queries".padStart(7)} ${"tools".padStart(7)}`;
  const lines = [header, "-".repeat(header.length)];

  for (const row of report.rows) {
    lines.push(
      `${row.profile.padEnd(8)} ${row.week.padEnd(10)} ${String(row.queries).padStart(7)} ${String(
        row.toolCalls,
      ).padStart(7)}`,
    );
  }
  if (report.rows.length === 0) lines.push("(no queries recorded yet)");

  lines.push("");
  lines.push(`dropped chats: ${report.droppedChats}`);
  lines.push(
    `weeks with queries: ${report.weeksWithQueries}${
      report.weeksWithQueries >= 1 ? " — the assistant is in weekly use" : ""
    }`,
  );
  return lines.join("\n");
}
