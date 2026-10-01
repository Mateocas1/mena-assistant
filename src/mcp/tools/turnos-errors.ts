import { TurnosError, TurnosHttpError } from "../../adapters/turnos/client.js";

/**
 * The backend answers with English or semi-Spanish domain messages and, for
 * domain failures, an HTTP 500 (`AssistantInputError` is the only 400). The
 * assistant translates the known ones into clear Spanish before Romi sees them.
 */
const TRANSLATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/appointment not found/i, "No encontré ese turno."],
  [
    /only confirmed appointments can be completed/i,
    "Solo puedo marcar como completado un turno confirmado.",
  ],
  [/the appointment date has not arrived yet/i, "Todavía no llegó la fecha de ese turno."],
  [
    /cannot cancel this appointment/i,
    "Ese turno no se puede cancelar (ya está cancelado o completado).",
  ],
  [
    /cannot reschedule this appointment/i,
    "Ese turno no se puede reprogramar (ya está cancelado o completado).",
  ],
  [
    /este horario ya está ocupado|este horario ya fue reservado|slot taken/i,
    "Ese horario ya está ocupado. Elegí otro.",
  ],
  [/invalid time slot/i, "Ese horario no es válido."],
  [/this time slot is blocked/i, "Ese horario está bloqueado."],
  [/client name is required/i, "Falta el nombre de la clienta."],
  [/client phone is required/i, "Falta el teléfono de la clienta."],
  [/client email is invalid|client email is too long/i, "El email de la clienta no es válido."],
  [
    /client name is too long|client phone is too long/i,
    "El dato de la clienta es demasiado largo.",
  ],
  [/unknown service slug|service slug/i, "Ese servicio no existe."],
  [/not found/i, "No encontré ese registro en el sistema."],
];

function translateMessage(message: string): string | undefined {
  for (const [pattern, copy] of TRANSLATIONS) {
    if (pattern.test(message)) return copy;
  }
  return undefined;
}

/**
 * Wraps a backend failure so the callback handler can show a clear Spanish
 * message. Auth/not-configured errors already carry their own copy and pass
 * through untouched.
 */
export function translateTurnosError(error: unknown, fallback: string): TurnosError {
  if (error instanceof TurnosError && error.userMessage !== undefined) return error;

  const message = error instanceof Error ? error.message : String(error);
  const known = translateMessage(message);

  if (error instanceof TurnosHttpError && error.status >= 500) {
    return new TurnosError(message, {
      userMessage:
        known ?? `El sistema de turnos falló (${error.status}). Probá de nuevo en un momento.`,
      cause: error,
    });
  }

  return new TurnosError(message, { userMessage: known ?? fallback, cause: error });
}
