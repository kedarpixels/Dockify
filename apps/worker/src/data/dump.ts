/**
 * The commands that dump and restore each service kind, and the framing that makes a Postgres
 * restore crash safe. Pure, so the exact argv and SQL are pinned by tests.
 *
 * Crash safety: psql with --single-transaction commits when stdin reaches EOF, and
 * a dying worker closes stdin cleanly, so a cut stream used to COMMIT a half replayed dump. Here
 * psql runs WITHOUT --single-transaction and the worker writes BEGIN itself, then the dump, then
 * COMMIT only after the source ended cleanly and verified. Any EOF before that ends the session
 * with the transaction open, and Postgres rolls it back.
 */
import { Transform, type TransformCallback } from "node:stream";
import type { ServiceCredentials } from "./services.ts";

/** Credentials go in the environment (PGPASSWORD, REDISCLI_AUTH), never on argv. */
export interface Command {
  cmd: string[];
  env: Record<string, string>;
}

export function pgDumpCommand(c: ServiceCredentials): Command {
  return {
    cmd: [
      "pg_dump", "-h", "127.0.0.1", "-U", c.user, "-d", c.database ?? "postgres",
      "--format=plain", "--no-owner", "--no-privileges", "--clean", "--if-exists", "--quote-all-identifiers",
    ],
    env: { PGPASSWORD: c.password, PGAPPNAME: "dockify-backup" },
  };
}

export function psqlCommand(c: ServiceCredentials, appName = "dockify-restore"): Command {
  return {
    cmd: ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-U", c.user, "-d", c.database ?? "postgres"],
    env: { PGPASSWORD: c.password, PGAPPNAME: appName },
  };
}

/** Cuts every other session to this database, so the replace cannot deadlock on a live client. */
export const TERMINATE_OTHERS_SQL =
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid();\n";

export const RESTORE_PREAMBLE = "\\set ON_ERROR_STOP on\nSET lock_timeout = '30s';\nBEGIN;\n";
export const RESTORE_COMMIT = "\nCOMMIT;\n";

/**
 * Empties the database inside the restore's own transaction. The dump's --clean drops only what the
 * dump names: a table added since then stays beside the restored data, and one with a foreign key to
 * a dumped table makes the replay fail, for good. The pre-restore dump is what undoes this, and any
 * failure rolls it back with the rest. Run only when replacing: a brand new target has nothing to drop.
 */
export const REPLACE_SCHEMAS_SQL =
  "DO $dockify$ DECLARE s text; BEGIN FOR s IN SELECT nspname FROM pg_namespace WHERE nspname <> 'information_schema' AND nspname NOT LIKE 'pg\\_%' LOOP EXECUTE format('DROP SCHEMA %I CASCADE', s); END LOOP; END $dockify$;\n" +
  "CREATE SCHEMA public;\nGRANT USAGE ON SCHEMA public TO PUBLIC;\n";

/**
 * Frames a plain SQL dump as one explicit transaction. COMMIT is written only from _flush, which
 * runs only when the upstream ended without error. An upstream error destroys this stream instead,
 * the caller then destroys psql's stdin, and the open transaction rolls back.
 */
export class RestoreFramer extends Transform {
  #started = false;
  #replace: boolean;

  /** `replace`: over a live database, so other sessions are cut and what is in it goes first. */
  constructor(opts: { replace?: boolean } = {}) {
    super();
    this.#replace = opts.replace ?? false;
  }

  #start(): void {
    if (this.#started) return;
    this.#started = true;
    this.push(this.#replace ? TERMINATE_OTHERS_SQL + RESTORE_PREAMBLE + REPLACE_SCHEMAS_SQL : RESTORE_PREAMBLE);
  }

  override _transform(chunk: Buffer, _e: BufferEncoding, cb: TransformCallback): void {
    this.#start();
    cb(null, chunk);
  }

  override _flush(cb: TransformCallback): void {
    this.#start();
    this.push(RESTORE_COMMIT);
    cb();
  }
}

/**
 * Restore test checks, one statement: how many user tables exist and the exact row count across
 * them (query_to_xml runs a count per table without a function definition). Output is "tables,rows".
 */
export const RESTORE_CHECK_SQL =
  "SELECT count(*) || ',' || coalesce(sum((xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', schemaname, tablename), false, true, '')))[1]::text::bigint), 0) " +
  "FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND schemaname NOT LIKE 'pg_toast%'";

export function restoreCheckCommand(c: ServiceCredentials): Command {
  const base = psqlCommand(c, "dockify-restore-test");
  return { cmd: [...base.cmd, "-A", "-t", "-c", RESTORE_CHECK_SQL], env: base.env };
}

export function parseRestoreCheck(out: string): { tables: number; rows: number } {
  const m = /^\s*(\d+),(\d+)\s*$/.exec(out);
  if (!m) throw new Error(`restore check printed an unexpected result: ${out.slice(0, 200)}`);
  return { tables: Number(m[1]), rows: Number(m[2]) };
}

// ------------------------------------------------------------------------------------- redis

/** Streams an RDB snapshot to stdout over the replication protocol, authenticated. */
export function redisDumpCommand(c: ServiceCredentials): Command {
  return { cmd: ["redis-cli", "--no-auth-warning", "--rdb", "-"], env: { REDISCLI_AUTH: c.password } };
}

export const REDIS_STAGE_PATH = "/data/dockify-restore.rdb";

/** Receives the snapshot on stdin into a staging file next to the live one. */
export function redisStageCommand(): Command {
  return { cmd: ["sh", "-c", `cat > ${REDIS_STAGE_PATH} && test -s ${REDIS_STAGE_PATH}`], env: {} };
}

/**
 * Swaps the staged snapshot in. Saving is switched off first so a background save cannot race the
 * rename, and back on if the swap fails, when Redis keeps running on what it had. redis-cli can exit
 * 0 on an error reply, so the reply is read.
 */
export function redisSwapCommand(c: ServiceCredentials): Command {
  return {
    cmd: ["sh", "-c", `prev=$(redis-cli CONFIG GET save | tail -n 1); [ "$(redis-cli CONFIG SET save "")" = OK ] && mv -f ${REDIS_STAGE_PATH} /data/dump.rdb || { redis-cli CONFIG SET save "$prev" >/dev/null; exit 1; }`],
    env: { REDISCLI_AUTH: c.password },
  };
}

/** Stops Redis without saving, so it cannot overwrite the swapped file on the way down. It takes this exec with it, so its exit says nothing. */
export function redisShutdownCommand(c: ServiceCredentials): Command {
  return { cmd: ["redis-cli", "SHUTDOWN", "NOSAVE"], env: { REDISCLI_AUTH: c.password } };
}

