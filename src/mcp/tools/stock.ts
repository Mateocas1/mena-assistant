import { z } from "zod";
import {
  SOFT_GEL_TIP_UNITS,
  STOCK_SERVICE_KEYS,
  StockError,
  type CatalogItem,
  type ServiceLogInput,
  type StockBackend,
  type StockEntry,
  type StockServiceKey,
} from "../../adapters/stock/client.js";
import { serviceRequiresTips } from "../../adapters/stock/booking-mapping.js";
import {
  defineReadTool,
  defineWriteTool,
  ToolArgumentError,
  type ToolDefinition,
  type ToolHandlerContext,
  type ToolResult,
} from "../registry.js";
import { translateStockError } from "./stock-errors.js";
import { findRecentAppointment, humanDay } from "./turnos-shared.js";

export const STOCK_DISABLED_USER_MESSAGE =
  "El módulo de stock está desactivado en este asistente. Avisá a Mateo.";

/** The roadmap rule, inline in every advisory answer. */
export const STOCK_ADVISORY_DISCLAIMER =
  "los recuentos y los precios se cambian desde el panel de mena-nails, nunca desde el bot";

export interface StockToolsOptions {
  readonly enabled: boolean;
}

const SERVICE_KEY_DESCRIPTION =
  "Clave del servicio en mena-nails: soft_gel, capping o semipermanente (los retiros no descuentan stock).";

function requireStock(context: ToolHandlerContext): StockBackend {
  if (!context.stock) {
    throw new StockError("the stock backend is not configured", {
      userMessage: STOCK_DISABLED_USER_MESSAGE,
    });
  }
  return context.stock;
}

/** Human summary of one stock row (never fabricated: it comes from `/stock`). */
function describeEntry(entry: StockEntry): string {
  const amount =
    entry.units === null
      ? entry.uncounted
        ? "sin recuento confirmado"
        : "sin unidades"
      : `${entry.units} unidades`;
  return `- ${entry.label} · ${amount} · alerta ${entry.alert}${
    entry.movementUnits ? ` · consumidas ${Math.abs(entry.movementUnits)}` : ""
  }`;
}

function assertTipRule(
  toolName: string,
  serviceKey: StockServiceKey,
  tips: readonly { itemId: number; units: number }[] | undefined,
): void {
  const allocations = tips ?? [];
  if (!serviceRequiresTips(serviceKey)) {
    if (allocations.length > 0) {
      throw new ToolArgumentError(toolName, "ese servicio no usa tips");
    }
    return;
  }

  const total = allocations.reduce((sum, tip) => sum + tip.units, 0);
  if (total !== SOFT_GEL_TIP_UNITS) {
    throw new ToolArgumentError(
      toolName,
      `Soft Gel necesita exactamente ${SOFT_GEL_TIP_UNITS} tips y llegaron ${total}`,
    );
  }
  const seen = new Set<number>();
  for (const tip of allocations) {
    if (tip.units <= 0) throw new ToolArgumentError(toolName, "los tips deben ser positivos");
    if (seen.has(tip.itemId)) {
      throw new ToolArgumentError(toolName, "hay una asignación de tips duplicada");
    }
    seen.add(tip.itemId);
  }
}

/** Best-effort colour lookup; the catalog route is owner-only on the API today. */
async function describeColor(
  stock: StockBackend,
  colorItemId: number,
): Promise<{ label: string; warning?: string }> {
  try {
    const catalog = await stock.catalogo();
    const color = catalog.find((item: CatalogItem) => item.id === colorItemId);
    if (!color)
      return {
        label: "el color elegido",
        warning: `el catálogo no tiene el item ${colorItemId}`,
      };
    if (!color.isColor)
      return {
        label: color.displayLabel,
        warning: `${color.displayLabel} no está marcado como color`,
      };
    return { label: color.displayLabel };
  } catch {
    // Catalog reads may be forbidden for a service credential; the backend
    // validates the colour anyway, so the proposal is built from the id.
    return { label: "el color elegido" };
  }
}

/** Catalog labels for each tip allocation; a plain "tips" stands in when the catalog cannot be read. */
async function describeTips(
  stock: StockBackend,
  tips: readonly { itemId: number; units: number }[],
): Promise<{ itemId: number; units: number; label: string }[]> {
  let catalog: readonly CatalogItem[] = [];
  try {
    catalog = await stock.catalogo();
  } catch {
    // Same as describeColor: the backend validates the ids anyway.
  }
  return tips.map((tip) => ({
    ...tip,
    label: catalog.find((item) => item.id === tip.itemId)?.displayLabel ?? "tips",
  }));
}

const SERVICE_NAMES: Readonly<Record<StockServiceKey, string>> = {
  soft_gel: "Soft Gel",
  capping: "Capping",
  semipermanente: "Semipermanente",
};

/** "de Ana G. (hoy 08:00)" for the appointment, or nothing when it cannot be found. */
async function describeAppointmentFor(
  context: ToolHandlerContext,
  appointmentId: string | undefined,
): Promise<string> {
  if (!appointmentId) return "";
  const appointment = await findRecentAppointment(context, appointmentId);
  if (!appointment) return "";
  const who = appointment.clientName ? ` de ${appointment.clientName}` : "";
  return `${who} (${humanDay(appointment.date, context.clock)} ${appointment.timeSlot})`;
}

/** What the model needs from a catalog item, and nothing else: fewer prompt tokens. */
function compactCatalogItem(item: CatalogItem): Record<string, unknown> {
  return {
    id: item.id,
    nombre: item.displayLabel,
    ...(item.isColor ? { color: true } : {}),
    ...(item.tipShape ? { forma: item.tipShape } : {}),
    ...(item.tipSize !== null ? { talle: item.tipSize } : {}),
  };
}

/**
 * `stock.*` tools. Reads hit mena-nails directly; `stock.registrar_servicio` is
 * the only write and returns a proposal. `stock.proponer_correccion` is advisory
 * text and never calls any endpoint.
 */
export function createStockTools(options: StockToolsOptions): ToolDefinition[] {
  if (!options.enabled) return [];

  return [
    defineReadTool({
      name: "stock.actual",
      title: "Stock actual",
      description:
        "Lista el stock confirmado con su alerta y pronóstico. Las cantidades salen del último recuento confirmado; nunca las inventes.",
      schema: z.object({}),
      async handler(_args, context) {
        const entries = await requireStock(context).actual();
        return {
          content: JSON.stringify({ items: entries, resumen: entries.map(describeEntry) }),
          data: entries,
        };
      },
    }),

    defineReadTool({
      name: "stock.alertas",
      title: "Insumos con alerta",
      description: "Lista sólo los insumos que están por debajo de su umbral (alerta low).",
      schema: z.object({}),
      async handler(_args, context) {
        const entries = await requireStock(context).alertas();
        return {
          content: JSON.stringify({
            items: entries,
            cantidad: entries.length,
            resumen: entries.map(describeEntry),
          }),
          data: entries,
        };
      },
    }),

    defineReadTool({
      name: "stock.servicios_recientes",
      title: "Servicios registrados",
      description: "Lista los últimos servicios registrados en stock, con su precio y color.",
      schema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Cuántos traer (1-100, por defecto 10)."),
      }),
      async handler(args, context) {
        const logs = await requireStock(context).serviciosRecientes(args.limit ?? 10);
        return { content: JSON.stringify({ logs }), data: logs };
      },
    }),

    defineReadTool({
      name: "stock.precios",
      title: "Precios de servicios",
      description:
        "Lista el historial de cambios de precio de los servicios de mena-nails (auditoría de subas). " +
        "No es la lista de precios vigentes: para eso usá turnos.servicios.",
      schema: z.object({}),
      async handler(_args, context) {
        const prices = await requireStock(context).precios();
        return { content: JSON.stringify({ prices }), data: prices };
      },
    }),

    defineReadTool({
      name: "stock.catalogo",
      title: "Catálogo de insumos",
      description:
        "Lista el catálogo de insumos. Con solo_colores=true devuelve únicamente los colores, para elegir el color de un servicio.",
      schema: z.object({
        solo_colores: z.boolean().optional().describe("true para traer sólo items de color."),
      }),
      async handler(args, context) {
        const catalog = await requireStock(context).catalogo();
        const items = args.solo_colores ? catalog.filter((item) => item.isColor) : catalog;
        return { content: JSON.stringify({ items: items.map(compactCatalogItem) }), data: items };
      },
    }),

    defineWriteTool({
      name: "stock.registrar_servicio",
      title: "Registrar servicio en stock (requiere confirmación)",
      description:
        "Propone registrar un servicio hecho para descontar los insumos exactos. " +
        "NO lo registra: devuelve una propuesta que la dueña confirma con un botón. " +
        `Soft Gel usa ${SOFT_GEL_TIP_UNITS} tips en total, uno por uña, casi siempre de distintos talles: ` +
        "pasá una entrada de tips por cada item usado. " +
        "Los retiros no se registran.",
      schema: z.object({
        servicio: z
          .enum(["soft_gel", "capping", "semipermanente"])
          .describe(SERVICE_KEY_DESCRIPTION),
        colorItemId: z
          .number()
          .int()
          .positive()
          .describe("id del color usado (ver stock.catalogo con solo_colores)"),
        tips: z
          .array(
            z.object({
              itemId: z.number().int().positive(),
              units: z.number().int().positive(),
            }),
          )
          .optional()
          .describe(
            "Tips usados, una entrada por item (talle/forma): obligatorio para soft_gel, 10 unidades sumando todas.",
          ),
        sourceAppointmentId: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe("Id del turno completado; hace el registro idempotente."),
      }),
      hint: () =>
        "Antes de proponer: mirá stock.catalogo para el color y stock.actual para los tips disponibles.",
      async propose(args, context) {
        const stock = requireStock(context);
        assertTipRule("stock.registrar_servicio", args.servicio, args.tips);

        const { label, warning } = await describeColor(stock, args.colorItemId);
        const tips = await describeTips(stock, args.tips ?? []);
        const appointment = await describeAppointmentFor(context, args.sourceAppointmentId);

        const summary = `Registrar el ${SERVICE_NAMES[args.servicio]}${appointment}`;
        const diff = [
          "Se descuenta:",
          `• ${label}`,
          ...tips.map((tip) => `• ${tip.units} ${tip.label}`),
        ].join("\n");

        const proposal = context.proposals.create({
          chatId: context.chatId,
          profile: context.profile,
          tool: "stock.registrar_servicio",
          args: {
            servicio: args.servicio,
            colorItemId: args.colorItemId,
            ...(args.tips === undefined ? {} : { tips: args.tips }),
            ...(args.sourceAppointmentId === undefined
              ? {}
              : { sourceAppointmentId: args.sourceAppointmentId }),
          },
          summary,
          diff,
        });

        const result: ToolResult = {
          content: JSON.stringify({
            proposal_id: proposal.id,
            requires_confirmation: true,
            summary,
            diff,
            ...(warning === undefined ? {} : { advertencia: warning }),
          }),
          data: { proposal_id: proposal.id },
          proposal,
        };
        return result;
      },
      async executeProposal(args, context) {
        const stock = requireStock(context);
        const input: ServiceLogInput = {
          serviceKey: args.servicio,
          colorItemId: args.colorItemId,
          ...(args.tips === undefined ? {} : { tips: args.tips }),
          ...(args.sourceAppointmentId === undefined
            ? {}
            : { sourceAppointmentId: args.sourceAppointmentId }),
        };

        try {
          const result = await stock.registrarServicio(input);
          if (result.replayed) {
            return {
              content: JSON.stringify({
                replayed: true,
                logId: result.logId,
                message: "Ese turno ya estaba registrado en stock; no desconté nada de nuevo.",
              }),
              data: result,
            };
          }
          return {
            content: JSON.stringify({ registered: true, ...result }),
            data: result,
          };
        } catch (error) {
          throw translateStockError(error, "No pude registrar el servicio en stock.");
        }
      },
    }),

    defineReadTool({
      name: "stock.proponer_correccion",
      title: "Proponer corrección de stock (advisory)",
      description:
        "Devuelve una recomendación en texto para que la dueña revise el stock a mano. " +
        "Es solo asesoramiento: no ejecuta nada, no llama a ninguna API y no cambia cantidades ni precios.",
      schema: z.object({
        tema: z.string().min(3).max(120).describe("qué revisar, por ejemplo 'recuento de tips'"),
        detalle: z.string().min(3).max(600).describe("por qué, con los números observados"),
      }),
      async handler(args) {
        const recomendacion = `Revisión sugerida — ${args.tema}: ${args.detalle} (${STOCK_ADVISORY_DISCLAIMER})`;
        return {
          content: JSON.stringify({
            advisory: true,
            recomendacion,
            servicioKeys: STOCK_SERVICE_KEYS,
          }),
          data: { advisory: true, recomendacion },
        };
      },
    }),
  ];
}
