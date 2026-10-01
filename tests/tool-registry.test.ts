import { describe, expect, it } from "vitest";
import {
  createToolRegistry,
  createTareasTools,
  createTurnosTools,
} from "../src/mcp/tools/index.js";
import { ToolRegistry, serializeTools } from "../src/mcp/registry.js";
import { fixedClock } from "../src/time/index.js";

const ROMI_TOOL_NAMES = [
  "turnos.del_dia",
  "turnos.rango",
  "turnos.disponibilidad",
  "turnos.servicios",
  "turnos.pagos_pendientes",
  "turnos.resumen",
  "turnos.marcar_completado",
  "turnos.cancelar",
  "turnos.bloquear",
  "turnos.desbloquear",
  "turnos.crear_para_clienta",
  "turnos.reprogramar",
  "pagos.confirmar_transferencia",
  "pagos.rechazar_transferencia",
];

describe("ToolRegistry", () => {
  it("never shows tareas.* to romi", () => {
    const registry = new ToolRegistry([
      ...createTurnosTools(),
      ...createTareasTools({ enabled: true }),
    ]);

    const romiTools = registry.forProfile("romi").map((tool) => tool.name);
    expect(romiTools).toContain("turnos.del_dia");
    expect(romiTools).not.toContain("tareas.listar");

    const mateoTools = registry.forProfile("mateo").map((tool) => tool.name);
    expect(mateoTools).toContain("tareas.listar");
  });

  it("serialises tools for the LLM as OpenAI function specs", () => {
    const registry = createToolRegistry({ turnos: true, stock: false, tareas: false });
    const specs = registry.toOpenAiTools("romi");

    const delDia = specs.find((spec) => spec.function.name === "turnos.del_dia");
    expect(delDia).toBeDefined();
    expect(delDia?.type).toBe("function");
    expect(delDia?.function.description).toContain("turnos");
    expect(delDia?.function.parameters).toMatchObject({ type: "object" });
  });

  it("registers no tools for disabled adapters", () => {
    const registry = createToolRegistry({ turnos: false, stock: false, tareas: false });
    expect(registry.list()).toHaveLength(0);
  });

  it("registers the enabled adapters and filters them by profile", () => {
    const registry = createToolRegistry({ turnos: true, stock: false, tareas: true });
    expect(registry.forProfile("romi").map((tool) => tool.name)).toEqual(ROMI_TOOL_NAMES);
    expect(registry.forProfile("mateo").map((tool) => tool.name)).toContain("tareas.listar");
  });

  it("appends fresh ART date anchors to the date tools only", () => {
    const registry = createToolRegistry({ turnos: true, stock: false, tareas: false });
    const clock = fixedClock("2026-01-15T01:30:00Z"); // 2026-01-14 22:30 ART
    const specs = registry.toOpenAiTools("romi", clock);

    const descriptionOf = (name: string) =>
      specs.find((spec) => spec.function.name === name)?.function.description ?? "";

    expect(descriptionOf("turnos.del_dia")).toContain("hoy=2026-01-14");
    expect(descriptionOf("turnos.del_dia")).toContain("mañana=2026-01-15");
    expect(descriptionOf("turnos.rango")).toContain("esta semana=2026-01-12..2026-01-18");
    expect(descriptionOf("turnos.resumen")).toContain("hoy=2026-01-14");
    expect(descriptionOf("turnos.servicios")).not.toContain("Anclas de fecha");
  });

  it("serialises the same tools with the default clock when none is given", () => {
    const registry = createToolRegistry({ turnos: true, stock: false, tareas: false });
    const tools = registry.forProfile("romi");
    expect(serializeTools(tools)).toHaveLength(tools.length);
  });

  it("rejects duplicate tool names", () => {
    const [first] = createTurnosTools();
    expect(first).toBeDefined();
    expect(() => new ToolRegistry([first!, first!])).toThrow(/duplicate/i);
  });

  it("returns undefined for an unknown tool", () => {
    const registry = createToolRegistry({ turnos: true, stock: false, tareas: false });
    expect(registry.get("nope.nope")).toBeUndefined();
    expect(registry.get("turnos.cancelar")?.kind).toBe("write");
  });
});
