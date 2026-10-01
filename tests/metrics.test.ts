import { describe, expect, it } from "vitest";
import { computeWeeklyUsage, formatUsageReport, parseAuditLines } from "../src/metrics/usage.js";

function line(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

describe("parseAuditLines", () => {
  it("skips blank lines and non-objects instead of throwing", () => {
    const text = [line({ event: "llm_turn" }), "", "   ", "not json", "123", '{"event":"ok"}'].join(
      "\n",
    );
    const records = parseAuditLines(text);
    expect(records).toHaveLength(2);
  });
});

describe("computeWeeklyUsage", () => {
  it("counts queries and tool calls per profile and ISO week", () => {
    const records = parseAuditLines(
      [
        // 01:30 UTC on Jan 15 is 22:30 on Jan 14 ART → ISO week 2026-W03.
        line({ timestamp: "2026-01-15T01:30:00.000Z", event: "llm_turn", profile: "romi" }),
        line({ timestamp: "2026-01-14T15:00:00.000Z", event: "llm_turn", profile: "romi" }),
        line({
          timestamp: "2026-01-14T15:00:01.000Z",
          event: "tool_call",
          profile: "romi",
          tool: "turnos.del_dia",
        }),
        line({
          timestamp: "2026-01-14T15:00:02.000Z",
          event: "tool_call",
          profile: "romi",
          tool: "turnos.servicios",
        }),
        line({ timestamp: "2026-01-14T15:00:03.000Z", event: "chat_dropped" }),
        // Next ISO week.
        line({ timestamp: "2026-01-19T12:00:00.000Z", event: "llm_turn", profile: "romi" }),
        // Another profile in the same week.
        line({ timestamp: "2026-01-14T15:00:04.000Z", event: "llm_turn", profile: "mateo" }),
      ].join("\n"),
    );

    const report = computeWeeklyUsage(records);

    expect(report.rows).toEqual([
      { profile: "mateo", week: "2026-W03", queries: 1, toolCalls: 0 },
      { profile: "romi", week: "2026-W03", queries: 2, toolCalls: 2 },
      { profile: "romi", week: "2026-W04", queries: 1, toolCalls: 0 },
    ]);
    expect(report.droppedChats).toBe(1);
    expect(report.weeksWithQueries).toBe(2);
  });

  it("ignores records without a usable timestamp and unknown events", () => {
    const records = parseAuditLines(
      [
        line({ event: "llm_turn", profile: "romi" }),
        line({ timestamp: "not-a-date", event: "llm_turn", profile: "romi" }),
        line({ timestamp: "2026-01-14T15:00:00.000Z", event: "proposal_created", profile: "romi" }),
      ].join("\n"),
    );

    const report = computeWeeklyUsage(records);
    expect(report.rows).toEqual([]);
    expect(report.weeksWithQueries).toBe(0);
  });

  it("formats a readable report", () => {
    const report = computeWeeklyUsage(
      parseAuditLines(
        line({ timestamp: "2026-01-14T15:00:00.000Z", event: "llm_turn", profile: "romi" }),
      ),
    );

    const text = formatUsageReport(report);
    expect(text).toContain("romi");
    expect(text).toContain("2026-W03");
    expect(text).toContain("weeks with queries: 1");
    expect(text).toContain("weekly use");
  });

  it("says so when there is nothing recorded yet", () => {
    const text = formatUsageReport(computeWeeklyUsage([]));
    expect(text).toContain("(no queries recorded yet)");
    expect(text).toContain("weeks with queries: 0");
  });
});
