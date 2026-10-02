import { z } from "zod";
import { TareasError, type TareasBackend } from "../../adapters/tareas/client.js";
import { createOccurrenceCompletion, createTask } from "../../adapters/tareas/model.js";
import { resolveArtDate } from "../../time/index.js";
import {
  ToolArgumentError,
  defineReadTool,
  defineWriteTool,
  type ToolDefinition,
  type ToolHandlerContext,
} from "../registry.js";

export const TAREAS_MATEO_ONLY_MESSAGE = "El planner de tareas es sólo para el chat de Mateo.";

export interface TareasToolsOptions {
  readonly enabled: boolean;
}

function requireTareas(context: ToolHandlerContext): TareasBackend {
  if (context.profile !== "mateo") {
    throw new TareasError("the tareas tools are bound to Mateo's chat", {
      userMessage: TAREAS_MATEO_ONLY_MESSAGE,
    });
  }
  if (!context.tareas) {
    throw new TareasError("the tareas backend is not configured", {
      userMessage: "El módulo de tareas está desactivado en este asistente. Avisá a Mateo.",
    });
  }
  return context.tareas;
}

/** Dates are resolved by the ART module: the model never computes them. */
function resolveDeadline(toolName: string, input: string | undefined, context: ToolHandlerContext) {
  if (input === undefined || input.trim().length === 0) return undefined;
  try {
    return resolveArtDate(input, context.clock);
  } catch (error) {
    throw new ToolArgumentError(
      toolName,
      error instanceof Error ? error.message : "fecha inválida",
    );
  }
}

function describeTask(task: {
  id: string;
  title: string;
  deadline?: string;
  completed?: boolean;
}): string {
  const deadline = task.deadline ? ` · vence ${task.deadline}` : "";
  const done = task.completed ? " · hecha" : "";
  return `- ${task.title}${deadline}${done}`;
}

/**
 * `tareas.*` tools (PRD 30c). They only ever run for Mateo's chat: the
 * permission profile already hides them from Romi, and every handler re-checks it.
 * Writes return proposals; the calendar data itself lives in Mateo's subtree.
 */
export function createTareasTools(options: TareasToolsOptions): ToolDefinition[] {
  if (!options.enabled) return [];

  return [
    defineReadTool({
      name: "tareas.listar",
      title: "Tareas abiertas",
      description:
        "Lista las tareas del planner de Mateo con su fecha límite. Sólo para el chat de Mateo.",
      schema: z.object({}),
      async handler(_args, context) {
        const tasks = await requireTareas(context).listar();
        return {
          content: JSON.stringify({ tareas: tasks, resumen: tasks.map(describeTask) }),
          data: tasks,
        };
      },
    }),

    defineReadTool({
      name: "tareas.agenda",
      title: "Agenda del día",
      description:
        "Muestra la agenda de un día: bloques de trabajo, ocurrencias de series recurrentes y tareas pendientes hasta esa fecha. Sin fecha usa hoy (America/Argentina/Buenos_Aires).",
      schema: z.object({
        fecha: z
          .string()
          .optional()
          .describe(
            "Fecha ART: YYYY-MM-DD, 'hoy', 'mañana' o un día de la semana. Por defecto, hoy.",
          ),
      }),
      async handler(args, context) {
        const date =
          resolveDeadline("tareas.agenda", args.fecha, context) ??
          resolveArtDate(undefined, context.clock);
        const agenda = await requireTareas(context).agenda(date);
        return { content: JSON.stringify(agenda), data: agenda };
      },
    }),

    defineWriteTool({
      name: "tareas.crear",
      title: "Crear tarea (requiere confirmación)",
      description:
        "Propone crear una tarea en el planner de Mateo. NO la crea: devuelve una propuesta que Mateo confirma con un botón.",
      schema: z.object({
        titulo: z.string().min(1).max(200).describe("título de la tarea"),
        fecha_limite: z
          .string()
          .optional()
          .describe("Fecha límite ART: YYYY-MM-DD o una frase como 'el viernes'."),
      }),
      async propose(args, context) {
        requireTareas(context);
        const deadline = resolveDeadline("tareas.crear", args.fecha_limite, context);

        // Validate with the copied calendar rules before proposing anything.
        try {
          createTask("pending-mint", args.titulo, deadline);
        } catch (error) {
          throw new ToolArgumentError(
            "tareas.crear",
            error instanceof Error ? error.message : "tarea inválida",
          );
        }

        const summary = `Crear la tarea "${args.titulo.trim()}"${
          deadline ? ` con vencimiento ${deadline}` : ""
        }`;
        const proposal = context.proposals.create({
          chatId: context.chatId,
          profile: context.profile,
          tool: "tareas.crear",
          args: {
            titulo: args.titulo,
            ...(deadline === undefined ? {} : { fecha_limite: deadline }),
          },
          summary,
          diff: `+ ${args.titulo.trim()}${deadline ? ` · vence ${deadline}` : ""}`,
        });

        return {
          content: JSON.stringify({
            proposal_id: proposal.id,
            requires_confirmation: true,
            summary,
            diff: `+ ${args.titulo.trim()}${deadline ? ` · vence ${deadline}` : ""}`,
          }),
          data: { proposal_id: proposal.id },
          proposal,
        };
      },
      async executeProposal(args, context) {
        const deadline = resolveDeadline("tareas.crear", args.fecha_limite, context);
        const task = await requireTareas(context).crear({
          title: args.titulo,
          ...(deadline === undefined ? {} : { deadline }),
        });
        return { content: JSON.stringify({ created: true, tarea: task }), data: task };
      },
    }),

    defineWriteTool({
      name: "tareas.completar",
      title: "Completar ocurrencia (requiere confirmación)",
      description:
        "Propone marcar como hecha una ocurrencia de una serie recurrente (id de tareas.agenda). NO la completa: devuelve una propuesta que Mateo confirma con un botón.",
      schema: z.object({
        occurrenceId: z
          .string()
          .min(1)
          .describe("id de la ocurrencia, tal como aparece en tareas.agenda (serie:fecha)"),
      }),
      async propose(args, context) {
        requireTareas(context);

        // Validate the id with the copied calendar rules before proposing.
        try {
          createOccurrenceCompletion(args.occurrenceId, context.clock().toISOString());
        } catch (error) {
          throw new ToolArgumentError(
            "tareas.completar",
            error instanceof Error ? error.message : "ocurrencia inválida",
          );
        }

        const summary = `Marcar como hecha la ocurrencia ${args.occurrenceId}`;
        const proposal = context.proposals.create({
          chatId: context.chatId,
          profile: context.profile,
          tool: "tareas.completar",
          args: { occurrenceId: args.occurrenceId },
          summary,
          diff: `- ${args.occurrenceId} · pendiente\n+ ${args.occurrenceId} · hecha`,
        });

        return {
          content: JSON.stringify({
            proposal_id: proposal.id,
            requires_confirmation: true,
            summary,
            diff: `- ${args.occurrenceId} · pendiente\n+ ${args.occurrenceId} · hecha`,
          }),
          data: { proposal_id: proposal.id },
          proposal,
        };
      },
      async executeProposal(args, context) {
        await requireTareas(context).completar({ occurrenceId: args.occurrenceId });
        return {
          content: JSON.stringify({ completed: true, occurrenceId: args.occurrenceId }),
          data: { success: true, occurrenceId: args.occurrenceId },
        };
      },
    }),
  ];
}
