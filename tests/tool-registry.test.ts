import { describe, expect, it } from "vitest";
import {
  createToolRegistry,
  createTareasTools,
  createTurnosTools,
} from "../src/mcp/tools/index.js";
import { ToolRegistry } from "../src/mcp/registry.js";

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
    expect(registry.forProfile("romi").map((tool) => tool.name)).toEqual([
      "turnos.del_dia",
      "turnos.disponibilidad",
      "turnos.servicios",
      "turnos.cancelar",
    ]);
    expect(registry.forProfile("mateo").map((tool) => tool.name)).toContain("tareas.listar");
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
