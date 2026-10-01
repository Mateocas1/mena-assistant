import { z } from "zod";
import { defineReadTool, type ToolDefinition } from "../../mcp/registry.js";

export interface TareasAdapterOptions {
  readonly enabled: boolean;
}

/**
 * `tareas.*` tools are Mateo-only and belong to M5 (Firestore/Calendar Admin
 * SDK). Until then this adapter is a disabled stub behind `FEATURE_TAREAS`.
 */
export function createTareasTools(options: TareasAdapterOptions): ToolDefinition[] {
  if (!options.enabled) return [];

  return [
    defineReadTool({
      name: "tareas.listar",
      title: "Tareas (no implementado)",
      description: "Tareas del planner personal de Mateo. Pendiente: Admin SDK de Firestore (M5).",
      schema: z.object({}),
      async handler() {
        throw new Error("The tareas adapter is not implemented yet (M5)");
      },
    }),
  ];
}
