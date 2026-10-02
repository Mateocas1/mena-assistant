import { randomUUID } from "node:crypto";
import { artDate, systemClock, type Clock } from "../../time/index.js";
import {
  TareasError,
  type Agenda,
  type AgendaBlock,
  type AgendaOccurrence,
  type CreateTareaInput,
  type Tarea,
  type TareasBackend,
} from "./client.js";
import { createOccurrenceCompletion, createTask, expandOccurrences, requireDate } from "./model.js";
import type { TareasStore } from "./store.js";

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function toTask(record: { id: string; data: Readonly<Record<string, unknown>> }): Tarea {
  const deadline = asString(record.data.deadline);
  return {
    id: record.id,
    title: asString(record.data.title) ?? "",
    ...(deadline === undefined ? {} : { deadline }),
    ...(record.data.completed === undefined ? {} : { completed: asBoolean(record.data.completed) }),
  };
}

function validationError(error: unknown, fallback: string): TareasError {
  if (error instanceof TareasError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new TareasError(message, { userMessage: fallback, cause: error });
}

/**
 * Store-agnostic calendar backend: the same logic runs over the in-memory store
 * (mock/tests) and over Firestore, so behaviour cannot drift between them.
 */
export function createStoreTareasBackend(
  store: TareasStore,
  options: { readonly clock?: Clock } = {},
): TareasBackend {
  const clock = options.clock ?? systemClock;

  return {
    async listar(): Promise<Tarea[]> {
      const records = await store.list("tasks");
      return records
        .map(toTask)
        .sort((left, right) => (left.deadline ?? "9999").localeCompare(right.deadline ?? "9999"));
    },

    async agenda(date: string): Promise<Agenda> {
      try {
        requireDate(date);
      } catch (error) {
        throw validationError(error, "Esa fecha no es válida.");
      }

      const [tasks, series, completions, blocks] = await Promise.all([
        store.list("tasks"),
        store.list("series"),
        store.list("completions"),
        store.list("blocks"),
      ]);

      const completedIds = new Set(completions.map((record) => record.id));

      const occurrences: AgendaOccurrence[] = [];
      for (const record of series) {
        const frequency = asString(record.data.frequency);
        const anchorDate = asString(record.data.anchorDate);
        if (frequency !== "daily" && frequency !== "weekly" && frequency !== "monthly") {
          continue;
        }
        if (anchorDate === undefined) continue;

        try {
          const expanded = expandOccurrences(
            { seriesId: record.id, frequency, anchorDate },
            date,
            date,
          );
          for (const occurrence of expanded) {
            occurrences.push({
              id: occurrence.id,
              seriesId: record.id,
              date: occurrence.date,
              title: asString(record.data.title) ?? "",
              completed: completedIds.has(occurrence.id),
            });
          }
        } catch {
          // A malformed series definition must not break the whole agenda.
        }
      }

      const dayBlocks: AgendaBlock[] = blocks
        .filter((record) => {
          const start = asString(record.data.start);
          if (start === undefined) return false;
          const parsed = new Date(start);
          return !Number.isNaN(parsed.getTime()) && artDate(parsed) === date;
        })
        .map((record) => {
          const taskId = asString(record.data.taskId);
          return {
            id: record.id,
            start: asString(record.data.start) ?? "",
            end: asString(record.data.end) ?? "",
            ...(taskId === undefined ? {} : { taskId }),
          };
        })
        .sort((left, right) => left.start.localeCompare(right.start));

      const openTasks = tasks
        .map(toTask)
        .filter(
          (task) => task.completed !== true && task.deadline !== undefined && task.deadline <= date,
        );

      return { date, blocks: dayBlocks, occurrences, tasks: openTasks };
    },

    async crear(input: CreateTareaInput): Promise<Tarea> {
      let task;
      try {
        task = createTask(randomUUID(), input.title, input.deadline);
      } catch (error) {
        throw validationError(error, "No pude crear la tarea: revisá el título y la fecha.");
      }

      await store.set("tasks", task.id, {
        title: task.title,
        ...(task.deadline === undefined ? {} : { deadline: task.deadline }),
      });
      return task;
    },

    async completar(input): Promise<void> {
      let completion;
      try {
        completion = createOccurrenceCompletion(input.occurrenceId, clock().toISOString());
      } catch (error) {
        throw validationError(error, "Esa ocurrencia no es válida.");
      }

      // Completions are immutable, one document per occurrence: re-completing
      // writes the same id, so it can never duplicate history.
      await store.set("completions", completion.occurrenceId, {
        occurrenceId: completion.occurrenceId,
        completedAt: completion.completedAt,
      });
    },
  };
}
