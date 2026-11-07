"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/icon";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/chip";
import { CopyButton } from "@/components/ui/copy-button";
import { Empty } from "@/components/ui/empty";
import { Field, SearchField, TextArea } from "@/components/ui/field";
import { PendingButton } from "@/components/ui/pending";
import { ResultCount } from "@/components/ui/result-count";
import { SkelRows } from "@/components/ui/skeleton";
import { appTitle, bytes, plural } from "@/lib/format";
import type { AppDetail, Cell, PgColumn, PgRows, PgTables, QueryResult, RedisKeys, RedisType } from "@/lib/pages/project-detail";
import { isStepUpCancel, STEP_UP_MINUTES } from "@/lib/step-up";
import { useCan } from "@/lib/viewer";
import { mutate } from "@/components/project-detail/controls";
import { AdminOnly, TabCard, TabFailed } from "./states";
import { useAppTab } from "./use-tab";
import { notRunning } from "@/lib/derive";

/* Data: a read-only browser for this app’s database. Postgres lists its tables with row counts and
   shows the first 50 rows of the picked one with column types, plus a query box that runs
   read-only SQL. Rows and queries are tenant data, so both ask "Confirm it is you" when the API
   wants a step-up (components/step-up). Redis searches keys with a glob and shows each key’s type
   and TTL. Nothing here can write. The API keeps all of it for admins, so a Viewer sees why
   instead of a refused read. */

/* -------------- Grid -------------- */

function cellText(v: Cell) {
  if (v === null) return null;
  return typeof v === "string" ? v : String(v);
}

/** Rows as a real table that scrolls inside its frame; the page itself never scrolls sideways. */
function Grid({ columns, rows, label }: { columns: PgColumn[]; rows: Cell[][]; label: string }) {
  return (
    <div className="at-grid-wrap" tabIndex={0} role="region" aria-label={label}>
      <table className="at-grid num">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.name} scope="col">
                <span className="at-col">
                  <span className="at-col-name">
                    {c.primary ? <Icon name="key" size={14} label="Primary key" /> : null}
                    {c.name}
                  </span>
                  <span className="at-col-type">
                    {c.type}
                    {c.nullable ? ", null" : ""}
                  </span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((v, k) => {
                const t = cellText(v);
                return <td key={k}>{t === null ? <span className="at-null">NULL</span> : t}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------- Postgres -------------- */

function TableList({ tables, picked, onPick }: { tables: PgTables["tables"]; picked: string | null; onPick: (t: string) => void }) {
  return (
    <ul className="soft-list at-tables" aria-label="Tables">
      {tables.map((t) => {
        const id = `${t.schema}.${t.name}`;
        return (
          <li key={id}>
            <button type="button" className="soft-row at-table" aria-current={picked === id || undefined} onClick={() => onPick(id)}>
              <Icon name="grid" size={16} />
              <span className="two">
                <span className="two-main num">{t.name}</span>
                <span className="two-sub num">
                  {t.rows.toLocaleString("en-US")} {t.rows === 1 ? "row" : "rows"}, {bytes(t.sizeBytes)}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** What a read that found the container down says, instead of the bare status text. */
const idleText = (app: AppDetail) => `${appTitle(app)} is not running or cannot be reached right now. Start it, then try again.`;

function RowsPanel({ app, table }: { app: AppDetail; table: string }) {
  const q = useAppTab<PgRows>(app.id, "rows", { table });
  const name = table.split(".")[1] ?? table;
  if (!q.data && q.loading) {
    return <SkelRows rows={8} template="repeat(4, minmax(0,1fr))" cols={["70%", "60%", "50%", "40%"]} label={`Loading ${name}`} />;
  }
  if (!q.data) return <TabFailed error={q.error} onRetry={q.reload} idle={idleText(app)} what="This table" />;
  const r = q.data;
  return (
    <div className="at-rows" data-loading={q.loading || undefined}>
      <p className="at-rows-hd num">
        <span>
          {r.rows.length ? `First ${plural(r.rows.length, "row")}` : "No rows"} of about {r.total.toLocaleString("en-US")}
        </span>
        <CopyButton value={`select * from ${table} limit 50;`} what="select statement" align="end" />
      </p>
      {r.rows.length ? <Grid columns={r.columns} rows={r.rows} label={`Rows of ${name}`} /> : <Empty icon="grid" title="No rows yet" body={`${name} has columns but no rows yet.`} />}
    </div>
  );
}

const isResult = (v: unknown): v is QueryResult =>
  Boolean(v) && typeof v === "object" && Array.isArray((v as Partial<QueryResult>).columns) && Array.isArray((v as Partial<QueryResult>).rows);

/* An example in the placeholder only: the box starts empty, so nothing runs that the operator did not type. */
const SAMPLE_SQL = "select id, username, created_at\nfrom users\norder by created_at desc\nlimit 20;";

function QueryBox({ app, preview }: { app: AppDetail; preview: boolean }) {
  const [sql, setSql] = useState("");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ ok: true; r: QueryResult } | { ok: false; error: string } | null>(null);

  const send = async () => {
    setBusy(true);
    const res = await mutate({ type: "app.query", id: app.id, sql });
    setBusy(false);
    // Closing "Confirm it is you" ran nothing: the last answer stays.
    if (isStepUpCancel(res)) return;
    setOut(res.ok && isResult(res.data) ? { ok: true, r: res.data } : { ok: false, error: res.error ?? "The query did not answer" });
  };

  const run = () => {
    if (busy || !sql.trim()) return;
    void send();
  };

  return (
    <TabCard
      id="at-q-title"
      icon="terminal"
      title="Query"
      sub="Read-only SQL, at most 500 rows"
      actions={
        // Busy keeps the focus (aria-disabled); an empty box is a key that cannot run yet.
        <PendingButton className="btn btn-sm btn-primary" pending={busy} disabled={!sql.trim()} icon="play" onClick={run}>
          Run query
        </PendingButton>
      }
    >
      <div className="at-query">
        <Callout icon="shieldCheck">
          {`Queries run in a read-only transaction with a 5-second timeout, and each one is written to the activity log. Running one asks you to confirm it is you once every ${STEP_UP_MINUTES} minutes.`}
          {preview ? " Preview, answers come from sample tables." : ""}
        </Callout>
        <Field label="SQL" hint="Ctrl or Cmd and Enter runs it.">
          {(ids) => (
            <TextArea
              ids={ids}
              className="at-sql"
              rows={5}
              value={sql}
              placeholder={SAMPLE_SQL}
              spellCheck={false}
              onChange={(e) => setSql(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  run();
                }
              }}
            />
          )}
        </Field>
      </div>
      {out ? (
        out.ok ? (
          <div className="at-rows">
            <p className="at-rows-hd num">
              <span>
                {plural(out.r.rowCount, "row")} in {out.r.durationMs.toLocaleString("en-US")} ms{out.r.truncated ? ", more matched than the cap returns" : ""}
              </span>
            </p>
            {out.r.rows.length ? <Grid columns={out.r.columns} rows={out.r.rows} label="Query result" /> : <Empty icon="grid" title="No rows match" body="The query ran and matched nothing." />}
          </div>
        ) : (
          <div className="at-q-out">
            <Callout tone="bad" icon="alert" role="alert">
              <span className="num">{out.error}</span>
            </Callout>
          </div>
        )
      ) : null}
    </TabCard>
  );
}

function PostgresData({ app }: { app: AppDetail }) {
  const q = useAppTab<PgTables>(app.id, "tables");
  // No table is read until one is picked: rows are tenant data behind a step-up, so opening the tab
  // never asks "Confirm it is you" before the operator asked for anything.
  const [table, setPicked] = useState<string | null>(null);
  const tables = q.data?.tables ?? [];

  return (
    <div className="pd-stack">
      <TabCard
        id="at-data-title"
        icon="database"
        title="Tables"
        sub={q.data ? `${plural(tables.length, "table")} in ${q.data.database}, row counts are estimates` : "Read-only, nothing here can write"}
        actions={
          // A failed read already offers Try again, so Refresh only shows over tables it can reload.
          q.data ? (
            <PendingButton className="btn btn-sm" pending={q.loading} onClick={q.reload}>
              Refresh
            </PendingButton>
          ) : undefined
        }
      >
        {!q.data && q.loading ? (
          <SkelRows rows={6} height={56} template="24px minmax(0,1fr)" cols={[16, { w: "60%", lines: 2 }]} />
        ) : !q.data ? (
          <TabFailed error={q.error} onRetry={q.reload} idle={idleText(app)} what="This database" />
        ) : tables.length === 0 ? (
          <Empty icon="database" title="No tables yet" body="Tables appear here once the app’s migrations have run." />
        ) : (
          <div className="at-browser">
            <TableList tables={tables} picked={table} onPick={setPicked} />
            {table ? (
              <RowsPanel key={table} app={app} table={table} />
            ) : (
              <div className="at-rows">
                <Empty
                  icon="grid"
                  title="Pick a table"
                  body={`Its first 50 rows show here. Reading rows asks you to confirm it is you once every ${STEP_UP_MINUTES} minutes.`}
                />
              </div>
            )}
          </div>
        )}
      </TabCard>
      <QueryBox app={app} preview={q.source === "preview"} />
    </div>
  );
}

/* -------------- Redis -------------- */

const TYPE_LABEL: Record<RedisType, string> = { string: "String", hash: "Hash", list: "List", set: "Set", zset: "Sorted set", stream: "Stream" };

/** Seconds left as "45s", "12m", "3h 20m" or "2d 4h". */
function ttl(s: number) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
}

function RedisData({ app }: { app: AppDetail }) {
  const [text, setText] = useState("");
  const [match, setMatch] = useState("*");
  // The scan runs once typing settles, so each key press does not cost a SCAN.
  useEffect(() => {
    const t = setTimeout(() => setMatch(text.trim() ? (/[*?]/.test(text) ? text.trim() : `*${text.trim()}*`) : "*"), 300);
    return () => clearTimeout(t);
  }, [text]);
  const q = useAppTab<RedisKeys>(app.id, "keys", { match });
  const keys = q.data?.keys ?? [];

  return (
    <TabCard
      id="at-data-title"
      icon="bolt"
      title="Keys"
      sub={q.data ? `${plural(keys.length, "match", "matches")} of ${plural(q.data.total, "key")}${q.data.truncated ? ", refine the pattern to see more" : ""}` : "Read-only, nothing here can write"}
    >
      <div className="toolbar">
        <SearchField value={text} onChange={setText} label="Search keys" placeholder="Search key names, or a glob such as sess:*" />
        {/* Said once the scan for this text has answered, never the previous count under the new text. */}
        {q.data && !q.loading ? <ResultCount count={keys.length} one="key" query={text} /> : null}
      </div>
      {!q.data && q.loading ? (
        <SkelRows rows={8} template="minmax(0,1fr) 96px 88px 72px" cols={["55%", 64, 56, 48]} />
      ) : !q.data ? (
        <TabFailed error={q.error} onRetry={q.reload} idle={idleText(app)} what="This database" />
      ) : keys.length === 0 && match === "*" ? (
        <Empty icon="bolt" title="No keys yet" body={`${app.name} holds no keys right now. They show here as the app writes them.`} />
      ) : keys.length === 0 ? (
        <Empty
          icon="search"
          title="No keys match"
          body={`Nothing matches “${match}”. A * matches any run of characters.`}
          action={
            <button type="button" className="btn btn-sm" onClick={() => setText("")}>
              Clear search
            </button>
          }
        />
      ) : (
        <div className="at-keys" data-loading={q.loading || undefined}>
          <div className="at-key at-key-hd" aria-hidden="true">
            <span>Key</span>
            <span>Type</span>
            <span>TTL</span>
            <span>Size</span>
          </div>
          <ul className="soft-list" aria-label="Keys">
            {keys.map((k) => (
              <li key={k.key} className="at-key">
                <span className="at-key-name num">
                  <span className="at-key-text">{k.key}</span>
                  <CopyButton value={k.key} what="key" />
                </span>
                <span>
                  <Chip size="xs">{TYPE_LABEL[k.type]}</Chip>
                </span>
                <span className="num">{k.ttlSeconds === null ? <span className="none">No expiry</span> : ttl(k.ttlSeconds)}</span>
                <span className="num at-key-size">{bytes(k.sizeBytes)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </TabCard>
  );
}

export function DataTab({ app }: { app: AppDetail }) {
  const can = useCan();
  if (!can.manage) return <AdminOnly body="Only an admin can browse this database and run queries against it." />;
  if (notRunning(app.status)) {
    return (
      <div className="card">
        <Empty icon="database" title="Not running" body={`Start ${app.name} to browse its data.`} />
      </div>
    );
  }
  return app.kind === "redis" ? <RedisData app={app} /> : <PostgresData app={app} />;
}
