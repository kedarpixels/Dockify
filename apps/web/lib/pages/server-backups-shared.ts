import type { BackupRun, UpdateStepId } from "./server-backups";

// Client-safe values of the Server and Backups pages: client components import from here, so no server code or preview fixture reaches the browser.

/** The steps of an update, in order. A rollback adds its own step at the end. */
export const UPDATE_STEPS: UpdateStepId[] = ["preflight", "pull", "backup", "migrate", "swapApi", "swapWorker", "swapWeb", "health"];

/** A new database name: lowercase, starts with a letter, 2 to 40 characters. */
export const NEW_DB_NAME = /^[a-z][a-z0-9-]{1,39}$/;

/** An orphaned run: its database (and app) was deleted. */
export const isOrphan = (r: BackupRun) => Boolean(r.database.deletedAt);
