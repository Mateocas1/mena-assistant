import { describe, expect, it } from "vitest";
import { isToolAllowed, resolveProfile, toolPermissionsFor } from "../src/bot/allowlist.js";

const allowlist = { "111": "romi", "222": "mateo" } as const;

describe("allowlist and permission profiles", () => {
  it("resolves a profile from a numeric or string chat id", () => {
    expect(resolveProfile(allowlist, 111)).toBe("romi");
    expect(resolveProfile(allowlist, "222")).toBe("mateo");
    expect(resolveProfile(allowlist, -100123)).toBeUndefined();
    expect(resolveProfile(allowlist, "999")).toBeUndefined();
  });

  it("gives romi turnos, pagos and stock only", () => {
    expect(isToolAllowed("romi", "turnos.del_dia")).toBe(true);
    expect(isToolAllowed("romi", "turnos.cancelar")).toBe(true);
    expect(isToolAllowed("romi", "pagos.confirmar_transferencia")).toBe(true);
    expect(isToolAllowed("romi", "stock.actual")).toBe(true);
    expect(isToolAllowed("romi", "tareas.listar")).toBe(false);
  });

  it("gives mateo every tool", () => {
    expect(isToolAllowed("mateo", "tareas.listar")).toBe(true);
    expect(isToolAllowed("mateo", "tareas.crear")).toBe(true);
    expect(isToolAllowed("mateo", "turnos.del_dia")).toBe(true);
  });

  it("does not leak permissions through prefix collisions", () => {
    expect(isToolAllowed("romi", "turnos2.del_dia")).toBe(false);
    expect(isToolAllowed("romi", "pagosx.confirmar")).toBe(false);
  });

  it("exposes the patterns for a profile", () => {
    expect(toolPermissionsFor("romi")).toEqual(["turnos.*", "pagos.*", "stock.*"]);
    expect(toolPermissionsFor("mateo")).toEqual(["*"]);
  });
});
