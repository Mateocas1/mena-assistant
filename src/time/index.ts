import { systemClock, type Clock } from "./clock.js";

export { fixedClock, systemClock } from "./clock.js";
export type { Clock } from "./clock.js";

/**
 * The salon's timezone. Every "today / tomorrow / this week" calculation must
 * use it: the process may run in UTC (containers) and its operators don't.
 */
export const ART_TIME_ZONE = "America/Argentina/Buenos_Aires";

const MS_PER_DAY = 86_400_000;

const artDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ART_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Raised when a caller supplies a date this module cannot resolve to an ART day. */
export class InvalidDateError extends Error {
  constructor(value: string) {
    super(`Cannot resolve "${value}" to a Buenos Aires date`);
    this.name = "InvalidDateError";
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatUtcDate(time: number): string {
  const date = new Date(time);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function parseIsoDate(value: string): number | null {
  if (!ISO_DATE_PATTERN.test(value)) return null;
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  const roundTrips =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return roundTrips ? time : null;
}

/** Calendar date in ART as `YYYY-MM-DD`, for the given instant. */
export function artDate(instant: Date): string {
  const parts = artDateFormatter.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Today in ART. */
export function artToday(clock: Clock = systemClock): string {
  return artDate(clock());
}

/** Yesterday in ART. */
export function artYesterday(clock: Clock = systemClock): string {
  return addDays(artToday(clock), -1);
}

/** Tomorrow in ART. */
export function artTomorrow(clock: Clock = systemClock): string {
  return addDays(artToday(clock), 1);
}

/** Adds whole calendar days to an ART `YYYY-MM-DD` date. */
export function addDays(isoDate: string, days: number): string {
  const time = parseIsoDate(isoDate);
  if (time === null) throw new InvalidDateError(isoDate);
  return formatUtcDate(time + days * MS_PER_DAY);
}

/** Monday-based weekday index: 0 = Monday … 6 = Sunday. */
export function weekdayIndex(isoDate: string): number {
  const time = parseIsoDate(isoDate);
  if (time === null) throw new InvalidDateError(isoDate);
  return (new Date(time).getUTCDay() + 6) % 7;
}

/** The next `weekday` (Monday-based) at or after `isoDate`. */
export function nextWeekday(
  isoDate: string,
  weekday: number,
  options: { includeToday?: boolean } = {},
): string {
  const includeToday = options.includeToday ?? false;
  const current = weekdayIndex(isoDate);
  const delta = (weekday - current + 7) % 7;
  const effective = delta === 0 && !includeToday ? 7 : delta;
  return addDays(isoDate, effective);
}

export interface ArtWeekRange {
  readonly from: string;
  readonly to: string;
}

/** The current ART week, Monday through Sunday. */
export function artWeekRange(clock: Clock = systemClock): ArtWeekRange {
  const today = artToday(clock);
  const monday = addDays(today, -weekdayIndex(today));
  return { from: monday, to: addDays(monday, 6) };
}

const RELATIVE_DATES: Readonly<Record<string, -1 | 0 | 1 | 2>> = {
  hoy: 0,
  manana: 1,
  "pasado manana": 2,
  ayer: -1,
};

const WEEKDAY_PHRASES: Readonly<Record<string, number>> = {
  lunes: 0,
  martes: 1,
  miercoles: 2,
  jueves: 3,
  viernes: 4,
  sabado: 5,
  domingo: 6,
};

/** `0` = this week, `1` = next week. */
const WEEK_PHRASES: Readonly<Record<string, 0 | 1>> = {
  "esta semana": 0,
  "semana actual": 0,
  "la semana": 0,
  "la semana que viene": 1,
  "semana que viene": 1,
  "proxima semana": 1,
  "la proxima semana": 1,
  "semana proxima": 1,
};

/** Lowercases and strips Spanish diacritics so phrase matching is stable. */
function normalizeText(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function weekOffsetForPhrase(input: string | undefined): 0 | 1 | undefined {
  if (input === undefined) return undefined;
  return WEEK_PHRASES[normalizeText(input)];
}

/** Longest range `turnos.rango` accepts, in calendar days (inclusive). */
export const MAX_RANGE_DAYS = 31;

/** A closed ART date range, `YYYY-MM-DD` inclusive on both ends. */
export interface ArtDateRange {
  readonly from: string;
  readonly to: string;
}

/** Raised when a requested range is inverted or longer than {@link MAX_RANGE_DAYS}. */
export class InvalidRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRangeError";
  }
}

/**
 * Resolves a single date. Accepts `YYYY-MM-DD`, `hoy` / `mañana` / `pasado
 * mañana` / `ayer` and weekday names (`el jueves` → the next Thursday).
 */
export function resolveArtDate(input: string | undefined, clock: Clock = systemClock): string {
  if (input === undefined || input.trim().length === 0) return artToday(clock);

  const normalized = normalizeText(input);

  const relative = RELATIVE_DATES[normalized];
  if (relative !== undefined) return addDays(artToday(clock), relative);

  for (const [name, index] of Object.entries(WEEKDAY_PHRASES)) {
    if (new RegExp(`\\b${name}\\b`).test(normalized)) {
      return nextWeekday(artToday(clock), index);
    }
  }

  if (parseIsoDate(normalized) !== null) return normalized;

  throw new InvalidDateError(input);
}

function assertRange(from: string, to: string): void {
  if (from > to) throw new InvalidRangeError(`el rango ${from}..${to} está invertido`);

  const fromTime = parseIsoDate(from);
  const toTime = parseIsoDate(to);
  if (fromTime === null || toTime === null) throw new InvalidDateError(`${from}..${to}`);

  const days = Math.round((toTime - fromTime) / MS_PER_DAY) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new InvalidRangeError(`el rango pide ${days} días y el máximo es ${MAX_RANGE_DAYS}`);
  }
}

/**
 * Resolves a date range. `esta semana` / `la semana que viene` (in either end,
 * never mixed with an explicit date) expand to the full ART week; otherwise both
 * ends go through {@link resolveArtDate}, with `to` defaulting to `from`.
 */
export function resolveArtRange(
  from: string | undefined,
  to: string | undefined,
  clock: Clock = systemClock,
): ArtDateRange {
  const fromWeek = weekOffsetForPhrase(from);
  const toWeek = weekOffsetForPhrase(to);

  if (fromWeek !== undefined || toWeek !== undefined) {
    if (fromWeek !== undefined && toWeek !== undefined) {
      throw new InvalidRangeError("no se pueden combinar dos rangos de semana");
    }
    const other = fromWeek !== undefined ? to : from;
    if (other !== undefined && other.trim().length > 0) {
      throw new InvalidRangeError("no se puede combinar 'esta semana' con una fecha explícita");
    }

    const base = artWeekRange(clock);
    const shift = 7 * (fromWeek ?? toWeek ?? 0);
    return { from: addDays(base.from, shift), to: addDays(base.to, shift) };
  }

  const start = resolveArtDate(from, clock);
  const end = resolveArtDate(to ?? from, clock);
  assertRange(start, end);
  return { from: start, to: end };
}

/** ISO-8601 week label in ART, used by the usage metrics: `2026-W03`. */
export function isoWeekLabel(isoDate: string): string {
  const thursday = addDays(isoDate, 3 - weekdayIndex(isoDate));
  const year = Number(thursday.slice(0, 4));
  const jan4 = `${year}-01-04`;
  const week1Thursday = addDays(jan4, 3 - weekdayIndex(jan4));
  const thursdayTime = parseIsoDate(thursday);
  const week1Time = parseIsoDate(week1Thursday);
  if (thursdayTime === null || week1Time === null) throw new InvalidDateError(isoDate);

  const week = 1 + Math.round((thursdayTime - week1Time) / (7 * MS_PER_DAY));
  return `${year}-W${String(week).padStart(2, "0")}`;
}
