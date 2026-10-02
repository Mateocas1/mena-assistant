import { describe, expect, it } from "vitest";
import { compareArgs } from "../evals/args.js";
import { fixedClock } from "../src/time/index.js";

// 2026-01-14 12:00 ART (Wednesday).
const CLOCK = fixedClock("2026-01-14T15:00:00Z");

describe("compareArgs: date rules (ART clock + documented default)", () => {
  it("treats an omitted `fecha` as today when the tool documents that default", () => {
    expect(compareArgs("turnos.del_dia", { fecha: "2026-01-14" }, {}, CLOCK)).toEqual({
      matched: true,
    });
    expect(compareArgs("turnos.disponibilidad", { fecha: "2026-01-14" }, {}, CLOCK).matched).toBe(
      true,
    );
    expect(compareArgs("turnos.resumen", { fecha: "2026-01-14" }, {}, CLOCK).matched).toBe(true);
  });

  it("accepts `hoy` and an explicit ISO date interchangeably", () => {
    expect(compareArgs("turnos.del_dia", { fecha: "2026-01-14" }, { fecha: "hoy" }, CLOCK)).toEqual(
      { matched: true },
    );
  });

  it("accepts relative and weekday phrases the tool itself resolves", () => {
    expect(
      compareArgs("turnos.del_dia", { fecha: "2026-01-15" }, { fecha: "mañana" }, CLOCK).matched,
    ).toBe(true);
    expect(
      compareArgs("turnos.del_dia", { fecha: "2026-01-15" }, { fecha: "el jueves" }, CLOCK).matched,
    ).toBe(true);
    expect(
      compareArgs("turnos.del_dia", { fecha: "2026-01-19" }, { fecha: "lunes" }, CLOCK).matched,
    ).toBe(true);
  });

  it("still fails when the day is genuinely different", () => {
    const comparison = compareArgs(
      "turnos.del_dia",
      { fecha: "2026-01-15" },
      { fecha: "2026-01-14" },
      CLOCK,
    );
    expect(comparison.matched).toBe(false);
    expect(comparison.mismatch).toMatchObject({
      key: "fecha",
      reason: "wrong_date",
      expected: "2026-01-15",
      actual: "2026-01-14",
    });
  });

  it("resolves a week phrase for either range end", () => {
    expect(
      compareArgs(
        "turnos.rango",
        { desde: "2026-01-12", hasta: "2026-01-18" },
        { desde: "esta semana" },
        CLOCK,
      ).matched,
    ).toBe(true);
    expect(
      compareArgs(
        "turnos.rango",
        { desde: "2026-01-19", hasta: "2026-01-25" },
        { desde: "la semana que viene" },
        CLOCK,
      ).matched,
    ).toBe(true);
  });

  it("defaults an omitted `hasta` to `desde`", () => {
    expect(
      compareArgs(
        "turnos.rango",
        { desde: "2026-01-20", hasta: "2026-01-20" },
        { desde: "2026-01-20" },
        CLOCK,
      ).matched,
    ).toBe(true);
  });

  it("does not equate a wrong range", () => {
    const comparison = compareArgs(
      "turnos.rango",
      { desde: "2026-01-12", hasta: "2026-01-18" },
      { desde: "2026-01-13", hasta: "2026-01-19" },
      CLOCK,
    );
    expect(comparison.matched).toBe(false);
    expect(comparison.mismatch?.reason).toBe("wrong_date");
  });
});

describe("compareArgs: optional args equal to their documented default", () => {
  it("does not require an optional key the case omits", () => {
    expect(
      compareArgs("turnos.bloquear", { fecha: "2026-01-21" }, { fecha: "2026-01-21" }, CLOCK),
    ).toMatchObject({ matched: true });
  });

  it("accepts the documented default value of `limit` explicitly", () => {
    expect(
      compareArgs("stock.servicios_recientes", { limit: 10 }, { limit: 10 }, CLOCK).matched,
    ).toBe(true);
    expect(compareArgs("stock.servicios_recientes", { limit: 10 }, {}, CLOCK).matched).toBe(true);
  });

  it("fails a non-default `limit` that was omitted", () => {
    const comparison = compareArgs("stock.servicios_recientes", { limit: 5 }, {}, CLOCK);
    expect(comparison.matched).toBe(false);
    expect(comparison.mismatch).toMatchObject({ key: "limit", reason: "missing_arg" });
  });

  it("treats an explicit false as the documented default for booleans", () => {
    expect(
      compareArgs("stock.catalogo", { solo_colores: true }, { solo_colores: true }, CLOCK).matched,
    ).toBe(true);
    expect(compareArgs("stock.catalogo", {}, { solo_colores: false }, CLOCK).matched).toBe(true);
  });
});

describe("compareArgs: text and numeric rules", () => {
  it("compares names and reasons case/accent/whitespace-insensitively", () => {
    expect(
      compareArgs(
        "turnos.crear_para_clienta",
        { cliente: "Ana Gómez" },
        { cliente: "ana  gomez" },
        CLOCK,
      ).matched,
    ).toBe(true);
    expect(
      compareArgs(
        "turnos.bloquear",
        { motivo: "voy al médico" },
        { motivo: "Voy al medico" },
        CLOCK,
      ).matched,
    ).toBe(true);
  });

  it("compares numeric ids as numbers, including inside arrays", () => {
    expect(
      compareArgs("stock.registrar_servicio", { colorItemId: 1 }, { colorItemId: "1" }, CLOCK)
        .matched,
    ).toBe(true);
    expect(
      compareArgs(
        "stock.registrar_servicio",
        { tips: [{ itemId: 10, units: 10 }] },
        { tips: [{ itemId: "10", units: "10" }] },
        CLOCK,
      ).matched,
    ).toBe(true);
  });

  it("does not equate different ids or values", () => {
    const idComparison = compareArgs(
      "turnos.cancelar",
      { appointmentId: "apt_today_1400" },
      { appointmentId: "apt_today_0800" },
      CLOCK,
    );
    expect(idComparison.matched).toBe(false);
    expect(idComparison.mismatch).toMatchObject({ key: "appointmentId", reason: "wrong_value" });

    const tipComparison = compareArgs(
      "stock.registrar_servicio",
      { tips: [{ itemId: 10, units: 10 }] },
      { tips: [{ itemId: 11, units: 10 }] },
      CLOCK,
    );
    expect(tipComparison.matched).toBe(false);
  });

  it("fails a missing required argument with `missing_arg`", () => {
    const comparison = compareArgs(
      "turnos.marcar_completado",
      { appointmentId: "apt_past_0800" },
      {},
      CLOCK,
    );
    expect(comparison.matched).toBe(false);
    expect(comparison.mismatch).toMatchObject({ key: "appointmentId", reason: "missing_arg" });
  });

  it("treats an empty expectation as always satisfied", () => {
    expect(compareArgs("turnos.servicios", {}, { anything: 1 }, CLOCK).matched).toBe(true);
    expect(compareArgs("turnos.servicios", {}, undefined, CLOCK).matched).toBe(true);
  });
});
