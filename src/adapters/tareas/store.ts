/**
 * Narrow storage port for the calendar data. Every implementation is confined to
 * one user's subtree: the Firestore one builds `users/{uid}/<collection>` and
 * never accepts a path, so a tool cannot escape Mateo's own data.
 */
export type TareasCollection = "tasks" | "series" | "completions" | "blocks";

export interface TareasRecord {
  readonly id: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface TareasStore {
  list(collection: TareasCollection): Promise<TareasRecord[]>;
  set(
    collection: TareasCollection,
    id: string,
    data: Readonly<Record<string, unknown>>,
  ): Promise<void>;
}

export interface MockTareasSeed {
  readonly tasks?: readonly TareasRecord[];
  readonly series?: readonly TareasRecord[];
  readonly completions?: readonly TareasRecord[];
  readonly blocks?: readonly TareasRecord[];
}

/** In-memory store used by the mock backend and the tests. */
export class MockTareasStore implements TareasStore {
  private readonly collections = new Map<TareasCollection, Map<string, TareasRecord>>();

  constructor(seed: MockTareasSeed = {}) {
    for (const collection of ["tasks", "series", "completions", "blocks"] as const) {
      const map = new Map<string, TareasRecord>();
      for (const record of seed[collection] ?? []) map.set(record.id, record);
      this.collections.set(collection, map);
    }
  }

  async list(collection: TareasCollection): Promise<TareasRecord[]> {
    return [...(this.collections.get(collection)?.values() ?? [])].map((record) => ({
      id: record.id,
      data: { ...record.data },
    }));
  }

  async set(
    collection: TareasCollection,
    id: string,
    data: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    this.collections.get(collection)?.set(id, { id, data: { ...data } });
  }
}
