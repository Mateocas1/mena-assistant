import type { AppConfig } from "../../config.js";
import { createTareasTools } from "../../adapters/tareas/index.js";
import { createStockTools } from "../../adapters/stock/index.js";
import { ToolRegistry } from "../registry.js";
import { createTurnosTools } from "./turnos.js";

export { createStockTools } from "../../adapters/stock/index.js";
export { createTareasTools } from "../../adapters/tareas/index.js";
export { createTurnosTools } from "./turnos.js";

/** Builds the registry for a configuration: disabled adapters contribute no tools. */
export function createToolRegistry(features: AppConfig["features"]): ToolRegistry {
  return new ToolRegistry([
    ...(features.turnos ? createTurnosTools() : []),
    ...createStockTools({ enabled: features.stock }),
    ...createTareasTools({ enabled: features.tareas }),
  ]);
}
