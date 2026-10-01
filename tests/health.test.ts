import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkLiveness, parseRunMode, startLiveness } from "../src/health.js";

const CLOCK_INSTANT = "2026-01-15T01:30:00.000Z";

describe("parseRunMode", () => {
  it("detects the offline modes", () => {
    expect(parseRunMode([])).toBe("bot");
    expect(parseRunMode(["--check"])).toBe("check");
    expect(parseRunMode(["--healthcheck"])).toBe("healthcheck");
    expect(parseRunMode(["--healthcheck", "--check"])).toBe("healthcheck");
  });
});

describe("liveness file", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mena-health-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("writes the heartbeat on start, refreshes it on the interval and stops", () => {
    vi.useFakeTimers();
    let current = new Date(CLOCK_INSTANT);
    const file = join(dir, "alive");
    const readHeartbeat = (): string => readFileSync(file, "utf8").trim();

    const stop = startLiveness({ file, intervalMs: 1_000, clock: () => current });
    expect(readHeartbeat()).toBe(CLOCK_INSTANT);

    current = new Date(Date.parse(CLOCK_INSTANT) + 1_000);
    vi.advanceTimersByTime(1_000);
    expect(readHeartbeat()).toBe("2026-01-15T01:30:01.000Z");

    stop();
    current = new Date(Date.parse(CLOCK_INSTANT) + 60_000);
    vi.advanceTimersByTime(5_000);
    expect(readHeartbeat()).toBe("2026-01-15T01:30:01.000Z");
  });

  it("accepts a fresh heartbeat", () => {
    const file = join(dir, "fresh");
    const base = Date.parse(CLOCK_INSTANT);
    writeFileSync(file, "{}\n", "utf8");
    utimesSync(file, new Date(base), new Date(base));

    const status = checkLiveness(file, 60_000, () => new Date(base + 5_000));
    expect(status).toMatchObject({ ok: true, ageMs: 5_000 });
  });

  it("reports a stale heartbeat", () => {
    const file = join(dir, "stale");
    const base = Date.parse(CLOCK_INSTANT);
    writeFileSync(file, "{}\n", "utf8");
    utimesSync(file, new Date(base), new Date(base));

    const status = checkLiveness(file, 60_000, () => new Date(base + 120_000));
    expect(status.ok).toBe(false);
    expect(status.reason).toContain("stale");
  });

  it("reports a missing heartbeat", () => {
    const status = checkLiveness(join(dir, "nope"), 1_000, () => new Date(CLOCK_INSTANT));
    expect(status.ok).toBe(false);
    expect(status.reason).toContain("missing");
  });
});
