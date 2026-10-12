import { describe, expect, it } from "vitest";
import { StockError, StockForbiddenError, StockHttpError } from "../src/adapters/stock/client.js";
import { translateStockError } from "../src/mcp/tools/stock-errors.js";
import { MockStockBackend } from "../src/adapters/stock/mock.js";
import { STOCK_ADVISORY_DISCLAIMER, createStockTools } from "../src/mcp/tools/stock.js";
import { createToolRegistry } from "../src/mcp/tools/index.js";
import { ToolArgumentError, isWriteTool, type ToolHandlerContext } from "../src/mcp/registry.js";
import { makeStockTestContext } from "./helpers/context.js";

const tools = createStockTools({ enabled: true });
const byName = (name: string) => tools.find((tool) => tool.name === name)!;

const actual = byName("stock.actual");
const alertas = byName("stock.alertas");
const recientes = byName("stock.servicios_recientes");
const precios = byName("stock.precios");
const catalogo = byName("stock.catalogo");
const advisory = byName("stock.proponer_correccion");
const registrar = (() => {
  const tool = byName("stock.registrar_servicio");
  if (!isWriteTool(tool)) throw new Error("registrar_servicio must be a write tool");
  return tool;
})();

describe("stock tools registration", () => {
  it("registers nothing when the flag is off", () => {
    expect(createStockTools({ enabled: false })).toEqual([]);
  });

  it("never exposes a forbidden roadmap operation for any profile", () => {
    const registry = createToolRegistry({ turnos: true, stock: true, tareas: true });
    const forbidden =
      /stocktake|recuento|cambiar_precio|set_precio|ajustar|precio_nuevo|confirmar_recuento/;

    for (const profile of ["romi", "mateo"] as const) {
      const names = registry.forProfile(profile).map((tool) => tool.name);
      expect(names.length).toBeGreaterThan(0);
      expect(names.filter((name) => forbidden.test(name))).toEqual([]);
    }
  });
});

describe("stock read tools", () => {
  it("lists the confirmed stock with its alert state", async () => {
    const { context } = makeStockTestContext();
    const result = await actual.execute({}, context);
    expect(result.data).toHaveLength(7);
    expect(JSON.parse(result.content)).toMatchObject({ items: expect.any(Array) });
  });

  it("lists only low items", async () => {
    const { context } = makeStockTestContext();
    const result = await alertas.execute({}, context);
    expect(JSON.parse(result.content)).toMatchObject({ cantidad: 2 });
  });

  it("lists recent services and prices", async () => {
    const { context } = makeStockTestContext();
    expect(await recientes.execute({ limit: 1 }, context)).toMatchObject({
      data: expect.arrayContaining([expect.objectContaining({ id: 99 })]),
    });
    expect((await precios.execute({}, context)).data).toHaveLength(3);
  });

  it("filters the catalog to colours when asked", async () => {
    const { context } = makeStockTestContext();
    const all = await catalogo.execute({}, context);
    const colours = await catalogo.execute({ solo_colores: true }, context);

    expect(all.data).toHaveLength(7);
    expect((colours.data as { id: number }[]).map((item) => item.id)).toEqual([1, 2]);
  });
});

describe("stock.registrar_servicio", () => {
  it("proposes and never writes before the callback", async () => {
    const { context, stock } = makeStockTestContext();
    const result = await registrar.execute(
      {
        servicio: "soft_gel",
        colorItemId: 1,
        tips: [{ itemId: 10, units: 10 }],
        sourceAppointmentId: "apt_today_0800",
      },
      context,
    );

    expect(result.proposal?.tool).toBe("stock.registrar_servicio");
    expect(result.proposal?.summary).toBe("Registrar el Soft Gel de Ana G. (hoy 08:00)");
    expect(result.proposal?.diff).toBe("Se descuenta:\n• City 22\n• 10 Tips almond 5");
    expect((await stock.actual()).find((entry) => entry.itemId === 1)?.units).toBe(6);
  });

  it("accepts tips of several sizes and shows each one in the proposal", async () => {
    const { context, stock } = makeStockTestContext();
    const result = await registrar.execute(
      {
        servicio: "soft_gel",
        colorItemId: 1,
        tips: [
          { itemId: 10, units: 4 },
          { itemId: 11, units: 6 },
        ],
      },
      context,
    );

    expect(result.proposal?.summary).toBe("Registrar el Soft Gel");
    expect(result.proposal?.diff).toBe(
      "Se descuenta:\n• City 22\n• 4 Tips almond 5\n• 6 Tips almond 6",
    );
    expect((await stock.actual()).find((entry) => entry.itemId === 10)?.units).toBe(100);
    expect((await stock.actual()).find((entry) => entry.itemId === 11)?.units).toBe(15);
  });

  it("never shows Romi an id or an internal service key", async () => {
    const { context } = makeStockTestContext();
    const result = await registrar.execute(
      {
        servicio: "soft_gel",
        colorItemId: 1,
        tips: [{ itemId: 10, units: 10 }],
        sourceAppointmentId: "apt_past_0800",
      },
      context,
    );
    const visible = `${result.proposal?.summary}\n${result.proposal?.diff}`;

    expect(visible).toContain("Paula V.");
    expect(visible).not.toMatch(/apt_|soft_gel|item \d|\(id/);
  });

  it("returns a compact catalog to the model", async () => {
    const { context } = makeStockTestContext();
    const result = await catalogo.execute({}, context);
    const items = (JSON.parse(result.content) as { items: Record<string, unknown>[] }).items;

    expect(items.find((item) => item.id === 10)).toEqual({
      id: 10,
      nombre: "Tips almond 5",
      forma: "almond",
      talle: 5,
    });
    expect(items.find((item) => item.id === 1)).toEqual({ id: 1, nombre: "City 22", color: true });
  });

  it("tells the model that one service can mix tip sizes", () => {
    expect(registrar.description).not.toMatch(/una forma y un talle/);
    expect(registrar.description).toMatch(/distintos talles/);
    expect(registrar.description).not.toMatch(/pulgar|meñique/);
  });

  it("rejects a wrong tip count before creating a proposal", async () => {
    const { context, proposals } = makeStockTestContext();
    const before = proposals.create({
      chatId: context.chatId,
      profile: "romi",
      tool: "sentinel",
      args: {},
      summary: "s",
      diff: "s",
    });

    await expect(
      registrar.execute(
        { servicio: "soft_gel", colorItemId: 1, tips: [{ itemId: 10, units: 9 }] },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolArgumentError);

    await expect(
      registrar.execute(
        { servicio: "capping", colorItemId: 1, tips: [{ itemId: 10, units: 10 }] },
        context,
      ),
    ).rejects.toBeInstanceOf(ToolArgumentError);

    expect(proposals.get(before.id)?.tool).toBe("sentinel");
  });

  it("registers on execute and replays an identical retry", async () => {
    const { context, stock } = makeStockTestContext();
    const args = {
      servicio: "soft_gel" as const,
      colorItemId: 1,
      tips: [{ itemId: 10, units: 10 }],
      sourceAppointmentId: "apt_today_0800",
    };

    const first = await registrar.executeProposal(args, context);
    expect(JSON.parse(first.content)).toMatchObject({ registered: true, replayed: false });
    expect((await stock.actual()).find((entry) => entry.itemId === 10)?.units).toBe(90);

    const before = await stock.actual();
    const second = await registrar.executeProposal(args, context);
    expect(JSON.parse(second.content)).toMatchObject({ replayed: true });
    expect(JSON.parse(second.content).message).toContain("ya estaba registrado");
    expect(await stock.actual()).toEqual(before);
  });

  it("maps a conflict to clear copy", async () => {
    const { context } = makeStockTestContext();
    await registrar.executeProposal(
      { servicio: "semipermanente", colorItemId: 1, sourceAppointmentId: "apt_x" },
      context,
    );

    const error = await registrar
      .executeProposal(
        { servicio: "capping", colorItemId: 2, sourceAppointmentId: "apt_x" },
        context,
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StockError);
    expect((error as StockError).userMessage).toContain("ya tenía un servicio registrado");
  });

  it("still proposes when the catalog route is forbidden", async () => {
    const base = makeStockTestContext();
    const forbiddenCatalog = new MockStockBackend();
    forbiddenCatalog.catalogo = async () => {
      throw new StockForbiddenError("/catalog/items");
    };
    const context: ToolHandlerContext = { ...base.context, stock: forbiddenCatalog };

    const result = await registrar.execute({ servicio: "capping", colorItemId: 1 }, context);
    expect(result.proposal?.summary).toBe("Registrar el Capping");
    expect(result.proposal?.diff).toBe("Se descuenta:\n• el color elegido");
  });
});

describe("stock.proponer_correccion", () => {
  it("is advisory text only: no proposal and no backend call", async () => {
    const base = makeStockTestContext();
    let stockCalls = 0;
    const stock = new MockStockBackend();
    const originalActual = stock.actual.bind(stock);
    stock.actual = async () => {
      stockCalls += 1;
      return await originalActual();
    };
    const context: ToolHandlerContext = { ...base.context, stock };
    const proposalsBefore = base.proposals.create({
      chatId: context.chatId,
      profile: "romi",
      tool: "sentinel",
      args: {},
      summary: "s",
      diff: "s",
    });

    const result = await advisory.execute(
      { tema: "recuento de tips", detalle: "Tips almond 6 quedó en 15 unidades" },
      context,
    );

    const parsed = JSON.parse(result.content) as { advisory: boolean; recomendacion: string };
    expect(parsed.advisory).toBe(true);
    expect(parsed.recomendacion).toContain("Tips almond 6");
    expect(parsed.recomendacion).toContain(STOCK_ADVISORY_DISCLAIMER);
    expect(result.proposal).toBeUndefined();
    expect(stockCalls).toBe(0);
    expect(base.proposals.get(proposalsBefore.id)?.tool).toBe("sentinel");
  });
});

describe("stock error copy", () => {
  it("does not tell Romi that Soft Gel takes a single tip size", () => {
    const error = translateStockError(
      new StockHttpError(400, "Soft Gel requires exactly ten allocated tips"),
      "fallback",
    );

    expect(error.userMessage).toBe(
      "Soft Gel necesita exactamente 10 tips en total (pueden ser de distintos talles).",
    );
  });
});
