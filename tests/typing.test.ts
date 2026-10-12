import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepTyping } from "../src/bot/typing.js";

describe("keepTyping", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows the typing action at once and renews it until stopped", async () => {
    let sent = 0;
    const stop = keepTyping(async () => {
      sent += 1;
    }, 4_000);

    expect(sent).toBe(1);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(sent).toBe(3);

    stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent).toBe(3);
  });

  it("never lets a failed typing action break the reply", async () => {
    const stop = keepTyping(async () => {
      throw new Error("telegram down");
    }, 4_000);

    await vi.advanceTimersByTimeAsync(4_000);
    stop();
  });
});
