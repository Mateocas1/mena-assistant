import { z } from "zod";
import type { AssistantVerification } from "../../adapters/turnos/client.js";
import { TurnosError } from "../../adapters/turnos/client.js";
import { shortClientName } from "../../audit/pii.js";
import {
  ToolArgumentError,
  defineWriteTool,
  type ToolDefinition,
  type ToolHandlerContext,
  type ToolResult,
} from "../registry.js";
import {
  mapBookingServiceToStockKey,
  serviceRequiresTips,
} from "../../adapters/stock/booking-mapping.js";
import { translateTurnosError } from "./turnos-errors.js";
import {
  FECHA_DESCRIPTION,
  artDateHint,
  assertBookableDate,
  describeAppointment,
  findAppointment,
  findRecentAppointment,
  resolveDateOrArgumentError,
  slotField,
} from "./turnos-shared.js";

const CANCEL_FALLBACK = "No pude cancelar el turno.";

export const PAYMENT_ID_MISSING_MESSAGE =
  "El sistema todavía no expone el id del pago necesario para confirmar o rechazar la transferencia. Avisá a Mateo.";

/** Builds the proposal result every write tool returns instead of executing. */
function propose(
  tool: string,
  context: ToolHandlerContext,
  args: Readonly<Record<string, unknown>>,
  summary: string,
  diff: string,
): ToolResult {
  const proposal = context.proposals.create({
    chatId: context.chatId,
    profile: context.profile,
    tool,
    args,
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
}

function describeVerification(verification: AssistantVerification): string {
  const who = verification.clientName ?? "sin nombre";
  const amount = verification.amount === null ? "monto desconocido" : `$${verification.amount}`;
  const when = verification.date
    ? ` · ${verification.date}${verification.timeSlot ? ` ${verification.timeSlot}` : ""}`
    : "";
  return `${who} · ${amount}${when} · ${verification.status}`;
}

/**
 * Resolves the payment id a transfer write needs from the pending list, since
 * the read surface does not expose it yet. The model only
 * has to pass the verification id it can see.
 */
async function resolvePendingVerification(
  toolName: string,
  context: ToolHandlerContext,
  verificationId: string,
  providedPaymentId: string | undefined,
): Promise<{ verification: AssistantVerification; paymentId: string }> {
  let pending;
  try {
    pending = await context.backend.pagosPendientes();
  } catch (error) {
    throw translateTurnosError(error, "No pude consultar los pagos pendientes.");
  }

  const verification = pending.verificaciones.find((entry) => entry.id === verificationId);
  if (!verification) {
    throw new ToolArgumentError(
      toolName,
      `no hay una verificación pendiente con id ${verificationId}`,
    );
  }

  const paymentId = providedPaymentId ?? verification.paymentId;
  if (!paymentId) {
    throw new TurnosError("the pending verification does not expose a paymentId", {
      userMessage: PAYMENT_ID_MISSING_MESSAGE,
    });
  }

  return { verification, paymentId };
}

/**
 * `turnos.*` / `pagos.*` write tools. Every one returns a proposal: the backend
 * is reached only by `executeProposal`, which the callback handler owns.
 */
export function createTurnosWriteTools(): ToolDefinition[] {
  return [
    defineWriteTool({
      name: "turnos.marcar_completado",
      title: "Marcar turno completado (requiere confirmación)",
      description:
        "Propone marcar como completado un turno confirmado de un día ya pasado. " +
        "NO lo marca: devuelve una propuesta que la dueña confirma con un botón.",
      schema: z.object({
        appointmentId: z.string().min(1).describe("id del turno a completar"),
        fecha: z
          .string()
          .optional()
          .describe(`${FECHA_DESCRIPTION} Día del turno, para mostrar el detalle.`),
        // Filled by the tool from the booking; the model never has to know it.
        serviceName: z.string().optional().describe("lo completa el asistente desde el turno"),
      }),
      async propose(args, context) {
        const appointment =
          (await findAppointment(context, args.fecha, args.appointmentId)) ??
          (await findRecentAppointment(context, args.appointmentId));
        const summary = `Marcar como completado el turno ${args.appointmentId}${
          appointment ? ` — ${describeAppointment(appointment)}` : ""
        }`;
        const before = appointment ? describeAppointment(appointment) : args.appointmentId;
        const after = appointment
          ? describeAppointment(appointment, "completed")
          : `${args.appointmentId} · completed`;

        return propose(
          "turnos.marcar_completado",
          context,
          {
            appointmentId: args.appointmentId,
            fecha: args.fecha,
            ...(appointment ? { serviceName: appointment.serviceName } : {}),
          },
          summary,
          `- ${before}\n+ ${after}`,
        );
      },
      async executeProposal(args, context) {
        try {
          await context.backend.marcarCompletado(args.appointmentId);

          // Stock chain: the caller decides whether to act on this hint.
          const serviceKey = args.serviceName
            ? mapBookingServiceToStockKey(args.serviceName)
            : undefined;
          const chain = serviceKey
            ? {
                serviceKey,
                requiresTips: serviceRequiresTips(serviceKey),
                serviceName: args.serviceName ?? serviceKey,
                sourceAppointmentId: args.appointmentId,
              }
            : undefined;

          return {
            content: JSON.stringify({
              completed: true,
              appointmentId: args.appointmentId,
              ...(chain ? { stockChain: chain } : {}),
            }),
            data: { success: true, appointmentId: args.appointmentId, ...(chain ? { chain } : {}) },
          };
        } catch (error) {
          throw translateTurnosError(error, "No pude marcar el turno como completado.");
        }
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
        motivo: z.string().max(300).optional().describe("motivo de la cancelación, si se conoce"),
        fecha: z
          .string()
          .optional()
          .describe(`${FECHA_DESCRIPTION} Solo para mostrar el detalle en la confirmación.`),
      }),
      async propose(args, context) {
        const appointment = await findAppointment(context, args.fecha, args.appointmentId);
        const summary = `Cancelar el turno ${args.appointmentId}${
          appointment ? ` — ${describeAppointment(appointment)}` : ""
        }${args.motivo ? ` (motivo: ${args.motivo})` : ""}`;
        const before = appointment ? describeAppointment(appointment) : args.appointmentId;
        const after = appointment
          ? describeAppointment(appointment, "cancelled")
          : `${args.appointmentId} · cancelled`;

        return propose(
          "turnos.cancelar",
          context,
          { appointmentId: args.appointmentId, motivo: args.motivo },
          summary,
          `- ${before}\n+ ${after}`,
        );
      },
      async executeProposal(args, context) {
        try {
          const result = await context.backend.cancelar(args.appointmentId, args.motivo);
          return {
            content: JSON.stringify({
              cancelled: true,
              appointmentId: args.appointmentId,
              ...result,
            }),
            data: result,
          };
        } catch (error) {
          throw translateTurnosError(error, CANCEL_FALLBACK);
        }
      },
    }),

    defineWriteTool({
      name: "turnos.bloquear",
      title: "Bloquear agenda (requiere confirmación)",
      description:
        "Propone bloquear un día completo o un horario puntual. " +
        "NO bloquea: devuelve una propuesta que la dueña confirma con un botón.",
      schema: z.object({
        fecha: z.string().min(1).describe(FECHA_DESCRIPTION),
        hora: slotField(
          "Hora a bloquear (HH:MM). Si no la pasás, se bloquea el día completo.",
        ).optional(),
        motivo: z.string().max(300).optional().describe("motivo del bloqueo, si se conoce"),
        dia_completo: z.boolean().optional().describe("true para bloquear todo el día."),
      }),
      hint: artDateHint,
      async propose(args, context) {
        const fecha = resolveDateOrArgumentError("turnos.bloquear", args.fecha, context.clock);
        assertBookableDate("turnos.bloquear", fecha, context.clock);

        const isFullDay = args.dia_completo ?? args.hora === undefined;
        if (!isFullDay && !args.hora) {
          throw new ToolArgumentError("turnos.bloquear", "indicá la hora o marcá el día completo");
        }

        const what = isFullDay ? `el ${fecha} completo` : `el ${fecha} a las ${args.hora}`;
        const summary = `Bloquear ${what}${args.motivo ? ` (motivo: ${args.motivo})` : ""}`;
        const before = isFullDay ? `${fecha} · agenda abierta` : `${fecha} ${args.hora} · libre`;
        const after = isFullDay ? `${fecha} · día bloqueado` : `${fecha} ${args.hora} · bloqueado`;

        return propose("turnos.bloquear", context, { ...args }, summary, `- ${before}\n+ ${after}`);
      },
      async executeProposal(args, context) {
        const fecha = resolveDateOrArgumentError("turnos.bloquear", args.fecha, context.clock);
        const isFullDay = args.dia_completo ?? args.hora === undefined;

        try {
          const result = await context.backend.bloquear({
            date: fecha,
            isFullDay,
            ...(args.hora === undefined ? {} : { timeSlot: args.hora }),
            ...(args.motivo === undefined ? {} : { reason: args.motivo }),
          });
          return { content: JSON.stringify({ blocked: true, ...result }), data: result };
        } catch (error) {
          throw translateTurnosError(error, "No pude bloquear ese horario.");
        }
      },
    }),

    defineWriteTool({
      name: "turnos.desbloquear",
      title: "Quitar bloqueo (requiere confirmación)",
      description:
        "Propone quitar un bloqueo existente. NO lo quita: devuelve una propuesta que la dueña confirma con un botón.",
      schema: z.object({
        blockedSlotId: z.string().min(1).describe("id del bloqueo a quitar"),
        fecha: z.string().optional().describe(`${FECHA_DESCRIPTION} Día del bloqueo.`),
        hora: slotField("Hora bloqueada (HH:MM), si fue un bloqueo puntual.").optional(),
        dia_completo: z.boolean().optional().describe("true si el bloqueo era de día completo."),
      }),
      async propose(args, context) {
        const fecha = args.fecha
          ? resolveDateOrArgumentError("turnos.desbloquear", args.fecha, context.clock)
          : undefined;
        const detail = fecha
          ? ` del ${fecha}${args.hora ? ` a las ${args.hora}` : " (día completo)"}`
          : "";

        const summary = `Quitar el bloqueo ${args.blockedSlotId}${detail}`;
        const before = detail
          ? `${fecha}${args.hora ? ` ${args.hora}` : ""} · bloqueado`
          : `${args.blockedSlotId} · bloqueado`;
        const after = detail
          ? `${fecha}${args.hora ? ` ${args.hora}` : ""} · libre`
          : `${args.blockedSlotId} · libre`;

        return propose(
          "turnos.desbloquear",
          context,
          { blockedSlotId: args.blockedSlotId, fecha: args.fecha, hora: args.hora },
          summary,
          `- ${before}\n+ ${after}`,
        );
      },
      async executeProposal(args, context) {
        try {
          const result = await context.backend.desbloquear(args.blockedSlotId);
          return {
            content: JSON.stringify({
              unblocked: true,
              blockedSlotId: args.blockedSlotId,
              ...result,
            }),
            data: result,
          };
        } catch (error) {
          throw translateTurnosError(error, "No pude quitar ese bloqueo.");
        }
      },
    }),

    defineWriteTool({
      name: "turnos.crear_para_clienta",
      title: "Crear turno para una clienta (requiere confirmación)",
      description:
        "Propone crear un turno a nombre de una clienta. NO lo crea: devuelve una propuesta que la dueña confirma con un botón.",
      schema: z.object({
        cliente: z.string().min(2).max(120).describe("nombre de la clienta"),
        telefono: z.string().min(6).max(40).describe("teléfono de la clienta"),
        email: z.string().email().optional().describe("email de la clienta, si lo tiene"),
        servicio: z.string().min(1).describe("slug del servicio (ver turnos.servicios)"),
        fecha: z.string().min(1).describe(FECHA_DESCRIPTION),
        hora: slotField("Hora del turno (HH:MM)"),
        retiro: z.boolean().optional().describe("true si el turno incluye retiro"),
        notas: z.string().max(300).optional().describe("notas para el turno"),
      }),
      hint: () => "Usá turnos.servicios y turnos.disponibilidad antes de proponer un turno nuevo.",
      async propose(args, context) {
        const fecha = resolveDateOrArgumentError(
          "turnos.crear_para_clienta",
          args.fecha,
          context.clock,
        );
        assertBookableDate("turnos.crear_para_clienta", fecha, context.clock);

        const who = shortClientName(args.cliente) ?? args.cliente;
        const summary = `Crear turno para ${args.cliente} (${args.telefono}) — ${args.servicio}, ${fecha} ${args.hora}${args.retiro ? " con retiro" : ""}`;
        const before = `${fecha} ${args.hora} · libre`;
        const after = `${fecha} ${args.hora} · ${args.servicio} · ${who} · pending`;

        return propose(
          "turnos.crear_para_clienta",
          context,
          { ...args, fecha },
          summary,
          `- ${before}\n+ ${after}`,
        );
      },
      async executeProposal(args, context) {
        const fecha = resolveDateOrArgumentError(
          "turnos.crear_para_clienta",
          args.fecha,
          context.clock,
        );

        try {
          const result = await context.backend.crearParaClienta({
            clientName: args.cliente,
            clientPhone: args.telefono,
            serviceSlug: args.servicio,
            date: fecha,
            timeSlot: args.hora,
            ...(args.email === undefined ? {} : { clientEmail: args.email }),
            ...(args.retiro === undefined ? {} : { removalAddOn: args.retiro }),
            ...(args.notas === undefined ? {} : { notes: args.notas }),
          });
          return { content: JSON.stringify({ created: true, ...result }), data: result };
        } catch (error) {
          throw translateTurnosError(error, "No pude crear el turno.");
        }
      },
    }),

    defineWriteTool({
      name: "turnos.reprogramar",
      title: "Reprogramar turno (requiere confirmación)",
      description:
        "Propone mover un turno a otra fecha y horario. NO lo mueve: devuelve una propuesta que la dueña confirma con un botón.",
      schema: z.object({
        appointmentId: z.string().min(1).describe("id del turno a mover"),
        fecha: z.string().min(1).describe(`${FECHA_DESCRIPTION} Nueva fecha.`),
        hora: slotField("Nuevo horario (HH:MM)"),
        fecha_actual: z
          .string()
          .optional()
          .describe(`${FECHA_DESCRIPTION} Fecha actual del turno, para mostrar el cambio.`),
      }),
      hint: artDateHint,
      async propose(args, context) {
        const fecha = resolveDateOrArgumentError("turnos.reprogramar", args.fecha, context.clock);
        assertBookableDate("turnos.reprogramar", fecha, context.clock);

        const current = await findAppointment(context, args.fecha_actual, args.appointmentId);
        const from = current ? `${current.date} ${current.timeSlot}` : "su horario actual";
        const summary = `Reprogramar el turno ${args.appointmentId} de ${from} a ${fecha} ${args.hora}${
          current ? ` (${current.serviceName} · ${current.clientName ?? "sin nombre"})` : ""
        }`;
        const before = current
          ? describeAppointment(current)
          : `${args.appointmentId} · horario actual`;
        const after = current
          ? `${fecha} ${args.hora} · ${current.serviceName} · ${current.clientName ?? "sin nombre"} · ${current.status}`
          : `${args.appointmentId} → ${fecha} ${args.hora}`;

        return propose(
          "turnos.reprogramar",
          context,
          {
            appointmentId: args.appointmentId,
            fecha,
            hora: args.hora,
            fecha_actual: args.fecha_actual,
          },
          summary,
          `- ${before}\n+ ${after}`,
        );
      },
      async executeProposal(args, context) {
        const fecha = resolveDateOrArgumentError("turnos.reprogramar", args.fecha, context.clock);

        try {
          const result = await context.backend.reprogramar(args.appointmentId, fecha, args.hora);
          return { content: JSON.stringify({ rescheduled: true, ...result }), data: result };
        } catch (error) {
          throw translateTurnosError(error, "No pude reprogramar el turno.");
        }
      },
    }),

    defineWriteTool({
      name: "pagos.confirmar_transferencia",
      title: "Confirmar transferencia (requiere confirmación)",
      description:
        "Propone confirmar una transferencia que está esperando revisión (ver turnos.pagos_pendientes). " +
        "NO la confirma: devuelve una propuesta que la dueña confirma con un botón.",
      schema: z.object({
        verificationId: z
          .string()
          .min(1)
          .describe("id de la verificación pendiente (campo id de turnos.pagos_pendientes)"),
        paymentId: z
          .string()
          .min(1)
          .optional()
          .describe("lo completa el asistente desde los pagos pendientes; no hace falta pasarlo"),
      }),
      async propose(args, context) {
        const { verification, paymentId } = await resolvePendingVerification(
          "pagos.confirmar_transferencia",
          context,
          args.verificationId,
          args.paymentId,
        );

        const summary = `Confirmar la transferencia de ${describeVerification(verification)}`;
        const diff = `- ${verification.id} · ${verification.status}\n+ ${verification.id} · matched`;

        return propose(
          "pagos.confirmar_transferencia",
          context,
          { verificationId: args.verificationId, paymentId },
          summary,
          diff,
        );
      },
      async executeProposal(args, context) {
        if (!args.paymentId)
          throw new TurnosError("missing paymentId", { userMessage: PAYMENT_ID_MISSING_MESSAGE });
        try {
          const result = await context.backend.confirmarTransferencia(
            args.paymentId,
            args.verificationId,
          );
          return {
            content: JSON.stringify({
              confirmed: true,
              verificationId: args.verificationId,
              ...result,
            }),
            data: result,
          };
        } catch (error) {
          throw translateTurnosError(error, "No pude confirmar la transferencia.");
        }
      },
    }),

    defineWriteTool({
      name: "pagos.rechazar_transferencia",
      title: "Rechazar transferencia (requiere confirmación)",
      description:
        "Propone rechazar una transferencia que está esperando revisión, con un motivo. " +
        "NO la rechaza: devuelve una propuesta que la dueña confirma con un botón.",
      schema: z.object({
        verificationId: z
          .string()
          .min(1)
          .describe("id de la verificación pendiente (campo id de turnos.pagos_pendientes)"),
        motivo: z.string().min(3).max(300).describe("motivo del rechazo (obligatorio)"),
        paymentId: z
          .string()
          .min(1)
          .optional()
          .describe("lo completa el asistente desde los pagos pendientes; no hace falta pasarlo"),
      }),
      async propose(args, context) {
        const { verification, paymentId } = await resolvePendingVerification(
          "pagos.rechazar_transferencia",
          context,
          args.verificationId,
          args.paymentId,
        );

        const summary = `Rechazar la transferencia de ${describeVerification(verification)} (motivo: ${args.motivo})`;
        const diff = `- ${verification.id} · ${verification.status}\n+ ${verification.id} · rejected`;

        return propose(
          "pagos.rechazar_transferencia",
          context,
          { verificationId: args.verificationId, motivo: args.motivo, paymentId },
          summary,
          diff,
        );
      },
      async executeProposal(args, context) {
        if (!args.paymentId)
          throw new TurnosError("missing paymentId", { userMessage: PAYMENT_ID_MISSING_MESSAGE });
        try {
          const result = await context.backend.rechazarTransferencia(
            args.paymentId,
            args.verificationId,
            args.motivo,
          );
          return {
            content: JSON.stringify({
              rejected: true,
              verificationId: args.verificationId,
              ...result,
            }),
            data: result,
          };
        } catch (error) {
          throw translateTurnosError(error, "No pude rechazar la transferencia.");
        }
      },
    }),
  ];
}
