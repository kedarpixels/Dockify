/**
 * PR feedback through the GitHub App: one sticky comment per pull request and one commit status on
 * the head commit, updated in place. The worker is the only writer and renders what the row says now.
 */
import { appLabel, projects as P } from "@dockify/contracts";
import type { Db, PreviewStatus, SecretVault, ShownAppIconRow } from "@dockify/db";
import { utcTime } from "@dockify/email";
import { jsonOf, type HttpClient } from "@dockify/net-guard";
import { installationCredential } from "../deploy/github.ts";
import { failureLines } from "../deploy/preview.ts";
import { mailIconLinks, mailIconSigner, SHOWN_APP_ICON, SHOWN_PROJECT_ICON } from "../icons/mail.ts";

export const COMMENT_MARK = "<!-- dockify-preview -->";
export const STATUS_CONTEXT = "Dockify preview";

export interface FeedbackView {
  prNumber: number;
  status: PreviewStatus;
  reason: string | null;
  error: string | null;
  /** The last build lines of the failed deployment, as stored (redacted); not yet safe for markdown. */
  lines: string[];
  updatedAt: Date;
  fromFork: boolean;
  isolatedDb: boolean;
  isolation: P.PreviewIsolation;
  /** The URL asks for the project's preview password. The comment says so and never holds the password. */
  passwordProtected?: boolean;
  baseEnvironment: string;
  apps: Array<{ name: string; url: string | null; icon?: string | null }>;
  dashboardUrl: string | null;
  idleMinutes: number;
  ttlHours: number;
}

const REASON: Record<string, string> = {
  merged: "the pull request was merged",
  closed: "the pull request was closed",
  ttl: "nothing was pushed for the TTL",
  disabled: "previews were turned off for this project",
  deleted: "it was deleted from the dashboard",
  evicted: "it was evicted to make room for a newer pull request (push to bring it back)",
};

/**
 * A build error is tenant-controlled and is posted under the Dockify App's identity. Collapse it to
 * one line and strip anything that linkifies, mentions or breaks out of a code span, so a PR author
 * cannot forge a link or mention in the bot's voice. This also keeps the plain text status safe.
 */
export function safeError(s: string | null | undefined, fallback: string): string {
  if (!s) return fallback;
  const clean = s
    .replace(/\s+/g, " ")
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/[`@<>[\]!]/g, "")
    .trim();
  return clean || fallback;
}

const LOG_LINE_CHARS = 240;
export const LOG_LINES = 12;

/** No link, no mention, nothing that ends the code block; brackets stay so the error stays readable. */
export function inertLine(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link]")
    .replace(/[`@<>]/g, "")
    .replace(/\]\(/g, "] (")
    .trim()
    .slice(0, LOG_LINE_CHARS);
}

export const inertText = (s: string): string => inertLine(s).replace(/\s+/g, " ");

const PLACE = /^(Dockerfile[\w.-]*):(\d{1,6})$/;
/** A failed RUN repeats its whole command in BuildKit's last line; the frame above already shows it. */
const FAILED_RUN = /failed to solve: process ".*did not complete successfully: exit code: (\d+)/;
const EMPTY_FRAME = /^\d+ \|\s*$/;

/** Names the place when the output does; our own "buildctl" wording stays out, here and in the status. */
export function failureSummary(v: Pick<FeedbackView, "error" | "lines">): { sentence: string; lines: string[] } {
  const head = v.error ? inertLine(v.error) : "";
  const ours = /\bbuildctl\b/.test(head);
  const tail = v.lines.slice(-LOG_LINES).map(inertLine).filter(Boolean);
  const place = tail.map((l) => PLACE.exec(l)).find(Boolean);
  const sentence = place ? `Build failed at ${place[1]} line ${place[2]}.` : ours ? "Build failed." : "Preview failed.";
  const lines = [...(ours ? [] : [head]), ...tail]
    .filter((l) => l && !PLACE.test(l) && !EMPTY_FRAME.test(l))
    .map((l) => {
      const run = FAILED_RUN.exec(l);
      return run ? `The command exited with code ${run[1]}` : l;
    });
  return { sentence, lines };
}

export function failedStatusText(v: Pick<FeedbackView, "error" | "lines">): string {
  const first = v.error?.split(/\r?\n/)[0];
  return `Failed: ${/\bbuildctl\b/.test(first ?? "") ? failureSummary(v).sentence : safeError(first, "see the deploy log")}`;
}

/** GitHub caps the description at 140 characters. */
export function statusFor(v: FeedbackView): { state: "pending" | "success" | "failure" | "error"; description: string; target: string | null } {
  const url = v.apps.find((a) => a.url)?.url ?? null;
  const cut = (s: string) => (s.length > 140 ? `${s.slice(0, 137)}...` : s);
  switch (v.status) {
    case "building":
      return { state: "pending", description: `Building pr-${v.prNumber}`, target: v.dashboardUrl };
    case "ready":
      return { state: "success", description: cut(url ? `Ready at ${url}` : "Ready"), target: url ?? v.dashboardUrl };
    case "asleep":
      return { state: "success", description: "Asleep, push or press Wake", target: v.dashboardUrl };
    case "failed":
      return { state: "failure", description: cut(failedStatusText(v)), target: v.dashboardUrl };
    case "blocked":
      return { state: "error", description: cut(`Not started: ${safeError(v.error ?? v.reason, "blocked")}`), target: v.dashboardUrl };
    default:
      return { state: "success", description: cut(`Deleted: ${REASON[v.reason ?? ""] ?? "the preview was removed"}`), target: v.dashboardUrl };
  }
}

/** The Deployment column: a dot and a word, so it reads the same in a GitHub email as on the pull request. */
const STATE: Partial<Record<PreviewStatus, [string, string]>> = {
  building: ["🟠", "Building"],
  ready: ["🟢", "Ready"],
  asleep: ["⚪", "Asleep"],
  failed: ["🔴", "Failed"],
  blocked: ["⚪", "Not started"],
};

function actionFor(v: FeedbackView, url: string | null): string {
  if (url) return `[${v.status === "ready" ? "Preview" : "Previous build"}](${url})`;
  return v.status === "ready" ? "No public URL" : "";
}

/** GitHub mails a comment on creation, not on edit, so the first waits for a result (firstCommentNow). */
export function commentFor(v: FeedbackView): string {
  const [dot, word] = STATE[v.status] ?? ["⚪", "Removed"];
  const state = v.dashboardUrl ? `${dot} [${word}](${v.dashboardUrl})` : `${dot} ${word}`;
  const updated = utcTime(v.updatedAt).replace(/ UTC$/, "");
  const apps: FeedbackView["apps"] = v.apps.length ? v.apps : [{ name: `pr-${v.prNumber}`, url: null }];
  const project = (a: FeedbackView["apps"][number]) => `${a.icon ? `<img src="${a.icon}" alt="" width="16" height="16"> ` : ""}${safeError(a.name, "app").replace(/\|/g, "")}`;
  const lines = [
    COMMENT_MARK, "The latest preview of this pull request.", "",
    "| Project | Deployment | Actions | Updated (UTC) |",
    "| :--- | :--- | :--- | :--- |",
    ...apps.map((a) => `| ${project(a)} | ${state} | ${actionFor(v, a.url)} | ${updated} |`),
  ];
  if (v.status === "failed") {
    const { sentence, lines: block } = failureSummary(v);
    lines.push("", sentence, "", "```text", ...(block.length ? block : ["See the deploy log."]), "```");
  } else if (v.status === "blocked") {
    lines.push("", `Not started: \`${safeError(v.error ?? v.reason, "blocked")}\`.`);
  } else if (v.status === "closed" || v.status === "closing") {
    lines.push("", `Removed: ${REASON[v.reason ?? ""] ?? "the preview was removed"}.`);
    return lines.join("\n");
  }
  const notes: string[] = [];
  if (v.passwordProtected && v.apps.some((a) => a.url)) notes.push("Password protected: ask a project admin, or find it in Dockify's preview settings.");
  if (v.fromFork) notes.push("Built from a fork, without any secret.");
  if (v.isolation === "own") notes.push("Runs without production's secrets and services, so an app that needs them fails here.");
  if (v.isolatedDb) notes.push("Uses its own temporary database, separate from your real data.");
  else if (v.isolation === "base") notes.push(v.baseEnvironment ? `Uses the ${v.baseEnvironment} environment's services.` : "Uses the project's services.");
  if (notes.length) lines.push("", `<sub>${notes.join(" ")}</sub>`);
  return lines.join("\n");
}

export const firstCommentNow = (status: PreviewStatus): boolean => status === "ready" || status === "failed" || status === "blocked";

export interface FeedbackDeps {
  db: Db;
  vault: SecretVault;
  http: HttpClient;
  apiBase: string;
  publicUrl: string | null;
  internalToken?: string | undefined;
}

export class FeedbackError extends Error {
  readonly permanent: boolean;
  constructor(message: string, permanent: boolean) {
    super(message);
    this.permanent = permanent;
  }
}

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** Without a GitHub App installation there is nobody to tell: a no-op. */
export async function runPreviewFeedback(deps: FeedbackDeps, payload: unknown): Promise<void> {
  const id = (payload as { previewId?: unknown } | null)?.previewId;
  if (typeof id !== "string") throw new FeedbackError("preview_feedback payload has no previewId", true);
  const env = await deps.db.previewEnv.findUnique({
    where: { id },
    select: {
      prNumber: true, status: true, reason: true, error: true, commitSha: true, fromFork: true, isolatedDb: true, repo: true, commentId: true, updatedAt: true,
      baseEnvironment: { select: { name: true } },
      project: { select: { ...SHOWN_PROJECT_ICON, slug: true, previewIdleMinutes: true, previewTtlHours: true, previewAccess: true, previewProductionAccess: true, environments: { select: { ...SHOWN_PROJECT_ICON.environments.select, id: true } }, gitInstallation: { select: { installationId: true } } } },
      apps: {
        orderBy: { createdAt: "asc" },
        select: {
          hostname: true, currentDeploymentId: true,
          app: { select: { ...SHOWN_APP_ICON, name: true, displayName: true, port: true, gitInstallation: { select: { installationId: true } } } },
          deployments: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, error: true } },
        },
      },
    },
  });
  if (!env || !REPO.test(env.repo)) return;
  // An app created in the dashboard holds the installation itself; older projects hold it on the project.
  const installation = env.apps.map((a) => a.app.gitInstallation?.installationId).find((i) => i !== undefined) ?? env.project.gitInstallation?.installationId ?? null;
  if (installation === null) return;
  const cred = await installationCredential({ db: deps.db, vault: deps.vault, apiBase: deps.apiBase }, installation, "github.com");
  if (!cred) return;

  const live = ["building", "ready", "failed"].includes(env.status);
  const failedBuild = env.apps.map((a) => a.deployments[0]).find((d) => d?.status === "failed");
  // An SVG icon has no link (mailIconLinks), so the row falls through to the project's icon or the
  // Dockify mark. Only over https: GitHub's image proxy fetches nothing else.
  const origin = deps.publicUrl && /^https:\/\//.test(deps.publicUrl) ? deps.publicUrl.replace(/\/+$/, "") : undefined;
  const signer = mailIconSigner(deps.internalToken);
  const iconOf = (app: ShownAppIconRow): string | null => {
    const links = mailIconLinks(origin, signer, app, env.project);
    return links.appIcon ?? links.projectIcon ?? (origin ? `${origin}/dockify-github-app-logo.png` : null);
  };
  const view: FeedbackView = {
    prNumber: env.prNumber, status: env.status, reason: env.reason, error: env.error, lines: failureLines(failedBuild?.error ?? null), updatedAt: env.updatedAt, fromFork: env.fromFork,
    isolatedDb: env.isolatedDb, isolation: P.previewIsolation(env), passwordProtected: env.project.previewAccess === "password",
    baseEnvironment: env.project.environments.length > 1 ? env.baseEnvironment.name : "",
    // Only what answers gets a link: a first build that failed serves nothing.
    apps: env.apps.map((a) => ({ name: appLabel(a.app), url: a.app.port !== null && live && a.currentDeploymentId ? `https://${a.hostname}` : null, icon: iconOf(a.app) })),
    dashboardUrl: deps.publicUrl ? `${deps.publicUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(env.project.slug)}?tab=previews` : null,
    idleMinutes: env.project.previewIdleMinutes, ttlHours: env.project.previewTtlHours,
  };

  const call = async (method: "GET" | "POST" | "PATCH", path: string, body?: unknown) => {
    const res = await deps.http({
      method,
      url: `${deps.apiBase}${path}`,
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", Authorization: `Bearer ${cred.secret}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      timeoutMs: 15_000,
    });
    return res;
  };
  const [owner, repo] = env.repo.split("/") as [string, string];
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  const body = commentFor(view);
  let commentId = env.commentId;
  if (commentId) {
    const r = await call("PATCH", `${base}/issues/comments/${encodeURIComponent(commentId)}`, { body });
    if (r.status === 404) commentId = null;
    else if (r.status >= 500 || r.status === 429) throw new FeedbackError(`GitHub answered ${r.status} updating the preview comment`, false);
  }
  if (!commentId && firstCommentNow(env.status)) {
    const r = await call("POST", `${base}/issues/${env.prNumber}/comments`, { body });
    if (r.status >= 500 || r.status === 429) throw new FeedbackError(`GitHub answered ${r.status} posting the preview comment`, false);
    const made = r.status === 201 ? jsonOf<{ id: number }>(r) : null;
    if (made?.id) await deps.db.previewEnv.update({ where: { id }, data: { commentId: String(made.id) } });
  }
  if (env.commitSha && /^[0-9a-f]{40}$/.test(env.commitSha)) {
    const s = statusFor(view);
    const r = await call("POST", `${base}/statuses/${env.commitSha}`, {
      state: s.state, description: s.description, context: STATUS_CONTEXT, ...(s.target && /^https:\/\//.test(s.target) ? { target_url: s.target } : {}),
    });
    if (r.status >= 500 || r.status === 429) throw new FeedbackError(`GitHub answered ${r.status} setting the commit status`, false);
  }
  await deps.db.previewEnv.update({ where: { id }, data: { feedbackAt: new Date() } });
}
