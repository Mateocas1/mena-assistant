import { describe, expect, it } from "vitest";
import { createStoreTareasBackend } from "../src/adapters/tareas/backend.js";
import { TareasError } from "../src/adapters/tareas/client.js";
import { createFirestoreTareasStore } from "../src/adapters/tareas/firestore.js";
import {
  MAX_OCCURRENCE_WINDOW_DAYS,
  createOccurrenceCompletion,
  createTask,
  createWorkBlock,
  expandOccurrences,
  occurrenceId,
} from "../src/adapters/tareas/model.js";
import { fixedClock } from "../src/time/index.js";
import { seededTareasStore } from "./helpers/context.js";

const CLOCK = fixedClock("2026-01-15T01:30:00Z"); // 2026-01-14 22:30 ART

describe("copied calendar domain rules", () => {
  it("validates tasks like the calendar app does", () => {
    expect(createTask("id", "  Pagar el alquiler  ")).toEqual({
      id: "id",
      title: "Pagar el alquiler",
    });
    expect(createTask("id", "Con fecha", "2026-01-20")).toMatchObject({ deadline: "2026-01-20" });
    expect(() => createTask("id", "   ")).toThrow(/title is required/);
    expect(() => createTask("id", "x", "2026-1-2")).toThrow(/ISO date-only/);
    expect(() => createTask("id", "x", "2026-02-30")).toThrow(/ISO date-only/);
  });

  it("validates work blocks", () => {
    expect(
      createWorkBlock("b", "2026-01-14T10:00:00-03:00", "2026-01-14T11:00:00-03:00"),
    ).toMatchObject({ start: "2026-01-14T10:00:00-03:00" });
    expect(() =>
      createWorkBlock("b", "2026-01-14T11:00:00-03:00", "2026-01-14T10:00:00-03:00"),
    ).toThrow(/positive/);
    expect(() => createWorkBlock("b", "2026-01-14 10:00", "2026-01-14 11:00")).toThrow(/zoned/);
  });

  it("expands daily, weekly and monthly series", () => {
    expect(
      expandOccurrences(
        { seriesId: "s", frequency: "daily", anchorDate: "2026-01-01" },
        "2026-01-14",
        "2026-01-16",
      ).map((occurrence) => occurrence.date),
    ).toEqual(["2026-01-14", "2026-01-15", "2026-01-16"]);

    expect(
      expandOccurrences(
        { seriesId: "s", frequency: "weekly", anchorDate: "2026-01-07" },
        "2026-01-10",
        "2026-01-21",
      ).map((occurrence) => occurrence.date),
    ).toEqual(["2026-01-14", "2026-01-21"]);

    // The 31st only exists in some months.
    expect(
      expandOccurrences(
        { seriesId: "s", frequency: "monthly", anchorDate: "2026-01-31" },
        "2026-02-01",
        "2026-04-30",
      ).map((occurrence) => occurrence.date),
    ).toEqual(["2026-03-31"]);

    expect(() =>
      expandOccurrences(
        { seriesId: "s", frequency: "daily", anchorDate: "2026-01-01" },
        "2026-01-01",
        "2027-06-01",
      ),
    ).toThrow(/window/);
    expect(MAX_OCCURRENCE_WINDOW_DAYS).toBe(366);
  });

  it("builds occurrence ids and completions", () => {
    expect(occurrenceId("serie_gym", "2026-01-14")).toBe("serie_gym:2026-01-14");
    expect(() => occurrenceId("serie:rara", "2026-01-14")).toThrow(/series ID/);
    expect(createOccurrenceCompletion("serie_gym:2026-01-14", "2026-01-14T23:00:00Z")).toEqual({
      occurrenceId: "serie_gym:2026-01-14",
      completedAt: "2026-01-14T23:00:00Z",
    });
    expect(() => createOccurrenceCompletion("sin-separador", "2026-01-14T23:00:00Z")).toThrow(
      /occurrence ID/,
    );
  });
});

describe("store-backed tareas backend", () => {
  const backend = () => createStoreTareasBackend(seededTareasStore(), { clock: CLOCK });

  it("lists tasks ordered by deadline", async () => {
    const tasks = await backend().listar();
    expect(tasks.map((task) => task.id)).toEqual(["task_dni", "task_alquiler", "task_filtros"]);
  });

  it("builds the agenda of one ART day", async () => {
    const agenda = await backend().agenda("2026-01-14");

    expect(agenda.blocks.map((block) => block.id)).toEqual(["blk_manana"]);
    expect(agenda.occurrences.map((occurrence) => occurrence.id)).toEqual([
      "serie_gym:2026-01-14",
      "serie_agua:2026-01-14",
    ]);
    const gym = agenda.occurrences.find((occurrence) => occurrence.seriesId === "serie_gym");
    expect(gym).toMatchObject({ title: "Gym", completed: false });
    // Only tasks due on or before the day, and still open.
    expect(agenda.tasks.map((task) => task.id)).toEqual(["task_dni"]);
  });

  it("marks the previous gym occurrence as completed", async () => {
    const agenda = await backend().agenda("2026-01-07");
    expect(
      agenda.occurrences.find((occurrence) => occurrence.seriesId === "serie_gym"),
    ).toMatchObject({ completed: true });
  });

  it("rejects an invalid agenda date", async () => {
    await expect(backend().agenda("14/01/2026")).rejects.toBeInstanceOf(TareasError);
  });

  it("creates a task and completes an occurrence idempotently", async () => {
    const store = seededTareasStore();
    const withStore = createStoreTareasBackend(store, { clock: CLOCK });

    const created = await withStore.crear({ title: "Sacar turno médico", deadline: "2026-01-20" });
    expect(created).toMatchObject({ title: "Sacar turno médico", deadline: "2026-01-20" });
    expect((await withStore.listar()).map((task) => task.title)).toContain("Sacar turno médico");

    await expect(withStore.crear({ title: "   " })).rejects.toBeInstanceOf(TareasError);

    await withStore.completar({ occurrenceId: "serie_gym:2026-01-14" });
    await withStore.completar({ occurrenceId: "serie_gym:2026-01-14" });
    const completions = await store.list("completions");
    expect(completions.filter((record) => record.id === "serie_gym:2026-01-14")).toHaveLength(1);

    await expect(withStore.completar({ occurrenceId: "nope" })).rejects.toBeInstanceOf(TareasError);
  });
});

describe("Firestore store confinement", () => {
  it("only ever builds users/{uid} paths", async () => {
    const paths: string[] = [];
    const store = await createFirestoreTareasStore({
      uid: "mateo-uid",
      app: {
        listDocuments: async (path) => {
          paths.push(`list:${path}`);
          return [{ id: "task_1", data: { title: "Pagar" } }];
        },
        setDocument: async (path) => {
          paths.push(`set:${path}`);
        },
      },
    });

    expect((await store.list("tasks"))[0]?.id).toBe("task_1");
    await store.set("completions", "serie:2026-01-14", { completedAt: "x" });

    expect(paths).toEqual([
      "list:users/mateo-uid/tasks",
      "set:users/mateo-uid/completions/serie:2026-01-14",
    ]);
  });

  it("refuses a document id that could escape the subtree", async () => {
    const store = await createFirestoreTareasStore({
      uid: "mateo-uid",
      app: { listDocuments: async () => [], setDocument: async () => {} },
    });
    await expect(store.set("tasks", "../otro", {})).rejects.toBeInstanceOf(TareasError);
  });

  it("requires the uid", async () => {
    await expect(createFirestoreTareasStore({ uid: "" })).rejects.toBeInstanceOf(TareasError);
  });
});

describe("lazy firestore backend wrapper", () => {
  it("resolves the Firestore store lazily through the injected app port", async () => {
    const { createTareasBackend } = await import("../src/adapters/tareas/index.js");
    const { parseConfig } = await import("../src/config.js");

    const config = parseConfig({
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_ALLOWLIST: "111:romi,222:mateo",
      LLM_API_KEY: "sk",
      TAREAS_BACKEND: "firestore",
      MATEO_FIREBASE_UID: "mateo-uid",
    });

    const paths: string[] = [];
    const backend = createTareasBackend(config, {
      clock: CLOCK,
      firestoreApp: {
        listDocuments: async (path) => {
          paths.push(path);
          return [{ id: "task_1", data: { title: "Pagar" } }];
        },
        setDocument: async (path) => {
          paths.push(path);
        },
      },
    });

    // Building the backend touched nothing; the store resolves on first use and
    // only under users/{uid}.
    expect(paths).toEqual([]);
    expect((await backend.listar())[0]?.title).toBe("Pagar");
    expect(paths).toEqual(["users/mateo-uid/tasks"]);

    await backend.crear({ title: "Nueva tarea" });
    expect(paths[1]?.startsWith("users/mateo-uid/tasks/")).toBe(true);
  });
});
