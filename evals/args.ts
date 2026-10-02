/**
 * Semantic argument comparison for the eval runner.
 *
 * A live model is expected to express intent, not to echo the eval's canonical
 * ISO strings: the tools themselves resolve ART phrases and apply defaults. This
 * module compares only the keys a case declares, with one documented rule per
 * key class, and never equates values that change meaning:
 *
 * 1. **Dates** (`fecha`, `fecha_actual`, `desde`, `hasta`, and the ranges of
 *    `turnos.rango`) are normalized through the ART time module with the eval's
 *    frozen clock. `hoy`, `mañana`, `el jueves`, an explicit `YYYY-MM-DD` and an
 *    omitted `fecha` all resolve to the same day when the tool documents that
 *    default. A different resolved day is always a failure.
 * 2. **Documented optional defaults** count as omitted: `limit` defaults to 10,
 *    `solo_colores` and `retiro` to false, `hasta` to `desde`, and `fecha` to
 *    today on the day tools. Passing the default explicitly is accepted; passing
 *    something else still fails.
 * 3. **Names, reasons and phones** (`cliente`, `motivo`, `notas`, `telefono`)
 *    are compared case-, accent- and whitespace-insensitively. Nothing else is.
 * 4. **Numeric ids and counts** (`limit`, `colorItemId`, `itemId`, `units`) are
 *    compared as numbers, so `"3"` equals `3` (and inside `tips`).
 * 5. **Everything else** (ids, slugs, times, booleans, array order) is compared
 *    structurally and exactly.
 *
 * An empty expectation (`{}`) means "any arguments are acceptable", which is the
 * shape used by the cases whose tool takes no arguments at all.
 */
import type { Clock } from "../src/time/index.js";
import { resolveArtDate, resolveArtRange } from "../src/time/index.js";

/** Why a declared key did not match. */
export type ArgMismatchReason = "missing_arg" | "wrong_date" | "wrong_value";

export interface ArgMismatch {
  readonly key: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly reason: ArgMismatchReason;
}

export interface ArgsComparison {
  readonly matched: boolean;
  readonly mismatch?: ArgMismatch;
}

/** Resolved through the ART time module, never compared as raw text. */
const DATE_KEYS = new Set(["fecha", "fecha_actual", "desde", "hasta"]);

/** Compared case-, accent- and whitespace-insensitively. */
const TEXT_KEYS = new Set(["cliente", "motivo", "notas", "telefono"]);

/** Compared as numbers so a JSON string id equals its numeric form. */
const NUMERIC_KEYS = new Set(["limit", "colorItemId", "itemId", "units"]);

type Record_ = Record<string, unknown>;

function isRecord(value: unknown): value is Record_ {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Lowercase, strip Spanish diacritics, collapse whitespace (same idea as `src/time`). */
export function normalizeText(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function toNumber(value: unknown): unknown {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return value;
}

/** Resolves a date without throwing: an unresolvable value is compared raw. */
function safeResolveDate(value: unknown, clock: Clock): unknown {
  if (value !== undefined && typeof value !== "string") return value;
  try {
    return resolveArtDate(value, clock);
  } catch {
    return value;
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => deepEqual(left[key], right[key]))
    );
  }
  return false;
}

function canonicalizeValue(key: string, value: unknown, clock: Clock): unknown {
  if (value === undefined) return undefined;
  if (TEXT_KEYS.has(key) && typeof value === "string") return normalizeText(value);
  if (NUMERIC_KEYS.has(key)) return toNumber(value);
  if (DATE_KEYS.has(key) && typeof value === "string") return safeResolveDate(value, clock);
  if (Array.isArray(value)) return value.map((element) => canonicalizeElement(element, clock));
  if (isRecord(value)) {
    const out: Record_ = {};
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      out[nestedKey] = canonicalizeValue(nestedKey, nestedValue, clock);
    }
    return out;
  }
  return value;
}

function canonicalizeElement(element: unknown, clock: Clock): unknown {
  if (!isRecord(element)) return element;
  const out: Record_ = {};
  for (const [key, value] of Object.entries(element)) {
    out[key] = canonicalizeValue(key, value, clock);
  }
  return out;
}

/**
 * Applies the tool's documented defaults and normalizes every key. Ranges are
 * resolved as a pair so `desde: "esta semana"` and an omitted `hasta` behave
 * exactly like the tool does.
 */
function canonicalizeArgs(tool: string, args: unknown, clock: Clock): Record_ {
  const record: Record_ = isRecord(args) ? args : {};
  const out: Record_ = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = canonicalizeValue(key, value, clock);
  }

  switch (tool) {
    case "turnos.rango": {
      try {
        const range = resolveArtRange(
          record.desde as string | undefined,
          record.hasta as string | undefined,
          clock,
        );
        out.desde = range.from;
        out.hasta = range.to;
      } catch {
        // Leave the raw values so the mismatch is reported instead of thrown.
      }
      break;
    }
    case "turnos.del_dia":
    case "turnos.disponibilidad":
    case "turnos.resumen":
      out.fecha = safeResolveDate(record.fecha, clock);
      break;
    case "stock.servicios_recientes":
      out.limit = record.limit === undefined ? 10 : toNumber(record.limit);
      break;
    case "stock.catalogo":
      out.solo_colores = record.solo_colores === undefined ? false : record.solo_colores;
      break;
    case "turnos.crear_para_clienta":
      out.retiro = record.retiro === undefined ? false : record.retiro;
      break;
    default:
      break;
  }

  return out;
}

/**
 * Compares the actual arguments of `tool` against the case's expected subset.
 * Returns the first mismatch with the key, both canonical values and the reason.
 */
export function compareArgs(
  tool: string,
  expected: Readonly<Record<string, unknown>>,
  actual: unknown,
  clock: Clock,
): ArgsComparison {
  const keys = Object.keys(expected);
  if (keys.length === 0) return { matched: true };

  const canonicalExpected = canonicalizeArgs(tool, expected, clock);
  const canonicalActual = canonicalizeArgs(tool, actual, clock);
  const rawActual: Record_ = isRecord(actual) ? actual : {};

  for (const key of keys) {
    const expectedValue = canonicalExpected[key];
    const actualValue = canonicalActual[key];
    if (deepEqual(actualValue, expectedValue)) continue;

    const reason: ArgMismatchReason =
      rawActual[key] === undefined
        ? "missing_arg"
        : DATE_KEYS.has(key)
          ? "wrong_date"
          : "wrong_value";
    return {
      matched: false,
      mismatch: { key, expected: expectedValue, actual: actualValue, reason },
    };
  }

  return { matched: true };
}
