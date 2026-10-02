import { z } from "zod";
import { MAX_RANGE_DAYS } from "../../time/index.js";
import { defineReadTool, type ToolDefinition } from "../registry.js";
import {
  FECHA_DESCRIPTION,
  artDateHint,
  resolveDateOrArgumentError,
  resolveRangeOrArgumentError,
} from "./turnos-shared.js";

/** `turnos.*` read tools (PRD 30a); they never touch state. */
export function createTurnosReadTools(): ToolDefinition[] {
  return [
    defineReadTool({
      name: "turnos.del_dia",
      title: "Turnos del día",
      description:
        "Lista los turnos de un día. Sin fecha usa hoy (America/Argentina/Buenos_Aires). " +
        "Es la agenda del día: qué turnos hay. Para números o facturación usá turnos.resumen.",
      schema: z.object({
        fecha: z.string().optional().describe(`${FECHA_DESCRIPTION} Por defecto, hoy.`),
      }),
      hint: artDateHint,
      async handler(args, context) {
        const fecha = resolveDateOrArgumentError("turnos.del_dia", args.fecha, context.clock);
        const turnos = await context.backend.delDia(fecha);
        return { content: JSON.stringify({ fecha, turnos }), data: turnos };
      },
    }),

    defineReadTool({
      name: "turnos.rango",
      title: "Turnos de un rango",
      description:
        `Lista los turnos entre dos fechas, ambas incluidas (máximo ${MAX_RANGE_DAYS} días). ` +
        "Usala para 'esta semana' o 'la semana que viene', pasando esas palabras en `desde` sin `hasta`. " +
        "Para un solo día usá turnos.del_dia.",
      schema: z.object({
        desde: z.string().optional().describe(`${FECHA_DESCRIPTION} o 'esta semana'.`),
        hasta: z.string().optional().describe(`${FECHA_DESCRIPTION} Por defecto, igual a 'desde'.`),
      }),
      hint: artDateHint,
      async handler(args, context) {
        const range = resolveRangeOrArgumentError(
          "turnos.rango",
          args.desde,
          args.hasta,
          context.clock,
        );
        const turnos = await context.backend.rango(range.from, range.to);
        return {
          content: JSON.stringify({ desde: range.from, hasta: range.to, turnos }),
          data: turnos,
        };
      },
    }),

    defineReadTool({
      name: "turnos.disponibilidad",
      title: "Disponibilidad del día",
      description:
        "Lista los horarios libres y ocupados de una fecha, para ofrecerle un turno a una clienta. " +
        "Sin fecha usa hoy (America/Argentina/Buenos_Aires).",
      schema: z.object({
        fecha: z.string().optional().describe(`${FECHA_DESCRIPTION} Por defecto, hoy.`),
      }),
      hint: artDateHint,
      async handler(args, context) {
        const fecha = resolveDateOrArgumentError(
          "turnos.disponibilidad",
          args.fecha,
          context.clock,
        );
        const horarios = await context.backend.disponibilidad(fecha);
        return {
          content: JSON.stringify({
            fecha,
            horarios,
            libres: horarios.filter((slot) => slot.available).map((slot) => slot.time),
          }),
          data: horarios,
        };
      },
    }),

    defineReadTool({
      name: "turnos.servicios",
      title: "Servicios y precios",
      description:
        "Lista los servicios activos del salón con su precio actual y duración en minutos. " +
        "Es la fuente de los precios vigentes; para el historial de cambios de precio usá stock.precios.",
      schema: z.object({}),
      async handler(_args, context) {
        const servicios = await context.backend.servicios();
        return { content: JSON.stringify({ servicios }), data: servicios };
      },
    }),

    defineReadTool({
      name: "turnos.pagos_pendientes",
      title: "Pagos por revisar",
      description:
        "Lista las transferencias y comprobantes que esperan revisión, más el resumen de reintegros pendientes.",
      schema: z.object({}),
      async handler(_args, context) {
        const data = await context.backend.pagosPendientes();
        return {
          content: JSON.stringify({
            verificaciones: data.verificaciones,
            reintegros: data.reintegros,
          }),
          data,
        };
      },
    }),

    defineReadTool({
      name: "turnos.resumen",
      title: "Resumen del día",
      description:
        "Resumen de un día: cantidad de turnos por estado, seña facturada, pagos por revisar y reintegros pendientes. " +
        "Son números agregados y facturación, no la lista de turnos: para ver los turnos del día usá turnos.del_dia. " +
        "Sin fecha usa hoy.",
      schema: z.object({
        fecha: z.string().optional().describe(`${FECHA_DESCRIPTION} Por defecto, hoy.`),
      }),
      hint: artDateHint,
      async handler(args, context) {
        const fecha = resolveDateOrArgumentError("turnos.resumen", args.fecha, context.clock);
        const resumen = await context.backend.resumen(fecha);
        return { content: JSON.stringify(resumen), data: resumen };
      },
    }),
  ];
}
