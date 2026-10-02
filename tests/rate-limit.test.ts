import { describe, expect, it } from "vitest";
import {
  isConcurrencyLimitError,
  RequestLimiter,
  parseRpmFlag,
  retryAfterMs,
} from "../evals/rate-limit.js";

describe("RequestLimiter", () => {
  it("allows up to `rpm` calls per rolling minute and waits for the window", async () => {
    let time = 0;
    const sleeps: number[] = [];
    const limiter = new RequestLimiter({
      rpm: 2,
      now: () => time,
      sleep: async (ms) => {
        sleeps.push(ms);
        time += ms;
      },
    });

    await limiter.acquire();
    await limiter.acquire();
    expect(sleeps).toEqual([]);

    await limiter.acquire();
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(60_000);
    expect(limiter.waitedMs()).toBeGreaterThanOrEqual(60_000);
  });

  it("does not wait again once the window has passed", async () => {
    let time = 0;
    const sleeps: number[] = [];
    const limiter = new RequestLimiter({
      rpm: 1,
      now: () => time,
      sleep: async (ms) => {
        sleeps.push(ms);
        time += ms;
      },
    });

    await limiter.acquire();
    await limiter.acquire();
    time += 60_000;
    await limiter.acquire();
    expect(sleeps).toHaveLength(1);
  });
});

describe("parseRpmFlag", () => {
  it("reads --rpm in both shapes, then EVAL_RPM, then the default", () => {
    expect(parseRpmFlag(["--rpm", "20"])).toBe(20);
    expect(parseRpmFlag(["--rpm=20"])).toBe(20);
    expect(parseRpmFlag([], "45")).toBe(45);
    expect(parseRpmFlag([], undefined)).toBe(30);
    expect(parseRpmFlag(["--rpm", "0"], "45")).toBe(45);
    expect(parseRpmFlag(["--rpm", "abc"], "45")).toBe(45);
  });
});

describe("retryAfterMs", () => {
  it("reads a numeric Retry-After header", () => {
    expect(retryAfterMs({ headers: { "retry-after": "5" } })).toBe(5_000);
    expect(retryAfterMs({ headers: new Headers({ "retry-after": "2" }) })).toBe(2_000);
  });

  it("reads the provider reset time from the 429 message", () => {
    const now = Date.UTC(2026, 9, 2, 2, 46, 0);
    const message =
      "429 Rate limit exceeded for api_key: ***. Limit type: requests. Current limit: 60, Remaining: 0. Limit resets at: 2026-10-02 02:46:16 UTC";
    expect(retryAfterMs({ message }, now)).toBe(17_000);
  });

  it("returns undefined when there is no signal", () => {
    expect(retryAfterMs({ message: "boom" })).toBeUndefined();
    expect(retryAfterMs(new Error("socket hang up"))).toBeUndefined();
  });
});

describe("isConcurrencyLimitError", () => {
  it("recognizes the provider's cap on simultaneous requests", () => {
    const error = Object.assign(
      new Error("429 gemma4 concurrency limit: max 5 simultaneous requests."),
      { status: 429 },
    );
    expect(isConcurrencyLimitError(error)).toBe(true);
    // Walked through the cause chain, the same way `isRateLimitError` does.
    expect(
      isConcurrencyLimitError({
        message: "Model gemma4 failed",
        cause: {
          message: "concurrency limit: max 5 simultaneous requests",
        },
      }),
    ).toBe(true);
    // A plain window 429 is not a concurrency cap: it carries its own wait.
    expect(isConcurrencyLimitError({ status: 429, message: "429 rate limit exceeded" })).toBe(
      false,
    );
    expect(isConcurrencyLimitError(new Error("boom"))).toBe(false);
  });
});
