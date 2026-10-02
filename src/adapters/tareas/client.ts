/**
 * Calendar planner surface (PRD 30c). Only Mateo's chat may use it, and the
 * adapter is structurally confined to `users/{uid}` in Firestore.
 */

export interface Tarea {
  readonly id: string;
  readonly title: string;
  readonly deadline?: string;
  readonly completed?: boolean;
}

export interface AgendaBlock {
  readonly id: string;
  readonly start: string;
  readonly end: string;
  readonly taskId?: string;
}

export interface AgendaOccurrence {
  readonly id: string;
  readonly seriesId: string;
  readonly date: string;
  readonly title: string;
  readonly completed: boolean;
}

export interface Agenda {
  readonly date: string;
  /** Blocks whose ART day is `date`. */
  readonly blocks: readonly AgendaBlock[];
  /** Series occurrences of `date`, expanded from the definitions. */
  readonly occurrences: readonly AgendaOccurrence[];
  /** Open tasks due on or before `date`. */
  readonly tasks: readonly Tarea[];
}

export interface CreateTareaInput {
  readonly title: string;
  readonly deadline?: string;
}

export interface CompleteOccurrenceInput {
  readonly occurrenceId: string;
}

/** Calendar backend used by the `tareas.*` tools (Mateo only). */
export interface TareasBackend {
  /** `users/{uid}/tasks` documents. */
  listar(): Promise<Tarea[]>;
  /** Blocks + expanded series occurrences + open tasks for one ART date. */
  agenda(date: string): Promise<Agenda>;
  /** Creates one task after the copied domain validation. */
  crear(input: CreateTareaInput): Promise<Tarea>;
  /** Writes one immutable occurrence completion record. */
  completar(input: CompleteOccurrenceInput): Promise<void>;
}

export const TAREAS_DISABLED_USER_MESSAGE =
  "El módulo de tareas está desactivado en este asistente. Avisá a Mateo.";

export interface TareasErrorOptions {
  readonly userMessage?: string;
  readonly cause?: unknown;
}

export class TareasError extends Error {
  readonly userMessage: string | undefined;

  constructor(message: string, options: TareasErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TareasError";
    this.userMessage = options.userMessage;
  }
}
