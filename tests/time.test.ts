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
  InvalidRangeError,
  isoWeekLabel,
  nextWeekday,
  resolveArtDate,
  resolveArtRange,
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
    expect(() => resolveArtDate("en unos días")).toThrow(InvalidDateError);
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

describe("time phrases for the M1 read tools (ART)", () => {
  const clock = fixedClock("2026-01-14T15:00:00Z"); // Wednesday 12:00 ART
  const lateNight = fixedClock("2026-01-15T01:30:00Z"); // Wednesday 22:30 ART

  it("resolves weekday names to the next ART occurrence", () => {
    expect(resolveArtDate("jueves", clock)).toBe("2026-01-15");
    expect(resolveArtDate("el jueves", clock)).toBe("2026-01-15");
    expect(resolveArtDate("el lunes", clock)).toBe("2026-01-19");
    expect(resolveArtDate("miércoles", clock)).toBe("2026-01-21"); // today → next week
    expect(resolveArtDate("pasado mañana", clock)).toBe("2026-01-16");
    expect(resolveArtDate("el viernes que viene", clock)).toBe("2026-01-16");
  });

  it("resolves 'mañana' and 'esta semana' at 22:30 ART", () => {
    // 01:30 UTC is still 22:30 on Jan 14 in Buenos Aires.
    expect(artToday(lateNight)).toBe("2026-01-14");
    expect(resolveArtDate("mañana", lateNight)).toBe("2026-01-15");
    expect(resolveArtDate("jueves", lateNight)).toBe("2026-01-15");
    expect(resolveArtRange("esta semana", undefined, lateNight)).toEqual({
      from: "2026-01-12",
      to: "2026-01-18",
    });
  });

  it("resolves week phrases and explicit ranges", () => {
    expect(resolveArtRange("esta semana", undefined, clock)).toEqual({
      from: "2026-01-12",
      to: "2026-01-18",
    });
    expect(resolveArtRange(undefined, "la semana que viene", clock)).toEqual({
      from: "2026-01-19",
      to: "2026-01-25",
    });
    expect(resolveArtRange(undefined, undefined, clock)).toEqual({
      from: "2026-01-14",
      to: "2026-01-14",
    });
    expect(resolveArtRange("2026-01-14", "2026-01-20", clock)).toEqual({
      from: "2026-01-14",
      to: "2026-01-20",
    });
    expect(resolveArtRange("jueves", "viernes", clock)).toEqual({
      from: "2026-01-15",
      to: "2026-01-16",
    });
  });

  it("rejects an inverted or too-long range", () => {
    expect(() => resolveArtRange("2026-01-20", "2026-01-14", clock)).toThrow(InvalidRangeError);
    expect(() => resolveArtRange("2026-01-01", "2026-02-15", clock)).toThrow(InvalidRangeError);
    expect(() => resolveArtRange("esta semana", "2026-01-18", clock)).toThrow(InvalidRangeError);
    // 31 days inclusive is the limit (2026-01-01..2026-01-31).
    expect(resolveArtRange("2026-01-01", "2026-01-31", clock)).toEqual({
      from: "2026-01-01",
      to: "2026-01-31",
    });
    expect(() => resolveArtRange("2026-01-01", "2026-02-01", clock)).toThrow(InvalidRangeError);
  });

  it("labels ISO weeks in ART for the usage metrics", () => {
    expect(isoWeekLabel("2026-01-14")).toBe("2026-W03");
    expect(isoWeekLabel("2026-01-12")).toBe("2026-W03");
    expect(isoWeekLabel("2026-01-18")).toBe("2026-W03");
    expect(isoWeekLabel("2025-12-29")).toBe("2026-W01");
    expect(isoWeekLabel("2026-01-04")).toBe("2026-W01");
    expect(isoWeekLabel("2026-01-05")).toBe("2026-W02");
  });
});
