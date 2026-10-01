import { z } from "zod";
import type { Appointment } from "../../adapters/turnos/client.js";
import { resolveArtDate } from "../../time/index.js";
import {
  defineReadTool,
  defineWriteTool,
  type ToolDefinition,
  type ToolHandlerContext,
} from "../registry.js";

const FECHA_DESCRIPTION =
  "Fecha en America/Argentina/Buenos_Aires: YYYY-MM-DD, o 'hoy' / 'mañana' / 'ayer'.";

/** Looks the appointment up when the caller knows its day, to enrich the proposal. */
async function findAppointment(
  context: ToolHandlerContext,
  fecha: string | undefined,
  appointmentId: string,
): Promise<Appointment | undefined> {
  if (!fecha) return undefined;
  const date = resolveArtDate(fecha, context.clock);
  const appointments = await context.backend.delDia(date);
  return appointments.find((appointment) => appointment.id === appointmentId);
}

function describeAppointment(appointment: Appointment, status = appointment.status): string {
  const who = appointment.clientName ?? "sin nombre";
  return `${appointment.date} ${appointment.timeSlot} · ${appointment.serviceName} · ${who} · ${status}`;
}

/**
 * `turnos.*` tools (PRD 30a). Reads hit the booking backend directly; the only
 * write returns a proposal and never touches the backend.
 */
export function createTurnosTools(): ToolDefinition[] {
  return [
    defineReadTool({
      name: "turnos.del_dia",
      title: "Turnos del día",
      description:
        "Lista los turnos de un día. Sin fecha usa hoy (America/Argentina/Buenos_Aires). " +
        "Devuelve cada turno con id, fecha, horario, estado, servicio y nombre corto de la clienta.",
      schema: z.object({
        fecha: z.string().optional().describe(`${FECHA_DESCRIPTION} Por defecto, hoy.`),
      }),
      async handler(args, context) {
        const fecha = resolveArtDate(args.fecha, context.clock);
        const turnos = await context.backend.delDia(fecha);
        return { content: JSON.stringify({ fecha, turnos }), data: turnos };
      },
    }),

    defineReadTool({
      name: "turnos.disponibilidad",
      title: "Disponibilidad del día",
      description:
        "Lista los horarios libres y ocupados de una fecha, para ofrecerle un turno a una clienta.",
      schema: z.object({
        fecha: z.string().describe(`${FECHA_DESCRIPTION} Requerida.`),
      }),
      async handler(args, context) {
        const fecha = resolveArtDate(args.fecha, context.clock);
        const horarios = await context.backend.disponibilidad(fecha);
        return {
          content: JSON.stringify({
            fecha,
            horarios,
            libres: horarios.filter((s) => s.available).map((s) => s.time),
          }),
          data: horarios,
        };
      },
    }),

    defineReadTool({
      name: "turnos.servicios",
      title: "Servicios y precios",
      description: "Lista los servicios activos del salón con precio y duración en minutos.",
      schema: z.object({}),
      async handler(_args, context) {
        const servicios = await context.backend.servicios();
        return { content: JSON.stringify({ servicios }), data: servicios };
      },
    }),

    defineWriteTool({
      name: "turnos.cancelar",
      title: "Cancelar turno (requiere confirmación)",
      description:
        "Propone cancelar un turno. NO cancela: devuelve una propuesta que la dueña debe confirmar " +
        "con un botón. Nunca inventes el appointmentId: obtenlo antes con turnos.del_dia.",
      schema: z.object({
        appointmentId: z.string().min(1).describe("id del turno a cancelar"),
        motivo: z.string().optional().describe("motivo de la cancelación, si se conoce"),
        fecha: z
          .string()
          .optional()
          .describe(`${FECHA_DESCRIPTION} Solo para mostrar el detalle en la confirmación.`),
      }),
      async propose(args, context) {
        const appointment = await findAppointment(context, args.fecha, args.appointmentId);
        const detail = appointment ? ` — ${describeAppointment(appointment)}` : "";
        const summary = `Cancelar el turno ${args.appointmentId}${detail}${
          args.motivo ? ` (motivo: ${args.motivo})` : ""
        }`;
        const before = appointment ? describeAppointment(appointment) : args.appointmentId;
        const diff = `- ${before}\n+ ${appointment ? describeAppointment(appointment, "cancelled") : `${args.appointmentId} · cancelled`}`;

        const proposal = context.proposals.create({
          chatId: context.chatId,
          profile: context.profile,
          tool: "turnos.cancelar",
          args: { appointmentId: args.appointmentId, motivo: args.motivo },
          summary,
          diff,
        });

        return {
          content: JSON.stringify({
            proposal_id: proposal.id,
            requires_confirmation: true,
            summary,
            diff,
          }),
          data: { proposal_id: proposal.id },
          proposal,
        };
      },
      async executeProposal(args, context) {
        const result = await context.backend.cancelar(args.appointmentId, args.motivo);
        return {
          content: JSON.stringify({
            cancelled: true,
            appointmentId: args.appointmentId,
            ...result,
          }),
          data: result,
        };
      },
    }),
  ];
}
