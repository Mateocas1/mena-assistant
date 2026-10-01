import { z } from "zod";
import { defineReadTool, type ToolDefinition } from "../../mcp/registry.js";

export interface StockAdapterOptions {
  readonly enabled: boolean;
}

/**
 * `stock.*` tools belong to M3 and need the deployed mena-nails API. Until then
 * this adapter is a disabled stub behind `FEATURE_STOCK`.
 */
export function createStockTools(options: StockAdapterOptions): ToolDefinition[] {
  if (!options.enabled) return [];

  return [
    defineReadTool({
      name: "stock.actual",
      title: "Stock actual (no implementado)",
      description: "Insumos con alertas y pronóstico. Pendiente: API Go de mena-nails (M3).",
      schema: z.object({}),
      async handler() {
        throw new Error("The stock adapter is not implemented yet (M3)");
      },
    }),
  ];
}
