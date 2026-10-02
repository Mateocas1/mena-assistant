/**
 * Client-side guardrails for the live comparison.
 *
 * The eval shares one provider key with the developer's own agent traffic, so it
 * must never burst: {@link RequestLimiter} keeps a rolling per-minute request
 * budget (default 30), and {@link retryAfterMs} reads how long a 429 wants us to
 * wait (either a `Retry-After` header or the provider's reset time) so a retry
 * rides the window out instead of failing the case.
 */

export interface RequestLimiterOptions {
  /** Requests allowed per rolling window. */
  readonly rpm: number;
  readonly windowMs?: number;
  /** Injected in tests. */
  readonly now?: () => number;
  /** Injected in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_WINDOW_MS = 60_000;

/** Rolling-window limiter shared by every model in one comparison process. */
export class RequestLimiter {
  private readonly rpm: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly stamps: number[] = [];
  private waited = 0;

  constructor(options: RequestLimiterOptions) {
    this.rpm = Math.max(1, Math.floor(options.rpm));
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  }

  /** Resolves when one request may go out; sleeps while the window is full. */
  async acquire(): Promise<void> {
    for (;;) {
      const now = this.now();
      while (this.stamps.length > 0 && now - this.stamps[0]! >= this.windowMs) this.stamps.shift();
      if (this.stamps.length < this.rpm) {
        this.stamps.push(now);
        return;
      }
      const wait = this.windowMs - (now - this.stamps[0]!) + 1;
      this.waited += wait;
      await this.sleep(wait);
    }
  }

  /** Total time spent waiting on the window, for the run summary. */
  waitedMs(): number {
    return this.waited;
  }
}

/** `--rpm N` / `--rpm=N`, then `EVAL_RPM`, then the default of 30 requests/minute. */
export function parseRpmFlag(
  argv: readonly string[],
  envValue: string | undefined = process.env.EVAL_RPM,
  fallback = 30,
): number {
  let raw: string | undefined;
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const argument = argv[index];
    if (argument?.startsWith("--rpm=")) {
      raw = argument.slice("--rpm=".length);
      break;
    }
    if (argument === "--rpm") {
      raw = argv[index + 1];
      break;
    }
  }
  const parse = (value: string | undefined): number | undefined => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : undefined;
  };
  return parse(raw) ?? parse(envValue) ?? fallback;
}

function readRetryAfterHeader(headers: unknown): string | undefined {
  if (headers === null || headers === undefined) return undefined;
  const withGet = headers as { get?: (name: string) => string | null };
  if (typeof withGet.get === "function") return withGet.get("retry-after") ?? undefined;
  if (typeof headers === "object") {
    const record = headers as Record<string, unknown>;
    const value = record["retry-after"] ?? record["Retry-After"];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

/**
 * How long a 429 asks us to wait, in milliseconds. Reads the `Retry-After`
 * header first, then the provider's "Limit resets at: <UTC>" message.
 */
export function retryAfterMs(error: unknown, now = Date.now()): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const record = error as { headers?: unknown; message?: unknown };

  const header = readRetryAfterHeader(record.headers);
  if (header !== undefined) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }

  if (typeof record.message === "string") {
    const reset = record.message.match(
      /Limit resets at:\s*(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC/,
    );
    if (reset) {
      const at = Date.parse(`${reset[1]}T${reset[2]}.000Z`);
      if (!Number.isNaN(at)) return Math.max(0, at - now) + 1_000;
    }
    const retry = record.message.match(/retry[- ]after[:\s]+(\d+)/i);
    if (retry) return Number(retry[1]) * 1_000;
  }

  return undefined;
}

/**
 * How long to wait after a "too many simultaneous requests" rejection. The eval
 * cannot un-send a request that already timed out upstream, so it waits for the
 * provider's in-flight counter to drain instead of retrying sooner.
 */
export const CONCURRENCY_LIMIT_DRAIN_MS = 15_000;

/**
 * True when the 429 is the provider's cap on simultaneous requests
 * (`429 gemma4 concurrency limit: max 5 simultaneous requests.`). A slow model
 * whose reply exceeds the client timeout leaves timed-out requests counted
 * upstream, so this is the one 429 kind that needs a longer, fixed drain delay
 * rather than the exponential backoff.
 */
export function isConcurrencyLimitError(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; depth < 8 && cursor !== null && cursor !== undefined; depth += 1) {
    const record = cursor as { message?: unknown; cause?: unknown };
    if (typeof record.message === "string" && /concurrency limit/i.test(record.message)) {
      return true;
    }
    cursor = record.cause;
  }
  return false;
}

/** Walks the error cause chain looking for a real HTTP 429. */
export function isRateLimitError(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; depth < 8 && cursor !== null && cursor !== undefined; depth += 1) {
    const record = cursor as { status?: unknown; message?: unknown; cause?: unknown };
    if (record.status === 429) return true;
    if (
      typeof record.message === "string" &&
      /\b429\b/.test(record.message) &&
      /rate limit/i.test(record.message)
    ) {
      return true;
    }
    cursor = record.cause;
  }
  return false;
}
