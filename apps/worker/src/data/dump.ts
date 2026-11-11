/**
 * The commands that dump and restore each service kind. psql runs WITHOUT --single-transaction, which
 * commits at stdin EOF, so a dying worker would commit a half replayed dump. The worker writes BEGIN itself
 * and COMMIT only after the source ended cleanly and verified: any earlier EOF rolls back.
 */
import { Transform, type TransformCallback } from "node:stream";
import type { ServiceCredentials } from "./services.ts";

/** Credentials go in the environment (PGPASSWORD, REDISCLI_AUTH), never on argv. */
export interface Command {
  cmd: string[];
  env: Record<string, string>;
}

/**
 * How long pg_dump waits for its table locks. Only an ACCESS EXCLUSIVE lock (a migration, a
 * TRUNCATE) makes it wait at all; one held longer than this fails the run, which is retried.
 */
export const DUMP_LOCK_WAIT_MS = 5 * 60_000;

export function pgDumpCommand(c: ServiceCredentials): Command {
  return {
    cmd: [
      "pg_dump", "-h", "127.0.0.1", "-U", c.user, "-d", c.database ?? "postgres",
      "--format=plain", "--no-owner", "--no-privileges", "--clean", "--if-exists", "--quote-all-identifiers",
      `--lock-wait-timeout=${DUMP_LOCK_WAIT_MS}`,
    ],
    env: { PGPASSWORD: c.password, PGAPPNAME: "dockify-backup" },
  };
}

export function psqlCommand(c: ServiceCredentials, appName = "dockify-restore"): Command {
  return {
    // Terse, no context: an error names what failed without the failing row's values.
    cmd: ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=terse", "-v", "SHOW_CONTEXT=never", "-h", "127.0.0.1", "-U", c.user, "-d", c.database ?? "postgres"],
    env: { PGPASSWORD: c.password, PGAPPNAME: appName },
  };
}

/** Cuts every other session to this database, so the replace cannot deadlock on a live client. */
export const TERMINATE_OTHERS_SQL =
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid();\n";

/** Bounds one statement of a replay: four hours is over 100 GB of one table at 10 MB/s. It stops one that never ends. */
export const RESTORE_STATEMENT_TIMEOUT = "4h";
export const RESTORE_PREAMBLE = `\\set ON_ERROR_STOP on\nSET lock_timeout = '30s';\nSET statement_timeout = '${RESTORE_STATEMENT_TIMEOUT}';\nBEGIN;\n`;
export const RESTORE_COMMIT = "\nCOMMIT;\n";

/**
 * Empties the database inside the restore's own transaction: --clean drops only what the dump names, and a newer
 * table with a foreign key to a dumped one would fail the replay. Run only when replacing.
 */
export const REPLACE_SCHEMAS_SQL =
  "DO $dockify$ DECLARE s text; BEGIN FOR s IN SELECT nspname FROM pg_namespace WHERE nspname <> 'information_schema' AND nspname NOT LIKE 'pg\\_%' LOOP EXECUTE format('DROP SCHEMA %I CASCADE', s); END LOOP; END $dockify$;\n" +
  "CREATE SCHEMA public;\nGRANT USAGE ON SCHEMA public TO PUBLIC;\n";

const HEAD_BYTES = 8 * 1024;
const HEAD_LINE = /^(--|\\restrict |SET |SELECT pg_catalog\.set_config\()/;

/**
 * pg_dump opens with SET statement_timeout = 0 and SET lock_timeout = 0, which would undo the preamble's. They
 * are dropped from the dump's own header only, so no data line can match.
 */
export function keepTimeouts(head: Buffer): Buffer {
  const lines = head.toString("latin1").split("\n");
  const kept: string[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    if (line !== "" && !HEAD_LINE.test(line)) break;
    if (!/^SET (statement_timeout|lock_timeout) = 0;$/.test(line)) kept.push(lines[i]!);
  }
  return Buffer.from([...kept, ...lines.slice(i)].join("\n"), "latin1");
}

/**
 * Frames a plain SQL dump as one explicit transaction. COMMIT is written only from _flush, which runs only
 * when the upstream ended without error. Otherwise the session ends with the transaction open and it rolls back.
 */
export class RestoreFramer extends Transform {
  #started = false;
  #replace: boolean;
  #head: Buffer[] | null = [];
  #headBytes = 0;

  /** `replace`: over a live database, so other sessions are cut and what is in it goes first. */
  constructor(opts: { replace?: boolean } = {}) {
    super();
    this.#replace = opts.replace ?? false;
  }

  #start(): void {
    if (this.#started) return;
    this.#started = true;
    this.push(this.#replace ? TERMINATE_OTHERS_SQL + RESTORE_PREAMBLE + REPLACE_SCHEMAS_SQL : RESTORE_PREAMBLE);
    const head = Buffer.concat(this.#head ?? []);
    this.#head = null;
    if (head.length) this.push(keepTimeouts(head));
  }

  override _transform(chunk: Buffer, _e: BufferEncoding, cb: TransformCallback): void {
    if (!this.#head) return cb(null, chunk);
    this.#head.push(chunk);
    this.#headBytes += chunk.length;
    if (this.#headBytes >= HEAD_BYTES) this.#start();
    cb();
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

export function redisDumpCommand(c: ServiceCredentials): Command {
  return { cmd: ["redis-cli", "--no-auth-warning", "--rdb", "-"], env: { REDISCLI_AUTH: c.password } };
}

export const REDIS_STAGE_PATH = "/data/dockify-restore.rdb";

export function redisStageCommand(): Command {
  return { cmd: ["sh", "-c", `cat > ${REDIS_STAGE_PATH} && test -s ${REDIS_STAGE_PATH}`], env: {} };
}

/**
 * Swaps the staged snapshot in. Saving is switched off first so a background save cannot race the rename,
 * and back on if the swap fails. redis-cli can exit 0 on an error reply, so the reply is read.
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

