import type { AppConfig } from "../../config.js";
import { systemClock, type Clock } from "../../time/index.js";
import { createStoreTareasBackend } from "./backend.js";
import type { TareasBackend } from "./client.js";
import { createFirestoreTareasStore } from "./firestore.js";
import { MockTareasStore, type MockTareasSeed } from "./store.js";

export * from "./client.js";
export * from "./model.js";
export * from "./store.js";
export { createStoreTareasBackend } from "./backend.js";
export { createFirestoreTareasStore, type FirestoreAppLike } from "./firestore.js";

export interface CreateTareasBackendOptions {
  readonly clock?: Clock;
  readonly firestoreApp?: import("./firestore.js").FirestoreAppLike;
  readonly seed?: MockTareasSeed;
}

/**
 * Builds the calendar backend selected by `TAREAS_BACKEND`. `firestore` builds a
 * backend whose store loads the Admin SDK lazily on the first call, so the
 * process starts without credentials and nothing touches Firestore until Mateo
 * actually uses a tarea tool.
 */
export function createTareasBackend(
  config: AppConfig,
  options: CreateTareasBackendOptions = {},
): TareasBackend {
  const clock = options.clock ?? systemClock;

  if (config.tareas.backend === "mock") {
    return createStoreTareasBackend(new MockTareasStore(options.seed), { clock });
  }

  const uid = config.tareas.firebaseUid;
  if (!uid) {
    throw new Error(
      "TAREAS_BACKEND=firestore requires MATEO_FIREBASE_UID (parseConfig should have rejected this)",
    );
  }

  let backend: Promise<TareasBackend> | undefined;
  const resolve = (): Promise<TareasBackend> => {
    backend ??= createFirestoreTareasStore({
      uid,
      ...(config.tareas.projectId === undefined ? {} : { projectId: config.tareas.projectId }),
      ...(options.firestoreApp === undefined ? {} : { app: options.firestoreApp }),
    }).then((store) => createStoreTareasBackend(store, { clock }));
    return backend;
  };

  return {
    listar: async () => (await resolve()).listar(),
    agenda: async (date) => (await resolve()).agenda(date),
    crear: async (input) => (await resolve()).crear(input),
    completar: async (input) => (await resolve()).completar(input),
  };
}
