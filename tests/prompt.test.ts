import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/llm/prompt.js";
import { fixedClock } from "../src/time/index.js";

const CLOCK = fixedClock("2026-01-14T15:00:00Z"); // Wednesday 12:00 ART

describe("buildSystemPrompt", () => {
  it("pins every resolved ART anchor the tools accept relative to the clock", () => {
    const prompt = buildSystemPrompt(CLOCK);
    expect(prompt).toContain("Hoy es 2026-01-14");
    expect(prompt).toContain("mañana es 2026-01-15");
    expect(prompt).toContain("pasado mañana es 2026-01-16");
    expect(prompt).toContain("ayer fue 2026-01-13");
    expect(prompt).toContain("2026-01-12");
    expect(prompt).toContain("2026-01-18");
    expect(prompt).toContain("America/Argentina/Buenos_Aires");
  });

  it("tells the model to call the write tool directly and to admit a missing tool", () => {
    const prompt = buildSystemPrompt(CLOCK);
    expect(prompt).toContain("herramienta de escritura");
    expect(prompt).toMatch(/no llames a otra herramienta/);
  });

  it("asks for the tips as several sizes adding up to ten", () => {
    const prompt = buildSystemPrompt(CLOCK, { stockEnabled: true });
    expect(prompt).not.toContain("forma y talle, 10 en total");
    expect(prompt).toMatch(/distintos talles/);
  });

  it("asks for every missing detail at once and never twice", () => {
    const prompt = buildSystemPrompt(CLOCK);
    expect(prompt).toContain("pedilos todos juntos en un solo mensaje");
    expect(prompt).toContain("No vuelvas a pedir un dato que Romi ya te dio");
  });

  it("only asks for the time when the client has more than one appointment that day", () => {
    const prompt = buildSystemPrompt(CLOCK);
    expect(prompt).toContain(
      "Si esa clienta tiene un solo turno ese día, usalo sin preguntar la hora",
    );
  });

  it("asks the model to batch its reads", () => {
    const prompt = buildSystemPrompt(CLOCK);
    expect(prompt).toContain("cada herramienta de lectura una sola vez por mensaje");
  });

  it("asks for the shape of the tips along with their sizes", () => {
    const prompt = buildSystemPrompt(CLOCK, { stockEnabled: true });
    expect(prompt).toContain("la forma y los talles");
  });

  it("talks like a close Rioplatense friend, without markdown or ids", () => {
    const prompt = buildSystemPrompt(CLOCK);
    expect(prompt).toContain("rioplatense");
    expect(prompt).toContain("voseo");
    expect(prompt).toContain("Sin markdown");
    expect(prompt).toContain("Nunca muestres ids");
    expect(prompt).toContain("No le expliques a Romi cosas del oficio");
  });

  it("keeps the stock chain rules behind the stock flag", () => {
    expect(buildSystemPrompt(CLOCK)).not.toContain("stock.registrar_servicio");
    expect(buildSystemPrompt(CLOCK, { stockEnabled: true })).toContain("stock.registrar_servicio");
  });
});
