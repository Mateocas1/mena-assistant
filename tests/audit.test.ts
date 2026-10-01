import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger, createFileSink, type AuditEntry } from "../src/audit/index.js";
import { redactArgs, shortClientName } from "../src/audit/pii.js";
import { fixedClock } from "../src/time/index.js";

function collect(): { lines: string[]; logger: AuditLogger } {
  const lines: string[] = [];
  const logger = new AuditLogger({
    sink: (line) => lines.push(line),
    clock: fixedClock("2026-01-15T01:30:00Z"),
  });
  return { lines, logger };
}

describe("audit logger", () => {
  it("writes one JSON line per tool call with model, latency and tokens", () => {
    const { lines, logger } = collect();

    logger.log({
      event: "tool_call",
      profile: "romi",
      chatIdHash: "abc123",
      tool: "turnos.del_dia",
      args: { fecha: "2026-01-14" },
      status: "ok",
      latencyMs: 42,
      model: "deepseek-v4-flash",
      tokens: { prompt: 120, completion: 8, total: 128 },
    });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? "{}") as AuditEntry & { timestamp: string };
    expect(entry.timestamp).toBe("2026-01-15T01:30:00.000Z");
    expect(entry).toMatchObject({
      event: "tool_call",
      profile: "romi",
      tool: "turnos.del_dia",
      status: "ok",
      latencyMs: 42,
      model: "deepseek-v4-flash",
      tokens: { prompt: 120, completion: 8, total: 128 },
    });
  });

  it("appends JSONL to a file when a file sink is configured", () => {
    const dir = mkdtempSync(join(tmpdir(), "mena-audit-"));
    const file = join(dir, "audit.log");
    try {
      const logger = new AuditLogger({
        sink: createFileSink(file),
        clock: fixedClock("2026-01-15T01:30:00Z"),
      });
      logger.log({ event: "llm_turn", profile: "romi", status: "ok" });
      logger.log({ event: "tool_call", profile: "romi", tool: "turnos.servicios", status: "ok" });

      const lines = readFileSync(file, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ event: "llm_turn", profile: "romi" });
      expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({ tool: "turnos.servicios" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a dropped chat without message content and without the raw chat id", () => {
    const { lines, logger } = collect();

    logger.log({ event: "chat_dropped", chatIdHash: "hashed", detail: "not_allowlisted" });

    const line = lines[0] ?? "";
    expect(line).not.toContain("secret message");
    expect(JSON.parse(line)).toMatchObject({
      event: "chat_dropped",
      detail: "not_allowlisted",
      chatIdHash: "hashed",
    });
  });

  it("redacts phone and email while keeping a short client name", () => {
    const { lines, logger } = collect();

    logger.log({
      event: "tool_call",
      profile: "romi",
      tool: "turnos.cancelar",
      args: {
        appointmentId: "apt_1",
        clientName: "Ana Gomez",
        clientPhone: "+54 9 11 5555 6666",
        clientEmail: "ana@example.com",
        fecha: "2026-01-14",
      },
      status: "proposal",
    });

    const line = lines[0] ?? "";
    expect(line).not.toContain("5555");
    expect(line).not.toContain("ana@example.com");
    expect(line).not.toContain("Ana Gomez");
    expect(line).toContain("Ana G.");
    const entry = JSON.parse(line) as AuditEntry;
    expect(entry.args).toMatchObject({ appointmentId: "apt_1", fecha: "2026-01-14" });
  });
});

describe("pii helpers", () => {
  it("shortens client names to first name plus initial", () => {
    expect(shortClientName("Ana Gomez")).toBe("Ana G.");
    expect(shortClientName("Laura")).toBe("Laura");
    expect(shortClientName(undefined)).toBeUndefined();
  });

  it("redacts phone-like and email-like values, but not dates or ids", () => {
    expect(redactArgs({ phone: "1145556666", email: "a@b.com", fecha: "2026-01-14" })).toEqual({
      phone: "[redacted]",
      email: "[redacted]",
      fecha: "2026-01-14",
    });
    expect(redactArgs({ note: "llamar al 1145556666", id: "apt_1" })).toEqual({
      note: "[redacted]",
      id: "apt_1",
    });
  });
});
