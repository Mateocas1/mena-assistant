import { describe, expect, it } from "vitest";
import {
  addDays,
  artDate,
  artToday,
  artTomorrow,
  artWeekRange,
  artYesterday,
  fixedClock,
  InvalidDateError,
  nextWeekday,
  resolveArtDate,
  systemClock,
} from "../src/time/index.js";

describe("time (America/Argentina/Buenos_Aires)", () => {
  it("resolves the ART date, never the UTC date", () => {
    // 01:30 UTC on Jan 15 is 22:30 ART on Jan 14.
    expect(artDate(new Date("2026-01-15T01:30:00Z"))).toBe("2026-01-14");
  });

  it("uses the fixed clock to resolve today at 22:30 ART", () => {
    const clock = fixedClock("2026-01-15T01:30:00Z");
    expect(artToday(clock)).toBe("2026-01-14");
    expect(artTomorrow(clock)).toBe("2026-01-15");
    expect(artYesterday(clock)).toBe("2026-01-13");
  });

  it("keeps the ART date stable late in the UTC day", () => {
    expect(artToday(fixedClock("2026-01-14T23:59:00Z"))).toBe("2026-01-14");
    expect(artToday(fixedClock("2026-01-14T12:00:00Z"))).toBe("2026-01-14");
  });

  it("advances calendar days across month, year and leap boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("resolves relative Spanish dates against the clock", () => {
    const clock = fixedClock("2026-01-15T01:30:00Z");
    expect(resolveArtDate(undefined, clock)).toBe("2026-01-14");
    expect(resolveArtDate("", clock)).toBe("2026-01-14");
    expect(resolveArtDate("hoy", clock)).toBe("2026-01-14");
    expect(resolveArtDate("Mañana", clock)).toBe("2026-01-15");
    expect(resolveArtDate("manana", clock)).toBe("2026-01-15");
    expect(resolveArtDate("ayer", clock)).toBe("2026-01-13");
    expect(resolveArtDate("2026-03-05", clock)).toBe("2026-03-05");
  });

  it("rejects a date it cannot resolve", () => {
    expect(() => resolveArtDate("el jueves que viene")).toThrow(InvalidDateError);
    expect(() => resolveArtDate("2026-13-45")).toThrow(InvalidDateError);
  });

  it("computes the ART week (Monday to Sunday)", () => {
    // 2026-01-14 is a Wednesday.
    const range = artWeekRange(fixedClock("2026-01-14T15:00:00Z"));
    expect(range).toEqual({ from: "2026-01-12", to: "2026-01-18" });
  });

  it("finds the next occurrence of a weekday", () => {
    const wednesday = "2026-01-14";
    expect(nextWeekday(wednesday, 3)).toBe("2026-01-15"); // Thursday
    expect(nextWeekday(wednesday, 1)).toBe("2026-01-20"); // next Tuesday, not today
    expect(nextWeekday(wednesday, 2, { includeToday: true })).toBe("2026-01-14"); // today
  });

  it("exposes a system clock", () => {
    expect(typeof systemClock()).toBe("object");
  });
});
