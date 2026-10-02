import type { AppConfig } from "../../config.js";
import { createTareasTools } from "./tareas.js";
import { createStockTools } from "./stock.js";
import { ToolRegistry } from "../registry.js";
import { createTurnosTools } from "./turnos.js";

export { createStockTools } from "./stock.js";
export { createTareasTools } from "./tareas.js";
export { createTurnosTools } from "./turnos.js";

/** Builds the registry for a configuration: disabled adapters contribute no tools. */
export function createToolRegistry(features: AppConfig["features"]): ToolRegistry {
  return new ToolRegistry([
    ...(features.turnos ? createTurnosTools() : []),
    ...createStockTools({ enabled: features.stock }),
    ...createTareasTools({ enabled: features.tareas }),
  ]);
}
