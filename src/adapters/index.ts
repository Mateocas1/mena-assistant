import type { AppConfig } from "../config.js";
import { MockTurnosBackend } from "./turnos/mock.js";
import type { TurnosBackend } from "./turnos/client.js";

/**
 * Builds the booking backend selected by configuration. The `http` transport
 * (test-kimi `/assistant/*`) is M1 work: selecting it now fails loudly instead
 * of silently serving fixtures.
 */
export function createTurnosBackend(config: AppConfig): TurnosBackend {
  if (config.turnos.adapter === "mock") return new MockTurnosBackend();
  throw new Error("TURNOS_ADAPTER=http is not implemented until M1");
}
