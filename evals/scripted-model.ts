import { addDays, artToday, nextWeekday, resolveArtRange, type Clock } from "../src/time/index.js";
import type { LlmCompletion, LlmCompletionRequest, LlmTransport } from "../src/llm/types.js";

export interface PlannedToolCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

const WEEKDAYS: Readonly<Record<string, number>> = {
  lunes: 0,
  martes: 1,
  miercoles: 2,
  jueves: 3,
  viernes: 4,
  sabado: 5,
  domingo: 6,
};

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Extracts the single date expression a Spanish question carries, in ART. */
export function extractDate(question: string, clock: Clock): string | undefined {
  const text = normalize(question);
  const today = artToday(clock);

  const iso = text.match(/\d{4}-\d{2}-\d{2}/);
  if (iso) return iso[0];

  if (/\bpasado manana\b/.test(text)) return addDays(today, 2);
  if (/\bmanana\b/.test(text)) return addDays(today, 1);
  if (/\bhoy\b/.test(text)) return today;
  if (/\bayer\b/.test(text)) return addDays(today, -1);

  for (const [name, index] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`\\b${name}\\b`).test(text)) return nextWeekday(today, index);
  }

  return undefined;
}

const COMPLETAR_PATTERN = /(complet|finaliz)/;
const CREAR_PATTERN =
  /(cre(a|á) (un )?turno|crear (un )?turno|agend(a|á) (un )?turno|reserv(a|á) (un )?turno|nuevo turno para)/;
const REPROGRAMAR_PATTERN = /(reprogram|pas(a|á) el turno|cambi(a|á) el turno|mov(e|é) el turno)/;
const TRANSFER_PATTERN = /(transferencia|comprobante|pago)/;
const CONFIRMAR_PATTERN = /confirm/;
const RECHAZAR_PATTERN = /rechaz/;
const DESBLOQUEAR_PATTERN = /(desbloqu|quit(a|á) el bloqueo|sac(a|á) el bloqueo)/;

const RANGO_PATTERN =
  /(esta semana|semana actual|semana que viene|proxima semana|semana proxima|rango|desde el |entre el )/;
const PAGOS_PATTERN = /(pago|transferencia|reintegro|verificacion|comprobante)/;
const RESUMEN_PATTERN = /(resumen|recaudacion|balance|factur|numeros|como venimos)/;
const DISPONIBILIDAD_PATTERN = /(disponibilidad|libres?|horario)/;
const SERVICIOS_PATTERN = /(servicio|precio)/;
const DEL_DIA_PATTERN = /(turno|agenda|del dia|el dia)/;

/** Ids the questions carry verbatim; the real model reads them from the tools. */
function extractAppointmentId(text: string): string | undefined {
  return text.match(/apt_[a-z0-9_-]+/)?.[0];
}

function extractBlockId(text: string): string | undefined {
  return text.match(/blk_[a-z0-9_-]+/)?.[0];
}

function extractVerificationId(text: string): string | undefined {
  return text.match(/ver_[a-z0-9_-]+/)?.[0];
}

function extractSlot(text: string): string | undefined {
  return text.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/)?.[0];
}

function extractSlug(text: string): string | undefined {
  return text.match(/\b(?:servicio|retiro)-(?:softgel|capping|semi|semipermanente)\b/)?.[0];
}

/** Reason after "porque", taken from the original (non-normalised) text. */
function extractReason(question: string): string | undefined {
  const match = question.match(/porque\s+(.+?)[.!]?$/i);
  return match?.[1]?.trim();
}

function extractClient(question: string): string | undefined {
  const match = question.match(/para\s+([^,]+?)\s*(?:,|$)/i);
  return match?.[1]?.trim();
}

function extractPhone(question: string): string | undefined {
  const match = question.match(/(?:tel[eé]fono|tel|celular)\s*:?\s*([\d][\d\s+()-]{5,})/i);
  return match?.[1]?.trim();
}

/**
 * Write intents. Order matters: "desbloquear" before "bloquear", and a
 * confirm/reject verb before the pending-payments read.
 */
function planWriteCall(
  text: string,
  question: string,
  has: (name: string) => boolean,
  fecha: string | undefined,
): PlannedToolCall | null {
  if (DESBLOQUEAR_PATTERN.test(text) && has("turnos.desbloquear")) {
    const blockedSlotId = extractBlockId(text);
    return blockedSlotId ? { tool: "turnos.desbloquear", args: { blockedSlotId } } : null;
  }

  if (/bloqu/.test(text) && has("turnos.bloquear")) {
    const hora = extractSlot(question);
    const motivo = extractReason(question);
    return {
      tool: "turnos.bloquear",
      args: {
        ...(fecha ? { fecha } : {}),
        ...(hora ? { hora } : {}),
        ...(motivo ? { motivo } : {}),
      },
    };
  }

  if (
    TRANSFER_PATTERN.test(text) &&
    RECHAZAR_PATTERN.test(text) &&
    has("pagos.rechazar_transferencia")
  ) {
    const verificationId = extractVerificationId(text);
    const motivo = extractReason(question);
    return {
      tool: "pagos.rechazar_transferencia",
      args: {
        ...(verificationId ? { verificationId } : {}),
        ...(motivo ? { motivo } : {}),
      },
    };
  }

  if (
    TRANSFER_PATTERN.test(text) &&
    CONFIRMAR_PATTERN.test(text) &&
    has("pagos.confirmar_transferencia")
  ) {
    const verificationId = extractVerificationId(text);
    return {
      tool: "pagos.confirmar_transferencia",
      args: verificationId ? { verificationId } : {},
    };
  }

  if (COMPLETAR_PATTERN.test(text) && /turno/.test(text) && has("turnos.marcar_completado")) {
    const appointmentId = extractAppointmentId(text);
    return appointmentId ? { tool: "turnos.marcar_completado", args: { appointmentId } } : null;
  }

  if (CREAR_PATTERN.test(text) && has("turnos.crear_para_clienta")) {
    const cliente = extractClient(question);
    const telefono = extractPhone(question);
    const servicio = extractSlug(text);
    const hora = extractSlot(question);
    const retiro = /con retiro/.test(text);
    return {
      tool: "turnos.crear_para_clienta",
      args: {
        ...(cliente ? { cliente } : {}),
        ...(telefono ? { telefono } : {}),
        ...(servicio ? { servicio } : {}),
        ...(fecha ? { fecha } : {}),
        ...(hora ? { hora } : {}),
        ...(retiro ? { retiro: true } : {}),
      },
    };
  }

  if (REPROGRAMAR_PATTERN.test(text) && has("turnos.reprogramar")) {
    const appointmentId = extractAppointmentId(text);
    const hora = extractSlot(question);
    return {
      tool: "turnos.reprogramar",
      args: {
        ...(appointmentId ? { appointmentId } : {}),
        ...(fecha ? { fecha } : {}),
        ...(hora ? { hora } : {}),
      },
    };
  }

  if (/cancel/.test(text) && has("turnos.cancelar")) {
    const appointmentId = extractAppointmentId(text);
    return { tool: "turnos.cancelar", args: appointmentId ? { appointmentId } : {} };
  }

  return null;
}

function planRangeArgs(text: string, question: string, clock: Clock): Record<string, unknown> {
  if (/semana que viene|proxima semana|semana proxima/.test(text)) {
    const range = resolveArtRange("la semana que viene", undefined, clock);
    return { desde: range.from, hasta: range.to };
  }
  if (/esta semana|semana actual/.test(text)) {
    const range = resolveArtRange("esta semana", undefined, clock);
    return { desde: range.from, hasta: range.to };
  }

  const isoDates = text.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  if (isoDates.length >= 2) return { desde: isoDates[0], hasta: isoDates[1] };
  if (isoDates.length === 1) return { desde: isoDates[0], hasta: isoDates[0] };

  const date = extractDate(question, clock);
  return date ? { desde: date, hasta: date } : {};
}

/**
 * The deterministic stand-in for the model used by `pnpm eval` in CI. It is not
 * a quality measurement of any real model; it locks tool selection and argument
 * resolution (especially ART date phrases) so regressions fail in CI.
 * `pnpm eval:live` runs the same dataset against a real model.
 */
export function planToolCall(
  question: string,
  availableTools: readonly string[],
  clock: Clock,
): PlannedToolCall | null {
  const text = normalize(question);
  const has = (name: string) => availableTools.includes(name);
  const fecha = extractDate(question, clock);

  const write = planWriteCall(text, question, has, fecha);
  if (write) return write;

  if (RANGO_PATTERN.test(text) && has("turnos.rango")) {
    return { tool: "turnos.rango", args: planRangeArgs(text, question, clock) };
  }

  if (PAGOS_PATTERN.test(text) && has("turnos.pagos_pendientes")) {
    return { tool: "turnos.pagos_pendientes", args: {} };
  }

  if (RESUMEN_PATTERN.test(text) && has("turnos.resumen")) {
    return { tool: "turnos.resumen", args: fecha ? { fecha } : {} };
  }

  if (DISPONIBILIDAD_PATTERN.test(text) && has("turnos.disponibilidad")) {
    // No date phrase? Forward nothing: the tool defaults to today server-side.
    return { tool: "turnos.disponibilidad", args: fecha ? { fecha } : {} };
  }

  if (SERVICIOS_PATTERN.test(text) && has("turnos.servicios")) {
    return { tool: "turnos.servicios", args: {} };
  }

  if (DEL_DIA_PATTERN.test(text) && has("turnos.del_dia")) {
    return { tool: "turnos.del_dia", args: fecha ? { fecha } : {} };
  }

  return null;
}

const USAGE = { prompt: 0, completion: 0, total: 0 };

/** Scripted transport: routes the question with {@link planToolCall}, then answers. */
export function createScriptedTransport(clock: Clock): LlmTransport {
  return {
    async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
      const last = request.messages[request.messages.length - 1];

      // After a tool result the scripted model just answers.
      if (last?.role === "tool") {
        return {
          content: "Listo, te paso el detalle.",
          toolCalls: [],
          model: request.model,
          usage: USAGE,
        };
      }

      const question =
        [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
      const available = request.tools.map((tool) => tool.function.name);
      const plan = planToolCall(question, available, clock);

      if (!plan) {
        return {
          content: "¡Hola! ¿Qué necesitás del salón?",
          toolCalls: [],
          model: request.model,
          usage: USAGE,
        };
      }

      return {
        content: null,
        toolCalls: [{ id: "scripted_1", name: plan.tool, arguments: JSON.stringify(plan.args) }],
        model: request.model,
        usage: USAGE,
      };
    },
  };
}
