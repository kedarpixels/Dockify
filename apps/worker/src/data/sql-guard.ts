/**
 * The real guarantees are server side: a READ ONLY transaction under a role with only pg_read_all_data. This
 * lexer refuses what would try to step out of that box: a second statement, a non-query, server-side functions.
 */

export class SqlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlGuardError";
  }
}

const FIRST_WORDS = new Set(["select", "with", "values", "table", "show", "explain"]);
/** Run through a cursor so the row cap is enforced by the server, not by reading everything. */
const CURSOR_WORDS = new Set(["select", "with", "values", "table"]);

const DENIED_FUNCTIONS = [
  "set_config", "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf", "pg_rotate_logfile",
  "pg_read_file", "pg_read_binary_file", "pg_ls_dir", "pg_stat_file", "lo_import", "lo_export",
  "dblink", "dblink_exec", "dblink_connect", "pg_sleep", "pg_sleep_for", "pg_sleep_until",
  "pg_advisory_lock", "pg_advisory_xact_lock", "pg_try_advisory_lock", "pg_switch_wal", "pg_promote",
  "pg_create_restore_point", "pg_logical_emit_message", "pg_notify", "query_to_xml", "pg_file_write",
];
const DENIED_RE = new RegExp(`\\b(${DENIED_FUNCTIONS.join("|")})\\s*\\(`, "i");

/**
 * Replaces comments, string literals, dollar quoted bodies and quoted identifiers with spaces, so
 * keyword checks see only real SQL tokens. Throws on an unterminated one.
 */
export function maskSql(sql: string): string {
  return scanSql(sql).masked;
}

function scanSql(sql: string): { masked: string; quoted: Array<{ start: number; end: number }> } {
  const quoted: Array<{ start: number; end: number }> = [];
  let out = "";
  let i = 0;
  const n = sql.length;
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += blank(sql.slice(i, stop));
      i = stop;
    } else if (c === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") (depth++, (j += 2));
        else if (sql[j] === "*" && sql[j + 1] === "/") (depth--, (j += 2));
        else j++;
      }
      if (depth > 0) throw new SqlGuardError("Unterminated comment");
      out += blank(sql.slice(i, j));
      i = j;
    } else if (c === "'" || ((c === "E" || c === "e") && next === "'" && !/[\w$]/.test(sql[i - 1] ?? ""))) {
      const escapes = c !== "'";
      let j = i + (escapes ? 2 : 1);
      for (;;) {
        if (j >= n) throw new SqlGuardError("Unterminated string literal");
        if (escapes && sql[j] === "\\") j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      out += blank(sql.slice(i, j + 1));
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new SqlGuardError("Unterminated quoted identifier");
        if (sql[j] === '"' && sql[j + 1] === '"') j += 2;
        else if (sql[j] === '"') break;
        else j++;
      }
      quoted.push({ start: i, end: j + 1 });
      out += blank(sql.slice(i, j + 1));
      i = j + 1;
    } else if (c === "$" && !/[\w$]/.test(sql[i - 1] ?? "")) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (!m) {
        out += c;
        i++;
        continue;
      }
      const tag = m[0];
      const end = sql.indexOf(tag, i + tag.length);
      if (end === -1) throw new SqlGuardError("Unterminated dollar quoted string");
      out += blank(sql.slice(i, end + tag.length));
      i = end + tag.length;
    } else {
      out += c;
      i++;
    }
  }
  return { masked: out, quoted };
}

export interface GuardedSql {
  text: string;
  cursor: boolean;
}

/** A quoted name in call position reaches the function the plain name does: "pg_sleep"(30) is pg_sleep(30). */
function deniedQuotedCall(sql: string, masked: string, quoted: ReadonlyArray<{ start: number; end: number }>): string | null {
  for (const q of quoted) {
    if (!/^\s*\(/.test(masked.slice(q.end))) continue;
    // U&"pg\\005fsleep"(1) spells any name in escapes, and no read-only query needs one.
    if (/\bu&\s*$/i.test(masked.slice(0, q.start))) return "A function name in Unicode escapes";
    const name = sql.slice(q.start + 1, q.end - 1).replace(/""/g, '"');
    if (DENIED_RE.test(`${name}(`)) return name;
  }
  return null;
}

export function guardReadOnlySql(sql: string): GuardedSql {
  const { masked, quoted } = scanSql(sql);
  const trimmed = masked.replace(/[\s;]+$/, "");
  if (!trimmed.trim()) throw new SqlGuardError("Enter a query");
  if (trimmed.includes(";")) throw new SqlGuardError("One statement per run. Remove the extra statements and run them separately.");
  const first = /^\s*\(*\s*([A-Za-z]+)/.exec(trimmed)?.[1]?.toLowerCase();
  if (!first || !FIRST_WORDS.has(first)) throw new SqlGuardError("The console runs read-only queries: SELECT, WITH, VALUES, TABLE, SHOW or EXPLAIN.");
  const denied = DENIED_RE.exec(trimmed)?.[1] ?? deniedQuotedCall(sql, masked, quoted);
  if (denied) throw new SqlGuardError(`${denied} acts on the server, not on data, and is not available here.`);
  if (/\binto\b/i.test(trimmed) && first === "select") throw new SqlGuardError("SELECT INTO creates a table, which a read-only query cannot do.");
  return { text: sql.slice(0, trimmed.length), cursor: CURSOR_WORDS.has(first) && !/^\s*\(/.test(trimmed) };
}

export const quoteIdent = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/** "schema.table" as two quoted identifiers. The contract regex already limits the characters. */
export function quoteQualified(table: string): { schema: string; name: string; sql: string } {
  const dot = table.indexOf(".");
  if (dot <= 0) throw new SqlGuardError("Name the table as schema.table");
  const schema = table.slice(0, dot);
  const name = table.slice(dot + 1);
  return { schema, name, sql: `${quoteIdent(schema)}.${quoteIdent(name)}` };
}
