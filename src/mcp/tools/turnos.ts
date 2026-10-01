import type { ToolDefinition } from "../registry.js";
import { createTurnosReadTools } from "./turnos-reads.js";
import { createTurnosWriteTools } from "./turnos-writes.js";

export { createTurnosReadTools } from "./turnos-reads.js";
export { createTurnosWriteTools } from "./turnos-writes.js";
export { artDateHint } from "./turnos-shared.js";

/**
 * Every `turnos.*` / `pagos.*` tool: six reads plus the confirmation-gated
 * writes. Writes only ever return proposals.
 */
export function createTurnosTools(): ToolDefinition[] {
  return [...createTurnosReadTools(), ...createTurnosWriteTools()];
}
