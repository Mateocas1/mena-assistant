/**
 * PII minimisation for the audit log: the salon's clients may appear by short
 * name only, never by phone or email.
 */

const REDACTED = "[redacted]";

const REDACTED_KEY_PATTERN = /(phone|tel[eé]fono|telefono|whatsapp|email|correo|dni)/i;
const SHORTENED_NAME_KEY_PATTERN = /^(clientname|clientnombre|nombre|name|cliente)$/i;

const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_PATTERN = /\d[\d\s().+-]*\d/g;
const MIN_PHONE_DIGITS = 7;

/** `"Ana Gomez"` → `"Ana G."`; a single word is already short enough. */
export function shortClientName(fullName: string | null | undefined): string | undefined {
  if (!fullName) return undefined;
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  const first = parts[0] ?? "";
  if (parts.length === 1) return first;
  const second = parts[1] ?? "";
  return `${first} ${second.charAt(0)}.`;
}

function looksLikePhone(value: string): boolean {
  // Calendar dates are data, not phones; drop them before looking for digit runs.
  const withoutDates = value.replace(/\d{4}-\d{2}-\d{2}/g, "");
  const runs = withoutDates.match(PHONE_PATTERN) ?? [];
  return runs.some((run) => run.replace(/\D/g, "").length >= MIN_PHONE_DIGITS);
}

function redactValue(key: string, value: unknown): unknown {
  if (typeof value === "string") {
    if (REDACTED_KEY_PATTERN.test(key)) return REDACTED;
    if (SHORTENED_NAME_KEY_PATTERN.test(key)) return shortClientName(value) ?? REDACTED;
    if (EMAIL_PATTERN.test(value)) return REDACTED;
    if (looksLikePhone(value)) return REDACTED;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(key, item));
  if (value !== null && typeof value === "object")
    return redactArgs(value as Record<string, unknown>);
  return value;
}

/** Recursively redacts an argument object before it reaches the audit log. */
export function redactArgs(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    output[key] = redactValue(key, value);
  }
  return output;
}
