import { artToday, systemClock, type Clock } from "../time/index.js";
import type { AppConfig } from "../config.js";
import { createTurnosFixtures } from "./turnos/fixtures.js";
import { HttpTurnosClient, type FetchLike } from "./turnos/http.js";
import { MockTurnosBackend } from "./turnos/mock.js";
import type { TurnosBackend } from "./turnos/client.js";

export interface CreateTurnosBackendOptions {
  readonly clock?: Clock;
  readonly fetchImpl?: FetchLike;
  readonly retryDelayMs?: number;
}

/**
 * Builds the booking backend selected by `TURNOS_BACKEND`. `mock` (the default)
 * serves fixtures anchored on the clock's ART day; `http` talks to the real
 * `/assistant/*` actions and refuses to start without credentials.
 */
export function createTurnosBackend(
  config: AppConfig,
  options: CreateTurnosBackendOptions = {},
): TurnosBackend {
  const clock = options.clock ?? systemClock;

  if (config.turnos.backend === "mock") {
    return new MockTurnosBackend(createTurnosFixtures(artToday(clock)));
  }

  const { apiBaseUrl, token } = config.turnos;
  if (!apiBaseUrl || !token) {
    throw new Error(
      "TURNOS_BACKEND=http requires ASSISTANT_API_BASE_URL and ASSISTANT_TOKEN (parseConfig should have rejected this)",
    );
  }

  return new HttpTurnosClient({
    baseUrl: apiBaseUrl,
    token,
    timeoutMs: config.turnos.timeoutMs,
    clock,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
  });
}
