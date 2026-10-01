/** Injectable time source; tests pass {@link fixedClock} instead of the system clock. */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

/** Freezes a clock at an instant (Date or ISO-8601 string). */
export function fixedClock(instant: Date | string): Clock {
  const frozen = typeof instant === "string" ? new Date(instant) : instant;
  if (Number.isNaN(frozen.getTime())) {
    throw new TypeError(`fixedClock received an invalid instant: ${String(instant)}`);
  }
  return () => new Date(frozen.getTime());
}
