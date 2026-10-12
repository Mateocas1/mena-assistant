import { StockError, StockHttpError } from "../../adapters/stock/client.js";

/** mena-nails answers with sanitized plain text, so mapping is by message. */
const TRANSLATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /the selected color is invalid/i,
    "Ese color no sirve para el servicio: elegí uno del catálogo de colores.",
  ],
  [
    /exactly ten allocated tips|ten tips/i,
    "Soft Gel necesita exactamente 10 tips en total (pueden ser de distintos talles).",
  ],
  [/tip allocations require soft gel/i, "Ese servicio no usa tips."],
  [/invalid tip allocation|invalid tip/i, "La asignación de tips no es válida."],
  [/unsupported service key/i, "Ese servicio no existe en mena-nails."],
  [/already has a service log/i, "Ese turno ya tiene un servicio registrado con otros datos."],
  [/unauthorized/i, "El asistente no pudo autenticarse con el sistema de stock."],
  [/forbidden/i, "La credencial del asistente no tiene permiso para esta operación de stock."],
];

function translateMessage(message: string): string | undefined {
  for (const [pattern, copy] of TRANSLATIONS) {
    if (pattern.test(message)) return copy;
  }
  return undefined;
}

/**
 * Wraps a stock failure so the callback handler can show clear Spanish. Errors
 * that already carry user-facing copy (auth, forbidden, conflict, 5xx) pass
 * through untouched.
 */
export function translateStockError(error: unknown, fallback: string): StockError {
  if (error instanceof StockError && error.userMessage !== undefined) return error;

  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof StockHttpError && error.status >= 500) {
    return new StockError(message, {
      userMessage: `El sistema de stock falló (${error.status}). Probá de nuevo en un momento.`,
      cause: error,
    });
  }

  return new StockError(message, {
    userMessage: translateMessage(message) ?? fallback,
    cause: error,
  });
}
