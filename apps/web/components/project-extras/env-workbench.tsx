"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { CardTitle } from "@/components/card-title";
import { Icon } from "@/components/icon";
import { AppIcon } from "@/components/icons/app-icon";
import { track } from "@/components/project-detail/controls";
import { parseDotenv } from "@/components/project-detail/dotenv";
import { KIND_LABEL } from "@/components/project-detail/shared";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Empty } from "@/components/ui/empty";
import { envName } from "@/components/ui/env-tag";
import { Field, SearchField, TextArea } from "@/components/ui/field";
import { ResultCount } from "@/components/ui/result-count";
import { Rule } from "@/components/ui/rule";
import { filterOptions, Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { SkelRows } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { describe } from "@/lib/feedback";
import { appTitle, plural } from "@/lib/format";
import type { AppSummary, EnvTarget, EnvVersion, ProjectExtras } from "@/lib/pages/project-detail";
import type { ActorRef } from "@/lib/types";
import { useCan, useViewer } from "@/lib/viewer";
import { EnvEditRow, EnvTableHead, EnvVarRow, TARGET_OPTIONS, type Draft, type RowApp } from "@/components/env/env-table";
import { send } from "./api";
import {
  affectedApps, applyLocal, changeId, changesIn, refViewOf, rowsOf, stage, unstage, varsOf, versionOf, type EnvRow, type Scope, type Staged,
  isPublicBuildKey,
} from "./env-model";
import { refText } from "./env-refs";
import { HistoryCard } from "./env-history";
import { showsEnvironments } from "@/lib/environments";
import { ReviewDialog } from "./env-review";
import { LinkResourceDialog, type LinkPick } from "./link-resource";
import { RowMenu, type RowMenuItem } from "./row-menu";

/* Environment variables, staged: edits to shared variables and app overrides collect into pending
   changes, which Review applies as one new version. Secret values never arrive with the page; they
   come through the audited reveal. Applying or rolling back asks "Confirm it is you" when the API
   wants a fresh step-up (components/step-up, through `send`), and `?link=<appId>` opens Link a
   service. The project Variables tab edits everything; an app Variables tab (`appId`) is the same
   workbench on that app alone: its environment, the shared rows read only, and its own overrides
   to edit. Only an admin may read variables (apps/api/src/policy.ts), so a Viewer gets one calm
   line instead of a refusal. */

/** What the workbench reads of a project: the slug, the environment names and the apps. */
export interface EnvProject {
  slug: string;
  environments: Array<{ name: string }>;
  apps: AppSummary[];
}

const FILTER_AT = 8;
const READS_ENV = new Set(["frontend", "backend", "bot"]);

type Editing = { scope: string; key: string | null } | null;

/** "Production, shared" or "Production, api", for toasts and dialog lines; "shared" or "api" when the project shows no environments. */
const scopeName = (s: Scope, apps: AppSummary[], many: boolean) => {
  const found = s.appId ? apps.find((a) => a.id === s.appId) : undefined;
  const part = s.appId ? (found ? appTitle(found) : "app") : "shared";
  return many ? `${envName(s.environment)}, ${part}` : part;
};

/** A row's last key (Edit, or Undo for a staged removal): where the focus goes once the row changed under it. */
function lastKey(id: string): HTMLElement | null {
  const keys = document.querySelectorAll<HTMLElement>(`[data-row="${CSS.escape(id)}"] .ev-var-acts :is(button, a[href])`);
  return keys[keys.length - 1] ?? null;
}

/**
 * After a row's editor closes, or its menu stages a removal, the focus lands on that row, never on
 * the page. A row that goes away (a staged addition taken back) hands it to its neighbour, read
 * before the table changes, and failing that to the page's main region.
 */
function focusRow(id: string) {
  const row = document.querySelector(`[data-row="${CSS.escape(id)}"]`);
  const near = (row?.nextElementSibling ?? row?.previousElementSibling)?.getAttribute("data-row") ?? null;
  requestAnimationFrame(() => {
    const key = lastKey(id) ?? (near ? lastKey(near) : null);
    if (key) key.focus();
    else document.getElementById("main")?.focus({ preventScroll: true });
  });
}

/** Keys only: matching on a value would give away what a masked row holds. */
const matching = (rows: EnvRow[], q: string) => (q ? rows.filter((r) => r.key.toLowerCase().includes(q)) : rows);

/**
 * One scope's items in a table: an optional add row, then its rows. With `app`, each carries the
 * app cell. With `readOnlyHref`, the rows only read and their edit key opens that page instead.
 */
function ScopeItems({
  scope,
  rows,
  taken,
  app,
  readOnlyHref,
  now,
  editing,
  notes,
  shown,
  revealing,
  cache,
  link,
  onEditing,
  onStage,
  onUnstage,
  onReveal,
  onCopy,
  onUnlink,
  onBack,
}: {
  scope: Scope;
  /** The rows to draw, already filtered. */
  rows: EnvRow[];
  /** Keys already set in the scope, which the add row refuses. */
  taken: string[];
  app?: Omit<RowApp, "start">;
  readOnlyHref?: string;
  now: number;
  editing: Editing;
  notes: (key: string) => string | undefined;
  shown: ReadonlySet<string>;
  revealing: ReadonlySet<string>;
  cache: ReadonlyMap<string, string>;
  link: (row: EnvRow) => { text: string; missing?: boolean } | undefined;
  onEditing: (e: Editing) => void;
  onStage: (scope: Scope, d: Draft, row?: EnvRow) => void;
  onUnstage: (scope: Scope, key: string) => void;
  onReveal: (scope: Scope, row: EnvRow) => void;
  onCopy: (scope: Scope, row: EnvRow) => Promise<string>;
  onUnlink: (scope: Scope, row: EnvRow) => void;
  /** Puts the focus back on the key that opened the add row. */
  onBack: () => void;
}) {
  const router = useRouter();
  const sid = changeId(scope, "");
  const adding = editing?.scope === sid && editing.key === null;
  const valueOf = (r: EnvRow) => (r.value !== null ? r.value : (cache.get(changeId(scope, r.key)) ?? null));
  const remove = (r: EnvRow) => onStage(scope, { key: r.key, value: undefined, secret: r.secret, target: r.target }, { ...r, state: "removed" });
  const cell = (start: boolean) => (app ? { ...app, start } : undefined);

  return (
    <>
      {adding ? (
        <EnvEditRow
          mode="add"
          initial={{ key: "", value: "", secret: true, target: "runtime" }}
          targets
          staged
          app={cell(true)}
          taken={taken}
          onSave={(d) => {
            onStage(scope, d);
            focusRow(changeId(scope, d.key));
          }}
          onCancel={() => {
            onEditing(null);
            onBack();
          }}
        />
      ) : null}
      {rows.map((r, i) => {
        const id = changeId(scope, r.key);
        const start = i === 0 && !adding;
        if (editing?.scope === sid && editing.key === r.key) {
          const value = valueOf(r);
          return (
            <EnvEditRow
              key={r.key}
              mode="edit"
              initial={{ key: r.key, value: r.valueStaged ? (r.value ?? "") : (value ?? undefined), secret: r.secret, target: r.target }}
              knownValue={value !== null}
              targets
              staged
              app={cell(start)}
              taken={[]}
              onSave={(d) => {
                onStage(scope, d, r);
                focusRow(id);
              }}
              onCancel={() => {
                onEditing(null);
                focusRow(id);
              }}
              onDelete={() => {
                remove(r);
                focusRow(id);
              }}
            />
          );
        }
        // A link staged in this session has nothing on the server to reveal or unlink yet.
        const undoOnly = r.state === "removed" || Boolean(r.ref && r.change?.ref);
        return (
          <EnvVarRow
            key={r.key}
            rowId={id}
            name={r.key}
            secret={r.secret}
            state={r.state}
            target={r.target}
            updatedAt={r.state === "same" && r.base ? r.base.updatedAt : null}
            now={now}
            shown={shown.has(id)}
            value={valueOf(r)}
            revealing={revealing.has(id)}
            note={notes(r.key)}
            link={link(r)}
            app={cell(start)}
            onReveal={() => onReveal(scope, r)}
            onCopy={() => onCopy(scope, r)}
            onEdit={readOnlyHref ? () => router.push(readOnlyHref) : () => onEditing({ scope: sid, key: r.key })}
            linkEdit={
              readOnlyHref
                ? { href: readOnlyHref }
                : {
                    onUnlink: () => onUnlink(scope, r),
                    onRemove: () => {
                      remove(r);
                      focusRow(id);
                    },
                  }
            }
            onUndo={undoOnly ? () => onUnstage(scope, r.key) : undefined}
          />
        );
      })}
    </>
  );
}

function NoMatch({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <Empty
      icon="search"
      title="No variables match"
      body={`Nothing matches “${query.trim()}”. Search looks at keys, never values.`}
      action={
        <button type="button" className="btn btn-sm" onClick={onClear}>
          Clear search
        </button>
      }
    />
  );
}

function Skeleton() {
  return (
    <div className="pd-stack">
      <section className="card" aria-label="Loading variables">
        <div className="card-hd">
          <CardTitle id="px-env-skel" icon="key" title="Shared variables" sub="Loading" />
        </div>
        <div className="ev-vars-wrap">
          <SkelRows rows={6} template="minmax(0,0.9fr) minmax(0,1.5fr) 96px 88px 92px" cols={["60%", "70%", 56, 48, 72]} />
        </div>
      </section>
    </div>
  );
}

export function EnvWorkbench({
  project,
  extras,
  loading,
  loadError,
  now,
  onPatch,
  onReload,
  appId,
  environment,
}: {
  project: EnvProject;
  extras: ProjectExtras | null;
  loading: boolean;
  loadError?: string;
  now: number;
  onPatch: (fn: (d: ProjectExtras) => ProjectExtras) => void;
  onReload: () => Promise<void>;
  /** Set on an app page: the workbench narrows to that app. */
  appId?: string;
  /** The environment the project page's switcher picked; the workbench then shows that one and no switcher of its own. */
  environment?: string;
}) {
  const router = useRouter();
  const viewer = useViewer();
  const can = useCan();
  // Who a preview write is recorded as: the signed-in viewer the page already has.
  const actor: ActorRef = { name: viewer?.name ?? "You", avatarUrl: viewer?.avatarUrl ?? null, kind: "user" };
  const state = extras?.env ?? null;
  const self = appId ? (project.apps.find((a) => a.id === appId) ?? null) : null;
  const envNames = useMemo(() => (state ? state.environments.map((e) => e.name) : project.environments.map((e) => e.name)), [state, project.environments]);
  const [chosenEnv, setChosenEnv] = useState(envNames[0] ?? "production");
  const many = showsEnvironments(envNames);
  const [staged, setStaged] = useState<Staged>(() => new Map());
  const [editing, setEditing] = useState<Editing>(null);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
  const [revealing, setRevealing] = useState<ReadonlySet<string>>(() => new Set());
  const [cache, setCache] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [reviewing, setReviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  /** The changes the last Discard dropped, so the bar in the page can bring them back. */
  const [discarded, setDiscarded] = useState<Staged | null>(null);
  /** The toast that offers the same Undo. Once those changes are no longer the discarded ones (a new
      edit, a restore, a dismiss), it goes too, so its Undo can never overwrite newer work. */
  const discardToast = useRef<{ id: string; before: Staged } | null>(null);
  useEffect(() => {
    const t = discardToast.current;
    if (t && discarded !== t.before) {
      toast.dismiss(t.id);
      discardToast.current = null;
    }
  }, [discarded]);
  /** The key that opened the add row, so Cancel puts the focus back on it. */
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  /** The row an unlink rewrites: its menu key goes, so the focus lands on the row's new Edit key. */
  const unlinkedId = useRef<string | null>(null);
  const undoKey = useRef<HTMLButtonElement>(null);
  const reviewKey = useRef<HTMLButtonElement>(null);
  /** A write the API answered "dangerous" to: the keys to confirm, and the settle of the waiting write. */
  const [hooks, setHooks] = useState<{ keys: string[]; settle: (confirmed: boolean) => void } | null>(null);

  /**
   * Runs one env write. The step-up is `send`'s (components/step-up). A hook-key refusal waits on
   * the confirmation, so the caller sees the confirmed retry's answer and finishes as usual.
   */
  const guarded = async <T extends { ok: boolean }>(run: (confirmDangerous: boolean) => Promise<T>, confirmDangerous = false): Promise<T | null> => {
    const r = await run(confirmDangerous);
    if (!r.ok && "code" in r && r.code === "dangerous") {
      const keys = "keys" in r && Array.isArray(r.keys) ? (r.keys as string[]) : [];
      const confirmed = await new Promise<boolean>((resolve) => setHooks({ keys, settle: resolve }));
      return confirmed ? guarded(run, true) : null;
    }
    return r;
  };
  const [pasteTo, setPasteTo] = useState<Scope | null>(null);
  const [paste, setPaste] = useState<{ text: string; secret: boolean; target: EnvTarget }>({ text: "", secret: true, target: "runtime" });
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [linking, setLinking] = useState<Scope | null>(null);
  const [unlinking, setUnlinking] = useState<{ scope: Scope; row: EnvRow } | null>(null);
  const linkFor = useSearchParams().get("link");

  // An app page always shows the app's own environment.
  const picked = environment && envNames.includes(environment) ? environment : undefined;
  const env = self ? self.environment : (picked ?? (envNames.includes(chosenEnv) ? chosenEnv : (envNames[0] ?? "production")));
  // The page's own switcher already says which environment this is.
  const ownSwitch = !self && many && !picked;
  /** Where a line says the variables live: the environment, or just the project when it shows none. */
  const where = many ? envName(env) : "this project";
  const changes = useMemo(() => [...staged.values()], [staged]);
  const reach = useMemo(() => (state ? affectedApps(changes, state, project.apps) : []), [changes, state, project.apps]);

  // Leaving the page with staged edits asks first; the browser draws its own prompt.
  useEffect(() => {
    if (!staged.size) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [staged.size]);

  // A `?link=<appId>` deep link opens the dialog on that app's overrides once. It is decided while
  // rendering, the way a changed prop is; the effect below then drops the param from the address.
  const [linkSeen, setLinkSeen] = useState<string | null>(null);
  if (linkFor !== linkSeen && (linkFor === null || state)) {
    setLinkSeen(linkFor);
    const app = linkFor ? project.apps.find((a) => a.id === linkFor && READS_ENV.has(a.kind)) : undefined;
    if (app) {
      setChosenEnv(app.environment);
      setAddingFor(app.id);
      setLinking({ environment: app.environment, appId: app.id });
    }
  }
  useEffect(() => {
    if (!state || !linkFor) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("link");
    window.history.replaceState(null, "", url);
  }, [state, linkFor]);

  // A managed service takes its settings from Dockify, so its tab has nothing to edit: one line says so.
  if (self && !READS_ENV.has(self.kind)) {
    return (
      <div className="card">
        <Empty
          icon="key"
          title="Set by Dockify"
          body={`${appTitle(self)} is a managed ${KIND_LABEL[self.kind]} service, so it reads no project variables. Link it into an app from that app’s Variables tab.`}
        />
      </div>
    );
  }
  if (!can.manage) {
    return (
      <div className="card">
        <Empty icon="lock" title="Admins only" body="Variables can hold secrets, so only an admin can see them." />
      </div>
    );
  }
  if (loading) return <Skeleton />;
  if (!state) {
    return (
      <div className="card">
        <Empty
          icon="server"
          title="Variables are unavailable"
          body={loadError ? `${describe([loadError, "Try again in a moment"])}.` : "The Dockify API did not return this project’s variables."}
          action={
            <button type="button" className="btn btn-sm" onClick={() => void onReload()}>
              Try again
            </button>
          }
        />
      </div>
    );
  }
  if (!self && !envNames.length) {
    return (
      <div className="card">
        <Empty icon="box" title="No environments yet" body="This project has no environments yet, so there is nowhere to set variables. Add one in Settings." />
      </div>
    );
  }

  const shared: Scope = { environment: env };
  const sharedRows = rowsOf(varsOf(state, shared), changesIn(staged, shared));
  const envApps = project.apps.filter((a) => a.environment === env && READS_ENV.has(a.kind));
  // On an app page the overrides card is that app alone, shown even before it has any.
  const overrideApps = self
    ? [self]
    : envApps.filter(
        (a) => a.id === addingFor || varsOf(state, { environment: env, appId: a.id }).length > 0 || changesIn(staged, { environment: env, appId: a.id }).length > 0,
      );
  const overriddenBy = (key: string) => envApps.filter((a) => varsOf(state, { environment: env, appId: a.id }).some((v) => v.key === key)).length;
  const sharedKeys = new Set(sharedRows.map((r) => r.key));
  const selfScope: Scope | null = self ? { environment: env, appId: self.id } : null;
  const selfKeys = new Set(selfScope ? rowsOf(varsOf(state, selfScope), changesIn(staged, selfScope)).filter((r) => r.state !== "removed").map((r) => r.key) : []);
  const projectEnvHref = `/projects/${encodeURIComponent(project.slug)}?tab=env`;

  const onStage = (scope: Scope, d: Draft, row?: EnvRow) => {
    const base = varsOf(state, scope).find((v) => v.key === d.key);
    const op = row?.state === "removed" ? "remove" : base ? "change" : "add";
    setStaged((s) => stage(s, { environment: scope.environment, appId: scope.appId, key: d.key, op, value: d.value, secret: d.secret, target: d.target }, base));
    setDiscarded(null);
    setEditing(null);
    if (scope.appId && scope.appId === addingFor) setAddingFor(null);
  };

  const onUnstage = (scope: Scope, key: string) => setStaged((s) => unstage(s, scope, key));

  const flip = (set: ReadonlySet<string>, id: string, on: boolean) => {
    const n = new Set(set);
    if (on) n.add(id);
    else n.delete(id);
    return n;
  };

  /**
   * The stored value of a secret, or what a link resolves to, through the audited reveal. It needs
   * no fresh code; the API logs and rate limits each call. Cached; null when it could not be read.
   */
  const fetchValue = async (scope: Scope, row: EnvRow, purpose: "view" | "copy"): Promise<string | null> => {
    const id = changeId(scope, row.key);
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    if (purpose === "view") setRevealing((s) => flip(s, id, true));
    const r = await send({ type: "env.reveal", slug: project.slug, environment: scope.environment, appId: scope.appId, key: row.key, purpose });
    if (purpose === "view") setRevealing((s) => flip(s, id, false));
    const value = r.ok && r.data && typeof r.data === "object" && "value" in r.data && typeof r.data.value === "string" ? r.data.value : null;
    if (value === null) {
      toast.error(`Could not ${purpose === "copy" ? "copy" : "reveal"} ${row.key}`, { description: describe(r.error ?? "The API sent no value") });
      return null;
    }
    setCache((c) => new Map(c).set(id, value));
    return value;
  };

  const onReveal = async (scope: Scope, row: EnvRow) => {
    const id = changeId(scope, row.key);
    if (shown.has(id)) return setShown((s) => flip(s, id, false));
    if (row.value !== null || cache.has(id)) return setShown((s) => flip(s, id, true));
    if ((await fetchValue(scope, row, "view")) !== null) setShown((s) => flip(s, id, true));
  };

  /** Copies without unmasking: the row's own value, else one fetched through the reveal. Rejects so the key reads "Copy failed". */
  const onCopy = async (scope: Scope, row: EnvRow): Promise<string> => {
    if (row.value !== null && !row.ref) return row.value;
    const value = await fetchValue(scope, row, "copy");
    if (value === null) throw new Error("Not readable");
    return value;
  };

  /** Stages the links the dialog picked. A key already set in the scope is replaced by its link. */
  const onLink = (scope: Scope, picks: LinkPick[]) => {
    setStaged((s) => {
      let out = new Map(s);
      for (const p of picks) {
        const base = varsOf(state, scope).find((v) => v.key === p.key);
        out = stage(out, { environment: scope.environment, appId: scope.appId, key: p.key, op: base ? "change" : "add", ref: p.ref, secret: true, target: p.target }, base);
      }
      return out;
    });
    setLinking(null);
    setDiscarded(null);
    if (scope.appId && scope.appId === addingFor) setAddingFor(null);
    const svc = project.apps.find((a) => a.id === picks[0]?.ref.resourceId);
    toast.success(picks.length === 1 ? "Variable linked" : "Variables linked", {
      description: `${plural(picks.length, "variable")} from ${project.slug} / ${svc ? appTitle(svc) : "service"} in ${scopeName(scope, project.apps, many)}. Review to apply.`,
    });
  };

  /** Unlink keeps what the link resolves to now, as a plain secret. Throws so the confirm stays open. */
  const unlink = async () => {
    if (!unlinking) return;
    const { scope, row } = unlinking;
    const value = await fetchValue(scope, row, "view");
    if (value === null) throw new Error("No value");
    onStage(scope, { key: row.key, value, secret: true, target: row.target }, row);
    setUnlinking(null);
    toast.success("Variable unlinked", { description: `${row.key} in ${scopeName(scope, project.apps, many)} now holds its own value. Review to apply.` });
  };

  /** Puts discarded changes back, from the bar in the page or from the toast. */
  const restore = (before: Staged) => {
    setStaged(before);
    setDiscarded(null);
    requestAnimationFrame(() => reviewKey.current?.focus());
  };

  // Discarding keeps an Undo in the page as well as in the toast, so taking it back never races a timer.
  const discard = () => {
    const before = staged;
    setStaged(new Map());
    setEditing(null);
    setDiscarded(before);
    requestAnimationFrame(() => undoKey.current?.focus());
    const id = toast("Changes discarded", {
      description: `${plural(before.size, "pending change")} in ${project.slug}`,
      action: { label: "Undo", onClick: () => restore(before) },
    });
    discardToast.current = { id, before };
  };

  /** Dismissing that bar puts the focus on the first card's title, where the list starts. */
  const dismissDiscarded = () => {
    setDiscarded(null);
    requestAnimationFrame(() => {
      const h = document.getElementById("px-shared-title") ?? document.getElementById("px-over-title");
      if (!h) return;
      h.tabIndex = -1;
      h.focus();
    });
  };

  const forget = (keys: string[]) => {
    setCache((c) => new Map([...c].filter(([k]) => !keys.includes(k))));
    setShown((s) => new Set([...s].filter((k) => !keys.includes(k))));
  };

  const apply = async (redeploy: boolean) => {
    if (applying || !changes.length) return;
    setApplying(true);
    const next = state.version + 1;
    // The api redeploys only what has deployed; a first deploy is still the owner's to start.
    const n = redeploy ? reach.filter((a) => a.app.lastDeployment).length : 0;
    const r = await guarded((confirmDangerous) =>
      track(send({ type: "env.apply", slug: project.slug, baseVersion: state.version, changes, redeploy, ...(confirmDangerous ? { confirmDangerous } : {}) }), {
        loading: "Applying changes",
        success: "Changes applied",
        error: "Could not apply the changes",
        what: describe([`${project.slug}, version ${next.toLocaleString("en-US")}`, n ? `${plural(n, "app")} redeploying` : "No redeploy"]),
        action: () => (n ? { label: "View", onClick: () => router.push("/deployments") } : undefined),
      }),
    );
    setApplying(false);
    if (!r) return;
    if (!r.ok) {
      if ("code" in r && r.code === "conflict") void onReload();
      return;
    }
    const applied = changes;
    forget(applied.map((c) => changeId(c, c.key)));
    setStaged(new Map());
    setReviewing(false);
    if (r.source === "api") {
      void onReload();
      return;
    }
    const version = versionOf(applied, state, project.apps, next, actor, n);
    onPatch((d) => ({
      ...d,
      env: d.env && applyLocal(d.env, applied, project.apps, next, actor.name),
      versions: d.versions && [version, ...d.versions],
    }));
  };

  const rollback = async (version: number, redeploy: boolean) => {
    const next = state.version + 1;
    const r = await guarded((confirmDangerous) =>
      track(send({ type: "env.rollback", slug: project.slug, version, baseVersion: state.version, redeploy, ...(confirmDangerous ? { confirmDangerous } : {}) }), {
        loading: `Rolling back to v${version}`,
        success: "Variables rolled back",
        error: "Could not roll back",
        what: `${project.slug}, version ${version.toLocaleString("en-US")} restored as ${next.toLocaleString("en-US")}`,
      }),
    );
    if (!r) return false;
    if (!r.ok) {
      if ("code" in r && r.code === "conflict") void onReload();
      return false;
    }
    setStaged(new Map());
    setDiscarded(null);
    setCache(new Map());
    setShown(new Set());
    if (r.source === "api") {
      void onReload();
      return true;
    }
    // The preview cannot rebuild an old version's values, so it records the rollback only.
    const entry: EnvVersion = { version: next, at: new Date().toISOString(), actor: actor.name, actorAvatarUrl: actor.avatarUrl, actorKind: actor.kind, source: "rollback", restoredFrom: version, changes: [], redeployed: redeploy ? envApps.length : 0 };
    onPatch((d) => ({ ...d, env: d.env && { ...d.env, version: next }, versions: d.versions && [entry, ...d.versions] }));
    return true;
  };

  const parsed = parseDotenv(paste.text);
  const openPaste = (scope: Scope) => {
    setPaste({ text: "", secret: true, target: "runtime" });
    setPasteTo(scope);
  };
  const stagePaste = () => {
    if (!parsed.vars.length || !pasteTo) return;
    const scope = pasteTo;
    setStaged((s) => {
      let out = new Map(s);
      for (const v of parsed.vars) {
        const base = varsOf(state, scope).find((x) => x.key === v.key);
        out = stage(out, { environment: scope.environment, appId: scope.appId, key: v.key, op: base ? "change" : "add", value: v.value, secret: paste.secret && !isPublicBuildKey(v.key), target: paste.target }, base);
      }
      return out;
    });
    setPasteTo(null);
    setDiscarded(null);
    if (scope.appId && scope.appId === addingFor) setAddingFor(null);
    toast.success(parsed.vars.length === 1 ? "Variable staged" : "Variables staged", {
      description: `${plural(parsed.vars.length, "variable")} in ${project.slug}, ${scopeName(scope, project.apps, many)}. Review to apply.`,
    });
  };

  const link = (r: EnvRow) => {
    if (!r.ref) return undefined;
    const view = r.change?.ref || !r.base?.ref ? refViewOf(r.ref, project.apps) : r.base.ref;
    return { text: refText(project.slug, r.ref, view), missing: view.missing };
  };
  const rowsProps = {
    now,
    editing,
    shown,
    revealing,
    cache,
    link,
    onEditing: setEditing,
    onStage,
    onUnstage,
    onReveal: (s: Scope, r: EnvRow) => void onReveal(s, r),
    onCopy,
    onUnlink: (scope: Scope, row: EnvRow) => {
      unlinkedId.current = changeId(scope, row.key);
      setUnlinking({ scope, row });
    },
    // After the add row closes the key that opened it is enabled again, one render later.
    onBack: () => {
      requestAnimationFrame(() => {
        if (opener?.isConnected && !opener.matches(":disabled")) opener.focus();
        else document.getElementById("main")?.focus({ preventScroll: true });
      });
    },
  };
  const linkTaken = (scope: Scope) => rowsOf(varsOf(state, scope), changesIn(staged, scope)).filter((r) => r.state !== "removed").map((r) => r.key);
  const unlinkFrom = unlinking ? (link(unlinking.row)?.text.split(", ")[0] ?? "the service") : "the service";
  const envCount = (name: string) => varsOf(state, { environment: name }).length;
  const filterShown = sharedRows.length > FILTER_AT || query;
  const q = query.trim().toLowerCase();
  const sharedShown = matching(sharedRows, q);
  const takenIn = (rows: EnvRow[]) => rows.filter((r) => r.state !== "removed").map((r) => r.key);

  // Overrides: one table, ordered by app name, then key.
  const byName = (a: AppSummary, b: AppSummary) => appTitle(a).localeCompare(appTitle(b));
  const overrides = [...overrideApps]
    .sort(byName)
    .map((a) => {
      const scope: Scope = { environment: env, appId: a.id };
      const rows = rowsOf(varsOf(state, scope), changesIn(staged, scope)).sort((x, y) => x.key.localeCompare(y.key));
      return { app: a, scope, rows, shown: matching(rows, q) };
    });
  const addingIn = (scope: Scope) => editing?.scope === changeId(scope, "") && editing.key === null;
  const overrideMiss = Boolean(q) && overrides.some((g) => g.rows.length) && overrides.every((g) => !g.shown.length && !addingIn(g.scope));
  const matchCount = sharedShown.length + overrides.reduce((n, g) => n + g.shown.length, 0);
  const startAdd = (scope: Scope) => {
    setOpener(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setEditing({ scope: changeId(scope, ""), key: null });
  };
  const addOverride = (id: string) => {
    setAddingFor(id);
    startAdd({ environment: env, appId: id });
  };
  // The head keys, always in the card head. On the project tab each opens the menu of apps first.
  const appItems = (run: (id: string) => void): RowMenuItem[] =>
    [...envApps].sort(byName).map((a) => ({ label: appTitle(a), glyph: <AppIcon id={a.id} kind={a.kind} />, onSelect: () => run(a.id) }));
  const overrideActs =
    self && selfScope ? (
      <span className="pd-hd-acts">
        <button type="button" className="btn btn-sm" onClick={() => openPaste(selfScope)}>
          Paste .env
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setLinking(selfScope)}>
          Link a service
        </button>
        <button type="button" className="btn btn-sm" disabled={addingIn(selfScope)} onClick={() => addOverride(self.id)}>
          Add override
        </button>
      </span>
    ) : envApps.length ? (
      <span className="pd-hd-acts">
        <RowMenu text="Link a service" label="Link a service for an app" items={appItems((id) => setLinking({ environment: env, appId: id }))} />
        <RowMenu text="Add override" label="Add an override for an app" items={appItems(addOverride)} />
      </span>
    ) : null;

  // One empty state at most: with nothing shared, the shared card (or, on an app page, the overrides
  // card) holds it, the other card keeps only its head, and an empty history stays out of the way.
  const noOverrides = overrides.every((g) => !g.rows.length && !addingIn(g.scope));
  const sharedCard = !self || sharedRows.length > 0;
  let overridesBody: React.ReactNode = null;
  if (noOverrides && self) {
    overridesBody = sharedRows.length ? (
      <Empty icon="layers" title="No overrides yet" body={`${self.name} reads the shared variables as they are. Add an override when it needs its own value.`} />
    ) : (
      <Empty
        icon="key"
        title="No variables yet"
        body={`Nothing is set for ${self.name}${many ? ` in ${envName(env)}` : ""}. Add an override here, or set shared variables on the project’s Variables tab.`}
        action={
          <Link href={projectEnvHref} className="btn btn-sm">
            Open project variables
          </Link>
        }
      />
    );
  } else if (noOverrides) {
    overridesBody = sharedRows.length ? (
      <Empty
        icon="layers"
        title="No overrides yet"
        body={envApps.length ? "Every app reads the shared variables as they are. Add an override when one app needs its own value." : `No app in ${where} reads variables yet.`}
      />
    ) : null;
  } else {
    overridesBody = (
      <div className="ev-vars-wrap">
        <EnvTableHead targets app={!self} />
        <ul className="ev-vars" aria-label={self ? `${appTitle(self)} overrides` : "App overrides"}>
          {overrides.map((g) => (
            <ScopeItems
              key={g.app.id}
              scope={g.scope}
              rows={g.shown}
              taken={takenIn(g.rows)}
              app={self ? undefined : { name: appTitle(g.app), icon: <AppIcon id={g.app.id} kind={g.app.kind} /> }}
              notes={(key) => (sharedKeys.has(key) ? "Overrides shared" : undefined)}
              {...rowsProps}
            />
          ))}
        </ul>
        {overrideMiss ? <NoMatch query={query} onClear={() => setQuery("")} /> : null}
      </div>
    );
  }
  const versions = extras?.versions ?? null;

  return (
    <div className="pd-stack">
      {staged.size ? (
        <div className="px-pending" role="status">
          <span className="px-pending-dot dot" data-tone="warn" aria-hidden="true" />
          <span className="two">
            <span className="two-main">{plural(staged.size, "pending change")}</span>
            <span className="two-sub">{reach.length ? `Reaches ${plural(reach.length, "app")}, nothing is sent until you apply` : "Nothing is sent until you apply"}</span>
          </span>
          <span className="px-pending-acts">
            <button type="button" className="btn btn-sm" onClick={discard}>
              Discard
            </button>
            <button ref={reviewKey} type="button" className="btn btn-sm btn-primary" onClick={() => setReviewing(true)}>
              <Icon name="list" />
              Review
            </button>
          </span>
        </div>
      ) : discarded ? (
        <div className="px-pending" data-quiet="" role="status">
          <span className="two">
            <span className="two-main">{plural(discarded.size, "pending change")} discarded</span>
            <span className="two-sub">Nothing was sent</span>
          </span>
          <span className="px-pending-acts">
            <button type="button" className="btn btn-sm" onClick={dismissDiscarded}>
              Dismiss
            </button>
            <button ref={undoKey} type="button" className="btn btn-sm" onClick={() => restore(discarded)}>
              Undo
            </button>
          </span>
        </div>
      ) : null}

      {ownSwitch || filterShown ? (
        <div className="px-env-tools">
          <div className="toolbar">
            {ownSwitch ? (
              <Segmented
                label="Environment"
                value={env}
                onChange={(v) => {
                  setChosenEnv(v);
                  setEditing(null);
                  setAddingFor(null);
                }}
                options={filterOptions(envNames.map((n) => ({ value: n, label: envName(n), count: envCount(n) })))}
              />
            ) : null}
            {filterShown ? <SearchField value={query} onChange={setQuery} label="Search variables" placeholder="Search keys" className="px-env-filter" /> : null}
            {q ? <ResultCount count={matchCount} one="variable" query={query} /> : null}
          </div>
          <Rule />
        </div>
      ) : null}

      {sharedCard ? (
        <section className="card" aria-labelledby="px-shared-title">
          <div className="card-hd">
            <CardTitle
              id="px-shared-title"
              icon="key"
              title={many ? `${envName(env)}, shared` : "Shared variables"}
              sub={`${plural(sharedRows.filter((r) => r.state !== "added").length, "variable")} every app in ${where} reads, version ${state.version.toLocaleString("en-US")}`}
            />
            {self ? (
              <Link href={projectEnvHref} className="btn btn-sm">
                Edit in project
              </Link>
            ) : (
              <span className="pd-hd-acts">
                <button type="button" className="btn btn-sm" onClick={() => openPaste(shared)}>
                  Paste .env
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setLinking(shared)}>
                  Link a service
                </button>
                <button type="button" className="btn btn-sm" onClick={() => startAdd(shared)}>
                  Add variable
                </button>
              </span>
            )}
          </div>
          {sharedRows.length === 0 && !addingIn(shared) ? (
            <Empty icon="key" title="No variables yet" body={`Nothing is set for ${where} yet. Add one, or paste a .env file to stage many at once.`} />
          ) : (
            <div className="ev-vars-wrap">
              <EnvTableHead targets />
              <ul className="ev-vars" aria-label="Shared variables">
                <ScopeItems
                  scope={shared}
                  rows={sharedShown}
                  taken={takenIn(sharedRows)}
                  readOnlyHref={self ? projectEnvHref : undefined}
                  notes={(key) => {
                    if (self) return selfKeys.has(key) ? "Overridden here" : undefined;
                    const n = overriddenBy(key);
                    return n ? `Overridden in ${plural(n, "app")}` : undefined;
                  }}
                  {...rowsProps}
                />
              </ul>
              {q && !sharedShown.length && sharedRows.length ? <NoMatch query={query} onClear={() => setQuery("")} /> : null}
            </div>
          )}
        </section>
      ) : null}

      <section className="card" aria-labelledby="px-over-title">
        <div className="card-hd">
          <CardTitle
            id="px-over-title"
            icon="layers"
            title="App overrides"
            sub={self ? `Values only ${appTitle(self)} reads${many ? ` in ${envName(env)}` : ""}, winning over the shared ones` : `Per-app values in ${where} that win over the shared ones`}
          />
          {overrideActs}
        </div>
        {overridesBody}
      </section>

      {/* History is the whole project's, rolled back as one, so it stays on the project tab. */}
      {!self && !(versions && versions.length === 0) ? (
        <HistoryCard versions={versions} error={extras?.versionsError} loading={false} current={state.version} now={now} pending={staged.size} many={many} onRollback={rollback} />
      ) : null}

      <ReviewDialog
        many={many}
        key={reviewing ? "open" : "closed"}
        open={reviewing}
        onClose={() => setReviewing(false)}
        changes={changes}
        state={state}
        apps={project.apps}
        busy={applying}
        onApply={(redeploy) => void apply(redeploy)}
      />

      {linking ? (
        <LinkResourceDialog
          open
          onClose={() => {
            if (linking.appId && linking.appId === addingFor) setAddingFor(null);
            setLinking(null);
          }}
          slug={project.slug}
          environment={linking.environment}
          where={scopeName(linking, project.apps, many)}
          apps={project.apps}
          taken={linkTaken(linking)}
          forApp={linking.appId ?? self?.id}
          onLink={(picks) => onLink(linking, picks)}
        />
      ) : null}

      <ConfirmDialog
        open={unlinking !== null}
        onClose={() => setUnlinking(null)}
        onConfirm={unlink}
        title={`Unlink ${unlinking?.row.key ?? "variable"}`}
        body={`It keeps the value it resolves to now, as a plain secret, and stops following ${unlinkFrom}, so a rotated password no longer reaches the app. Reading the value is written to the activity log.`}
        confirmLabel="Unlink variable"
        confirmIcon="link"
        returnFocus={() => (unlinkedId.current ? lastKey(unlinkedId.current) : null)}
      />

      <ConfirmDialog
        open={hooks !== null}
        onClose={() => {
          hooks?.settle(false);
          setHooks(null);
        }}
        onConfirm={() => {
          hooks?.settle(true);
          setHooks(null);
        }}
        tone="danger"
        title="This changes how the process starts"
        body={`${(hooks?.keys ?? []).join(", ")} ${hooks && hooks.keys.length > 1 ? "are" : "is"} read by the runtime before your code runs: it can load other code into the app. Set it only if you put it there yourself. The activity log records this.`}
        confirmLabel={hooks && hooks.keys.length === 1 ? `Set ${hooks.keys[0]} anyway` : "Set these keys anyway"}
        confirmIcon="alert"
      />

      <Dialog
        open={pasteTo !== null}
        onClose={() => setPasteTo(null)}
        size="lg"
        icon="key"
        title="Paste .env"
        sub={`Stages every KEY=VALUE line in ${pasteTo ? scopeName(pasteTo, project.apps, many) : many ? `${envName(env)}, shared` : "the shared variables"}. Nothing is sent until you apply.`}
        onSubmit={stagePaste}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setPasteTo(null)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!parsed.vars.length}>
              <Icon name="check" />
              {parsed.vars.length ? `Stage ${plural(parsed.vars.length, "variable")}` : "Stage variables"}
            </button>
          </>
        }
      >
        <Field
          label="Contents"
          error={paste.text.trim() && !parsed.vars.length ? "No KEY=VALUE lines found" : null}
          hint={
            paste.text.trim()
              ? `${plural(parsed.vars.length, "variable")} found${parsed.skipped ? `, ${plural(parsed.skipped, "line")} skipped` : ""}`
              : "Comments and blank lines are ignored. Existing keys are replaced."
          }
        >
          {(ids) => (
            <TextArea
              ids={ids}
              className="pd-mono"
              rows={10}
              data-autofocus
              spellCheck={false}
              placeholder={"DATABASE_URL=postgres://...\nAPI_KEY=..."}
              value={paste.text}
              onChange={(e) => setPaste((p) => ({ ...p, text: e.target.value }))}
            />
          )}
        </Field>
        <div className="px-paste-opts">
          <Field label="Used at">
            {(ids) => <Select ids={ids} label="Used at" value={paste.target} options={TARGET_OPTIONS} onChange={(target) => setPaste((p) => ({ ...p, target }))} />}
          </Field>
          <label className="px-inline-switch px-paste-secret">
            <Switch checked={paste.secret} onChange={(secret) => setPaste((p) => ({ ...p, secret }))} label="Mark all as secret" />
            <span aria-hidden="true">Mark all as secret</span>
          </label>
        </div>
      </Dialog>
    </div>
  );
}
