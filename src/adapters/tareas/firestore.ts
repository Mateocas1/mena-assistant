import { TareasError } from "./client.js";
import type { TareasCollection, TareasRecord, TareasStore } from "./store.js";

/** The tiny slice of the Admin SDK this adapter needs, in absolute paths. */
export interface FirestoreAppLike {
  listDocuments(path: string): Promise<TareasRecord[]>;
  setDocument(path: string, data: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface FirestoreTareasStoreOptions {
  /** Mateo's Firebase uid: the only subtree this adapter ever touches. */
  readonly uid: string;
  readonly projectId?: string;
  /** Injectable for tests; defaults to the real Admin SDK. */
  readonly app?: FirestoreAppLike;
}

const COLLECTIONS: readonly TareasCollection[] = ["tasks", "series", "completions", "blocks"];

/**
 * Firestore Admin SDK store, structurally confined to `users/{uid}`: `documentPath`
 * is the only place a path is built, so no tool input can reach another user's
 * data. `firebase-admin` is imported lazily, so tests and the `mock` backend
 * never load it.
 */
export async function createFirestoreTareasStore(
  options: FirestoreTareasStoreOptions,
): Promise<TareasStore> {
  if (!options.uid) {
    throw new TareasError("MATEO_FIREBASE_UID is required for the Firestore tareas backend");
  }

  const app = options.app ?? (await createDefaultFirestoreApp(options.projectId));

  const documentPath = (collection: TareasCollection, id?: string): string =>
    `users/${options.uid}/${collection}${id === undefined ? "" : `/${id}`}`;

  return {
    async list(collection: TareasCollection): Promise<TareasRecord[]> {
      assertCollection(collection);
      return await app.listDocuments(documentPath(collection));
    },

    async set(
      collection: TareasCollection,
      id: string,
      data: Readonly<Record<string, unknown>>,
    ): Promise<void> {
      assertCollection(collection);
      if (!id || id.includes("/")) throw new TareasError("tareas document id is invalid");
      await app.setDocument(documentPath(collection, id), data);
    },
  };
}

function assertCollection(collection: TareasCollection): void {
  if (!COLLECTIONS.includes(collection)) {
    throw new TareasError(`unknown tareas collection: ${collection}`);
  }
}

async function createDefaultFirestoreApp(projectId?: string): Promise<FirestoreAppLike> {
  const { getApps, initializeApp, applicationDefault } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");

  const app =
    getApps()[0] ??
    initializeApp({
      credential: applicationDefault(),
      ...(projectId === undefined ? {} : { projectId }),
    });
  const db = getFirestore(app);

  return {
    async listDocuments(path) {
      const snapshot = await db.collection(path).get();
      return snapshot.docs.map((doc) => ({
        id: doc.id,
        data: doc.data() as Record<string, unknown>,
      }));
    },
    async setDocument(path, data) {
      await db.doc(path).set({ ...data });
    },
  };
}
