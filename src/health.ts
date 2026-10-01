import { statSync, writeFileSync } from "node:fs";
import { systemClock, type Clock } from "./time/index.js";

export interface LivenessOptions {
  readonly file: string;
  readonly intervalMs: number;
  readonly clock?: Clock;
}

/**
 * Keeps a heartbeat file fresh so a container healthcheck can run without
 * Telegram. Returns a stop function; the timer does not hold the process open.
 */
export function startLiveness(options: LivenessOptions): () => void {
  const clock = options.clock ?? systemClock;

  const touch = (): void => {
    try {
      writeFileSync(options.file, `${clock().toISOString()}\n`, "utf8");
    } catch {
      // Best effort: a read-only filesystem must not crash the assistant.
    }
  };

  touch();
  const timer = setInterval(touch, options.intervalMs);
  timer.unref?.();

  return () => clearInterval(timer);
}

export interface LivenessStatus {
  readonly ok: boolean;
  readonly ageMs?: number;
  readonly reason?: string;
}

/** True when the heartbeat file exists and is younger than `maxAgeMs`. */
export function checkLiveness(
  file: string,
  maxAgeMs: number,
  clock: Clock = systemClock,
): LivenessStatus {
  try {
    const ageMs = clock().getTime() - statSync(file).mtimeMs;
    if (ageMs > maxAgeMs) {
      return { ok: false, ageMs, reason: `stale by ${Math.round(ageMs - maxAgeMs)}ms` };
    }
    return { ok: true, ageMs };
  } catch {
    return { ok: false, reason: "heartbeat file is missing" };
  }
}

export type RunMode = "bot" | "check" | "healthcheck";

/** CLI mode from argv: `--check` validates config, `--healthcheck` reads the heartbeat. */
export function parseRunMode(argv: readonly string[]): RunMode {
  if (argv.includes("--healthcheck")) return "healthcheck";
  if (argv.includes("--check")) return "check";
  return "bot";
}
