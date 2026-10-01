import { describe, expect, it } from "vitest";
import {
  TurnosAuthError,
  TurnosError,
  TurnosHttpError,
  TurnosNotConfiguredError,
  TurnosNotFoundError,
} from "../src/adapters/turnos/client.js";
import { translateTurnosError } from "../src/mcp/tools/turnos-errors.js";

const FALLBACK = "No pude completar la acción.";

describe("translateTurnosError", () => {
  it("translates known domain messages into clear Spanish", () => {
    const cases: Array<[unknown, string]> = [
      [new TurnosError("Appointment not found"), "No encontré ese turno."],
      [
        new TurnosError("Only confirmed appointments can be completed"),
        "Solo puedo marcar como completado un turno confirmado.",
      ],
      [
        new TurnosError("The appointment date has not arrived yet"),
        "Todavía no llegó la fecha de ese turno.",
      ],
      [
        new TurnosHttpError(500, "Este horario ya está ocupado. Por favor seleccioná otro."),
        "Ese horario ya está ocupado. Elegí otro.",
      ],
      [new TurnosError("Invalid time slot."), "Ese horario no es válido."],
      [new TurnosNotFoundError("blk_9"), "No encontré ese turno."],
    ];

    for (const [error, expected] of cases) {
      expect(translateTurnosError(error, FALLBACK).userMessage).toBe(expected);
    }
  });

  it("falls back for an unknown 4xx and names the status for an unknown 5xx", () => {
    const bad400 = translateTurnosError(new TurnosHttpError(400, "date is required"), FALLBACK);
    expect(bad400.userMessage).toBe(FALLBACK);

    const bad500 = translateTurnosError(new TurnosHttpError(500, "kaboom"), FALLBACK);
    expect(bad500.userMessage).toContain("El sistema de turnos falló (500)");
  });

  it("passes auth and not-configured copy through untouched", () => {
    const auth = new TurnosAuthError();
    expect(translateTurnosError(auth, FALLBACK)).toBe(auth);

    const notConfigured = new TurnosNotConfiguredError();
    expect(translateTurnosError(notConfigured, FALLBACK)).toBe(notConfigured);
  });

  it("wraps a non-Error failure with the fallback", () => {
    const translated = translateTurnosError("boom", FALLBACK);
    expect(translated).toBeInstanceOf(TurnosError);
    expect(translated.userMessage).toBe(FALLBACK);
  });
});
