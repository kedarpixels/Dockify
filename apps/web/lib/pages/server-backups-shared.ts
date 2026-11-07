import type { BackupRun, UpdateStepId } from "./server-backups";

/*
 * The client-safe values of the Server and Backups pages: the update steps, the new database name
 * rule and the orphan check. The loader (lib/pages/server-backups.ts) re-exports them; client
 * components import from here, so no server code or preview fixture reaches the browser. Types come
 * from the loader as type-only imports, which leave nothing behind.
 */

/** The steps of an update, in order. A rollback adds its own step at the end. */
export const UPDATE_STEPS: UpdateStepId[] = ["preflight", "pull", "backup", "migrate", "swapApi", "swapWorker", "swapWeb", "health"];

/** A new database name: lowercase, starts with a letter, 2 to 40 characters. */
export const NEW_DB_NAME = /^[a-z][a-z0-9-]{1,39}$/;

/** An orphaned run: its database (and app) was deleted. */
export const isOrphan = (r: BackupRun) => Boolean(r.database.deletedAt);
