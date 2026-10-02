import { describe, expect, it } from "vitest";
import { TareasError } from "../src/adapters/tareas/client.js";
import { createToolRegistry, createTareasTools } from "../src/mcp/tools/index.js";
import { ToolArgumentError, isWriteTool, type ToolHandlerContext } from "../src/mcp/registry.js";
import { makeTareasTestContext, TEST_ART_DATE } from "./helpers/context.js";

const tools = createTareasTools({ enabled: true });
const byName = (name: string) => tools.find((tool) => tool.name === name)!;
const listar = byName("tareas.listar");
const agenda = byName("tareas.agenda");
const crear = (() => {
  const tool = byName("tareas.crear");
  if (!isWriteTool(tool)) throw new Error("tareas.crear must be a write tool");
  return tool;
})();
const completar = (() => {
  const tool = byName("tareas.completar");
  if (!isWriteTool(tool)) throw new Error("tareas.completar must be a write tool");
  return tool;
})();

describe("tareas permission profile", () => {
  it("registers nothing when the flag is off", () => {
    expect(createTareasTools({ enabled: false })).toEqual([]);
  });

  it("never shows tareas.* to romi and shows all four to mateo", () => {
    const registry = createToolRegistry({ turnos: true, stock: true, tareas: true });

    const romiTools = registry.forProfile("romi").map((tool) => tool.name);
    expect(romiTools.filter((name) => name.startsWith("tareas."))).toEqual([]);

    const mateoTools = registry.forProfile("mateo").map((tool) => tool.name);
    expect(mateoTools.filter((name) => name.startsWith("tareas."))).toEqual([
      "tareas.listar",
      "tareas.agenda",
      "tareas.crear",
      "tareas.completar",
    ]);
  });

  it("refuses to run for romi even if a handler is reached directly", async () => {
    const { context } = makeTareasTestContext("romi");
    const error = await listar.execute({}, context).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TareasError);
    expect((error as TareasError).userMessage).toContain("sólo para el chat de Mateo");
  });
});

describe("tareas read tools", () => {
  it("lists the planner tasks", async () => {
    const { context } = makeTareasTestContext();
    const result = await listar.execute({}, context);
    expect((result.data as { id: string }[]).map((task) => task.id)).toEqual([
      "task_dni",
      "task_alquiler",
      "task_filtros",
    ]);
  });

  it("shows the agenda for today in ART", async () => {
    const { context } = makeTareasTestContext();
    const result = await agenda.execute({}, context);
    const parsed = JSON.parse(result.content) as { date: string; blocks: unknown[] };

    expect(parsed.date).toBe(TEST_ART_DATE);
    expect(parsed.blocks).toHaveLength(1);
  });

  it("resolves a relative agenda date and rejects a nonsense one", async () => {
    const { context } = makeTareasTestContext();
    expect(
      (JSON.parse((await agenda.execute({ fecha: "mañana" }, context)).content) as { date: string })
        .date,
    ).toBe("2026-01-15");

    await expect(agenda.execute({ fecha: "la semana que viene" }, context)).rejects.toBeInstanceOf(
      ToolArgumentError,
    );
  });
});

describe("tareas write tools", () => {
  it("proposes a task with its deadline and only creates it on execute", async () => {
    const { context } = makeTareasTestContext();
    const result = await crear.execute(
      { titulo: "Sacar turno médico", fecha_limite: "2026-01-20" },
      context,
    );

    expect(result.proposal?.summary).toContain("Sacar turno médico");
    expect(result.proposal?.summary).toContain("2026-01-20");
    expect(result.proposal?.diff).toContain("+ Sacar turno médico · vence 2026-01-20");

    const before = (await listar.execute({}, context)).data as { title: string }[];
    expect(before.map((task) => task.title)).not.toContain("Sacar turno médico");

    await crear.executeProposal(result.proposal!.args, context);
    const after = (await listar.execute({}, context)).data as { title: string }[];
    expect(after.map((task) => task.title)).toContain("Sacar turno médico");
  });

  it("resolves a relative deadline phrase with the ART module", async () => {
    const { context } = makeTareasTestContext();
    const result = await crear.execute(
      { titulo: "Comprar regalo", fecha_limite: "el viernes" },
      context,
    );
    expect(result.proposal?.args).toMatchObject({ fecha_limite: "2026-01-16" });
  });

  it("rejects invalid task input before proposing", async () => {
    const { context, proposals } = makeTareasTestContext();
    const sentinel = proposals.create({
      chatId: context.chatId,
      profile: "mateo",
      tool: "sentinel",
      args: {},
      summary: "s",
      diff: "s",
    });

    await expect(crear.execute({ titulo: "   " }, context)).rejects.toBeInstanceOf(
      ToolArgumentError,
    );
    await expect(
      crear.execute({ titulo: "Con fecha rara", fecha_limite: "cuando pueda" }, context),
    ).rejects.toBeInstanceOf(ToolArgumentError);

    expect(proposals.get(sentinel.id)?.tool).toBe("sentinel");
  });

  it("proposes and writes an occurrence completion", async () => {
    const { context } = makeTareasTestContext();
    const result = await completar.execute({ occurrenceId: "serie_gym:2026-01-14" }, context);

    expect(result.proposal?.summary).toContain("serie_gym:2026-01-14");
    expect(result.proposal?.diff).toContain("+ serie_gym:2026-01-14 · hecha");

    const before = await agenda.execute({ fecha: TEST_ART_DATE }, context);
    expect(
      (before.data as { occurrences: { id: string; completed: boolean }[] }).occurrences.find(
        (occurrence) => occurrence.id === "serie_gym:2026-01-14",
      )?.completed,
    ).toBe(false);

    await completar.executeProposal(result.proposal!.args, context);

    const after = await agenda.execute({ fecha: TEST_ART_DATE }, context);
    expect(
      (after.data as { occurrences: { id: string; completed: boolean }[] }).occurrences.find(
        (occurrence) => occurrence.id === "serie_gym:2026-01-14",
      )?.completed,
    ).toBe(true);
  });

  it("rejects a malformed occurrence id before proposing", async () => {
    const { context } = makeTareasTestContext();
    await expect(
      completar.execute({ occurrenceId: "sin-separador" }, context),
    ).rejects.toBeInstanceOf(ToolArgumentError);
    await expect(
      completar.execute({ occurrenceId: "serie:no-es-fecha" }, context),
    ).rejects.toBeInstanceOf(ToolArgumentError);
  });

  it("reports a clear message when the backend is missing", async () => {
    const base = makeTareasTestContext();
    const context: ToolHandlerContext = { ...base.context };
    delete (context as { tareas?: unknown }).tareas;

    const error = await listar.execute({}, context).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TareasError);
    expect((error as TareasError).userMessage).toContain("desactivado");
  });
});
