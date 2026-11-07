import "server-only";
import { buildPreviewDay, buildPreviewOverview } from "@/lib/preview-fixture";
import { previewVercelRows, previewVercelSteps, previewVercelLog } from "@/lib/preview-vercel";
import { PREVIEW_OWNER } from "@/lib/preview-owner";
import type { AppKind, RecentDeployment } from "@/lib/types";
import type { DeploymentDetail, DeploymentPage, DeploymentQuery, DeploymentStats, DeploymentStep, LogLine, StepId, StepStatus } from "./deployments";
import { hex, seeded } from "@/lib/preview-random";

/*
 * Design preview fixture for the deployments pages, used only when DOCKIFY_PREVIEW=1 and no API
 * is set. Derived from buildPreviewOverview so every row on the Overview opens a working page
 * here: the recent rows keep their ids (dpl_0 up), and older days come from buildPreviewDay
 * (dpl_YYYYMMDD_i).
 */

const STEPS: StepId[] = ["queued", "clone", "build", "push", "release", "deploy", "health"];
const PAGE = 25;

const IN_FLIGHT = new Set(["queued", "building", "deploying"]);
const DAY = 86_400_000;

function previewRows(now: Date): RecentDeployment[] {
  const o = buildPreviewOverview(now);
  const recent = o.recentDeployments;
  const oldestDay = recent.reduce((m, d) => (d.createdAt < m ? d.createdAt : m), now.toISOString()).slice(0, 10);
  const rows = [...recent];
  for (const d of o.deployTrend) if (d.date < oldestDay && d.total) rows.push(...buildPreviewDay(d.date, now));
  return previewVercelRows(rows).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

const wallSeconds = (d: RecentDeployment) => (d.finishedAt ? (Date.parse(d.finishedAt) - Date.parse(d.createdAt)) / 1000 : null);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function matches(d: RecentDeployment, q: DeploymentQuery) {
  const status = q.status ?? "all";
  if (status === "building" && !IN_FLIGHT.has(d.status)) return false;
  if (status !== "all" && status !== "building" && d.status !== status) return false;
  if (q.project && d.projectSlug !== q.project) return false;
  const text = q.q?.trim().toLowerCase();
  if (!text) return true;
  return [d.message, d.app.name, d.app.displayName, d.projectSlug, d.branch, d.commit, `${d.projectSlug} / ${d.app.name}`].some((v) => v?.toLowerCase().includes(text));
}

function previewStats(rows: RecentDeployment[], now: number): DeploymentStats {
  const within = (d: RecentDeployment, from: number, to: number) => {
    const t = Date.parse(d.createdAt);
    return t > now - to && t <= now - from;
  };
  const last = rows.filter((d) => within(d, 0, DAY));
  const prev = rows.filter((d) => within(d, DAY, 2 * DAY));
  const ok = (xs: RecentDeployment[]) => xs.filter((d) => d.status === "ready");
  const secs = (xs: RecentDeployment[]) => ok(xs).map(wallSeconds).filter((s): s is number => s !== null);
  const buckets = Array.from({ length: 12 }, (_, i) => {
    const to = now - (11 - i) * 2 * 3_600_000;
    const slot = rows.filter((d) => Date.parse(d.createdAt) > to - 2 * 3_600_000 && Date.parse(d.createdAt) <= to);
    return { at: new Date(to).toISOString(), ready: ok(slot).length, failed: slot.filter((d) => d.status === "failed").length, medianSeconds: median(secs(slot)) };
  });
  return {
    inFlight: rows.filter((d) => IN_FLIGHT.has(d.status)).length,
    queued: rows.filter((d) => d.status === "queued").length,
    succeeded24h: ok(last).length,
    failed24h: last.filter((d) => d.status === "failed").length,
    succeededPrev24h: ok(prev).length,
    failedPrev24h: prev.filter((d) => d.status === "failed").length,
    medianSeconds: median(secs(last)),
    medianPrevSeconds: median(secs(prev)),
    buckets,
  };
}

export function previewPage(query: DeploymentQuery, now: Date): DeploymentPage {
  const rows = previewRows(now);
  const hits = rows.filter((d) => matches(d, query));
  const start = Math.max(0, Number(query.cursor?.replace(/^o:/, "") ?? 0) || 0);
  const items = hits.slice(start, start + PAGE);
  return {
    items,
    nextCursor: start + PAGE < hits.length ? `o:${start + PAGE}` : null,
    stats: query.cursor ? undefined : previewStats(rows, now.getTime()),
  };
}

/** Finds a preview row by id: dpl_N from the overview, dpl_YYYYMMDD_i from that day's fixture. */
function previewFind(id: string, now: Date): { row: RecentDeployment; all: RecentDeployment[] } | null {
  if (/^dpl_(?:image_)?\d+$/.test(id)) {
    const row = previewVercelRows(buildPreviewOverview(now).recentDeployments).find((d) => d.id === id);
    return row ? { row, all: previewRows(now) } : null;
  }
  const m = /^dpl_(\d{4})(\d{2})(\d{2})_\d+$/.exec(id);
  if (!m) return null;
  // Day ids also cover days the list leaves to the recent rows (today on the heatmap).
  const day = buildPreviewDay(`${m[1]}-${m[2]}-${m[3]}`, now);
  const row = previewVercelRows(day).find((d) => d.id === id);
  if (!row) return null;
  const all = previewRows(now);
  const known = new Set(all.map((d) => d.id));
  return { row, all: [...all, ...day.filter((d) => !known.has(d.id))] };
}

function hashSeed(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 233280;
}

type Failure = "compile" | "lockfile" | "migration" | "crash" | "timeout";

/** Where a failure stops the pipeline. */
const FAIL_STEP: Record<Failure, StepId> = { compile: "build", lockfile: "build", migration: "deploy", crash: "health", timeout: "health" };

/** The overview's three failures are fixed; day rows draw one from their id. */
function failureOf(d: RecentDeployment, rnd: () => number): Failure {
  if (d.message?.startsWith("Bump Next.js")) return "compile";
  if (d.message?.startsWith("Migrate")) return "migration";
  if (d.app.kind === "bot") return "crash";
  return (["compile", "lockfile", "timeout", "migration"] as const)[Math.floor(rnd() * 4)]!;
}

/** Planned seconds per step for a finished run of `total` seconds; build takes what is left. */
function plan(total: number, rnd: () => number): Record<StepId, number> {
  // Preview apps have no release command, so that step is skipped and takes no time.
  const fixed = { queued: 1 + rnd() * 2, clone: 2 + rnd() * 2, build: 0, push: 5 + rnd() * 4, release: 0, deploy: 3 + rnd() * 3, health: 3 + rnd() * 5 };
  const sum = fixed.queued + fixed.clone + fixed.push + fixed.deploy + fixed.health;
  const k = total < sum * 2 ? (total * 0.5) / sum : 1;
  for (const s of STEPS) fixed[s] *= k;
  fixed.build = total - sum * k;
  return fixed;
}

interface Built {
  detail: DeploymentDetail;
  lines: LogLine[];
  tail: LogLine[];
  done: boolean;
}

/** A deployment on Vercel: its three steps and a short build log, as the mirror and Vercel show them. */
function previewVercelDetail(d: RecentDeployment, all: RecentDeployment[], nowDate: Date): Built {
  const newer = all.some((x) => x.appId === d.appId && x.status === "ready" && x.external?.target === "production" && Date.parse(x.createdAt) > Date.parse(d.createdAt));
  const texts = previewVercelLog(d);
  const created = Date.parse(d.createdAt);
  const lines: LogLine[] = texts.map(([stream, text], i) => ({ seq: i + 1, ts: new Date(created + i * 1_500).toISOString(), stream, text }));
  const inFlight = IN_FLIGHT.has(d.status);
  return {
    detail: {
      ...d,
      actor: d.actor ?? null,
      current: d.status === "ready" && d.external?.target === "production" && !newer,
      followOnly: true,
      error: d.status === "failed" ? "Command \"pnpm build\" exited with 1" : null,
      steps: previewVercelSteps(d, nowDate),
    },
    lines: inFlight ? lines.slice(0, Math.ceil(lines.length * 0.6)) : lines,
    tail: inFlight ? lines.slice(Math.ceil(lines.length * 0.6)) : [],
    done: !inFlight,
  };
}

export function previewDetail(id: string, nowDate: Date): Built | null {
  const hit = previewFind(id, nowDate);
  if (!hit) return null;
  const { row: d, all } = hit;
  if (d.external) return previewVercelDetail(d, all, nowDate);
  const now = nowDate.getTime();
  const rnd = seeded(hashSeed(d.id));
  const created = Date.parse(d.createdAt);
  const end = d.finishedAt ? Date.parse(d.finishedAt) : null;
  const failure = d.status === "failed" ? failureOf(d, rnd) : null;

  // Steps: a finished run spreads its wall time over the plan; an in-flight run is on its live step.
  const live: Partial<Record<RecentDeployment["status"], StepId>> = { queued: "queued", building: "build", deploying: "deploy" };
  const stopAt: StepId | null = failure ? FAIL_STEP[failure] : d.status === "cancelled" ? "build" : (live[d.status] ?? null);
  const elapsed = ((end ?? now) - created) / 1000;
  const p = plan(end ? elapsed : Math.max(elapsed, 60) + 30, rnd);
  if (!end && stopAt) {
    // The live step started after the earlier ones finished, and has run for whatever is left.
    const before = STEPS.slice(0, STEPS.indexOf(stopAt));
    const spent = before.reduce((n, s) => n + p[s], 0);
    if (spent > elapsed - 2) {
      const k = Math.max(0, elapsed - 2) / (spent || 1);
      for (const s of before) p[s] *= k;
    }
  }
  if (end && stopAt) {
    // A run that stopped early: the steps before the stop keep their plan, the stop takes the rest.
    const before = STEPS.slice(0, STEPS.indexOf(stopAt));
    const spent = before.reduce((n, s) => n + p[s], 0);
    const k = spent > elapsed * 0.8 ? (elapsed * 0.5) / spent : 1;
    for (const s of before) p[s] *= k;
    p[stopAt] = elapsed - spent * k;
  }

  let t = created;
  let reached = false;
  const steps: DeploymentStep[] = STEPS.map((s) => {
    if (reached) return { id: s, status: d.status === "failed" || d.status === "cancelled" ? "skipped" : "pending", startedAt: null, finishedAt: null };
    if (s === "release") return { id: s, status: "skipped", startedAt: null, finishedAt: null };
    const startedAt = t;
    if (s === stopAt) {
      reached = true;
      const status: StepStatus = failure ? "failed" : d.status === "cancelled" ? "cancelled" : "running";
      return { id: s, status, startedAt: new Date(startedAt).toISOString(), finishedAt: end ? new Date(end).toISOString() : null };
    }
    t += p[s] * 1000;
    return { id: s, status: "done", startedAt: new Date(startedAt).toISOString(), finishedAt: new Date(s === "health" && end ? end : t).toISOString() };
  });

  // The build that served before this one, for the swap and the "keeps serving" lines.
  const older = all
    .filter((x) => x.appId === d.appId && x.status === "ready" && Date.parse(x.createdAt) < created)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const prevSha = older?.commit ?? Math.floor(rnd() * 0xfffffff).toString(16).padStart(7, "0");
  const newer = all.some((x) => x.appId === d.appId && x.status === "ready" && Date.parse(x.createdAt) > created);

  const script = logScript(d, failure, prevSha, elapsed, rnd);
  const lines: LogLine[] = [];
  const tail: LogLine[] = [];
  let seq = 0;
  for (const step of steps) {
    const body = script[step.id];
    if (!step.startedAt || !body.length) continue;
    const from = Date.parse(step.startedAt);
    const to = step.finishedAt ? Date.parse(step.finishedAt) : from + p[step.id] * 1000;
    const groups = new Map<string, number>();
    body.forEach((raw, i) => {
      const at = Math.round(from + ((to - from) * (i + 0.5)) / body.length);
      const line = toLine(raw, ++seq, at, groups);
      (step.finishedAt || at <= now ? lines : tail).push(line);
    });
  }
  // A running step whose remaining lines are still to come keeps the tail; finished runs have none.
  const done = !IN_FLIGHT.has(d.status);

  const detail: DeploymentDetail = {
    ...d,
    actor: d.actor ?? PREVIEW_OWNER,
    current: d.status === "ready" && !newer,
    error: failure ? FAILURE_LINE[failure] : null,
    steps,
  };
  return { detail, lines, tail, done };
}

const FAILURE_LINE: Record<Failure, string> = {
  compile: "Type errors in the build, pnpm build exited with an error",
  lockfile: "pnpm-lock.yaml is out of date with package.json",
  migration: "Migration failed at boot, the container exited before it was healthy",
  crash: "The process exited three times in a row after starting",
  timeout: "Health check timed out after 60s",
};

/*
 * Script lines: "!" first marks stderr. "@N " marks a BuildKit RUN output line of step #N; it is
 * printed as "#N <seconds since that step's first line> text", the way `--progress=plain` does.
 */
function toLine(raw: string, seq: number, at: number, groups: Map<string, number>): LogLine {
  let text = raw;
  let stream: LogLine["stream"] = "stdout";
  if (text.startsWith("!")) {
    stream = "stderr";
    text = text.slice(1);
  }
  const m = /^@(\d+) ?(.*)$/.exec(text);
  if (m) {
    const first = groups.get(m[1]!) ?? at;
    groups.set(m[1]!, first);
    text = `#${m[1]} ${((at - first) / 1000 + 0.21).toFixed(3)} ${m[2]}`;
  }
  return { seq, ts: new Date(at).toISOString(), stream, text };
}

function clockText(s: number) {
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m ? `${m}m ${r}s` : `${r}s`;
}

const PORT: Record<AppKind, number> = { frontend: 3000, backend: 3001, bot: 0, postgres: 5432, redis: 6379, s3: 9000 };

const ROUTES: Record<string, string[]> = {
  web: ["/", "/_not-found", "/api/health", "/leaderboard", "/leaderboard/[month]", "/partners", "/partners/[slug]", "/rewards", "/profile/[id]", "/login", "/terms"],
  admin: ["/", "/_not-found", "/api/health", "/audit", "/partners", "/payouts", "/users", "/users/[id]", "/settings"],
};

function logScript(d: RecentDeployment, failure: Failure | null, prevSha: string, elapsed: number, rnd: () => number): Record<StepId, string[]> {
  const sha = d.commit ?? "manual";
  const kind = d.app.kind ?? "backend";
  const name = `${d.projectSlug}-${d.app.name}`;
  const image = `registry.dockify.local/${d.projectSlug}/${d.app.name}:${sha}`;
  const next = d.message?.startsWith("Bump Next.js") ? "16.4.0" : "16.3.2";
  const port = PORT[kind];
  const out: Record<StepId, string[]> = { queued: [], clone: [], build: [], push: [], release: [], deploy: [], health: [] };

  out.queued = [
    `Deployment ${d.id} queued by a push to ${d.branch ?? "main"}`,
    d.status === "queued" ? "Waiting for a build slot, 2 of 2 in use" : "Waiting for a build slot, 1 of 2 in use",
    ...(d.status === "queued" ? [] : ["Build slot acquired on vps-1"]),
  ];

  out.clone = [
    `Cloning ${d.projectSlug} at ${sha} (${d.branch ?? "detached"})`,
    `Fetched 1 commit, ${(1.2 + rnd() * 4).toFixed(1)} MB in ${(0.6 + rnd()).toFixed(1)}s`,
    `HEAD is now at ${sha} ${d.message ?? ""}`.trim(),
    `Using apps/${d.app.name}/Dockerfile, context apps/${d.app.name}`,
  ];

  // Docker build: shared head, then the app's own stages.
  const b: string[] = [
    `#0 building with "default" instance using docker driver`,
    "#1 [internal] load build definition from Dockerfile",
    `#1 transferring dockerfile: ${(1.1 + rnd()).toFixed(2)}kB done`,
    "#1 DONE 0.0s",
    "#2 [internal] load metadata for docker.io/library/node:22-alpine",
    `#2 DONE ${(0.4 + rnd()).toFixed(1)}s`,
    "#3 [internal] load .dockerignore",
    "#3 transferring context: 412B done",
    "#3 DONE 0.0s",
    `#4 [base 1/2] FROM docker.io/library/node:22-alpine@sha256:${hex(rnd, 64)}`,
    "#4 CACHED",
    "#5 [internal] load build context",
    `#5 transferring context: ${(2 + rnd() * 6).toFixed(2)}MB ${(0.2 + rnd() * 0.4).toFixed(1)}s done`,
    `#5 DONE ${(0.3 + rnd() * 0.4).toFixed(1)}s`,
    "#6 [base 2/2] RUN corepack enable && corepack prepare pnpm@10.11.0 --activate",
    "#6 CACHED",
    "#7 [deps 1/2] COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./",
    "#7 DONE 0.1s",
    "#8 [deps 2/2] RUN pnpm install --frozen-lockfile",
  ];

  if (failure === "lockfile") {
    b.push(
      `!@8  ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with <ROOT>/apps/${d.app.name}/package.json`,
      "!@8 ",
      "!@8 Note that in CI environments this setting is true by default. If you still need to run install in such cases, use \"pnpm install --no-frozen-lockfile\"",
      "!@8 ",
      "!@8     Failure reason:",
      "!@8     specifiers in the lockfile ({\"zod\":\"^3.24.1\"}) don't match specs in package.json ({\"zod\":\"^3.25.0\"})",
      "!#8 ERROR: process \"/bin/sh -c pnpm install --frozen-lockfile\" did not complete successfully: exit code: 1",
      "! ------",
      "!  > [deps 2/2] RUN pnpm install --frozen-lockfile:",
      "! ------",
      "!ERROR: failed to solve: process \"/bin/sh -c pnpm install --frozen-lockfile\" did not complete successfully: exit code: 1",
      `!Build failed after ${clockText(elapsed)}, the running version stays live`,
    );
    out.build = b;
    return out;
  }

  const deps =
    kind === "frontend"
      ? [`+ next ${next}`, "+ react 19.2.4", "+ react-dom 19.2.4", "+ geist 1.8.2"]
      : kind === "bot"
        ? ["+ discord.js 14.19.3", "+ ws 8.18.2", "+ pino 9.6.0", "+ zod 3.25.0"]
        : ["+ fastify 5.3.2", "+ @prisma/client 6.8.2", "+ pino 9.6.0", "+ zod 3.25.0"];
  const total = kind === "frontend" ? 812 : kind === "bot" ? 214 : 468;
  b.push(
    "@8 Lockfile is up to date, resolution step is skipped",
    "@8 Progress: resolved 1, reused 0, downloaded 0, added 0",
    `@8 Packages: +${total}`,
    `@8 Progress: resolved ${total}, reused ${total - 37}, downloaded 31, added ${total - 6}`,
    `@8 Progress: resolved ${total}, reused ${total - 37}, downloaded 37, added ${total}, done`,
    "@8 ",
    "@8 dependencies:",
    ...deps.map((x) => `@8 ${x}`),
    "@8 ",
    `@8 Done in ${(3 + rnd() * 4).toFixed(1)}s using pnpm v10.11.0`,
    `#8 DONE ${(4 + rnd() * 4).toFixed(1)}s`,
    "#9 [builder 1/3] COPY --from=deps /app/node_modules ./node_modules",
    `#9 DONE ${(1.4 + rnd()).toFixed(1)}s`,
    "#10 [builder 2/3] COPY . .",
    "#10 DONE 0.2s",
    "#11 [builder 3/3] RUN pnpm build",
  );

  if (kind === "frontend") {
    const routes = ROUTES[d.app.name] ?? ROUTES.web!;
    b.push(
      `@11 > ${d.app.name}@0.1.0 build /app`,
      "@11 > next build",
      "@11 ",
      `@11    ▲ Next.js ${next}`,
      "@11    - Environments: .env.production",
      "@11 ",
      "@11    Creating an optimized production build ...",
      `@11  ✓ Compiled successfully in ${(28 + rnd() * 16).toFixed(1)}s`,
      "@11    Linting and checking validity of types ...",
    );
    if (failure === "compile") {
      b.push(
        "!@11 Failed to compile.",
        "!@11 ",
        "!@11 ./app/(site)/leaderboard/[month]/page.tsx:14:39",
        "!@11 Type error: Type 'LeaderboardPageProps' does not satisfy the constraint 'PageProps'.",
        "!@11   Types of property 'params' are incompatible.",
        "!@11     Type '{ month: string; }' is missing the following properties from type 'Promise<any>': then, catch, finally, [Symbol.toStringTag]",
        "!@11 ",
        "!@11   12 |",
        "!@11   13 | export default async function LeaderboardPage({ params }: LeaderboardPageProps) {",
        "!@11 > 14 |   const board = await getBoard(params.month);",
        "!@11      |                                       ^",
        "!@11   15 |   return <Board rows={board.rows} month={params.month} />;",
        "!@11 Next.js build worker exited with code: 1 and signal: null",
        "!@11  ELIFECYCLE  Command failed with exit code 1.",
        "!#11 ERROR: process \"/bin/sh -c pnpm build\" did not complete successfully: exit code: 1",
        "! ------",
        "!  > [builder 3/3] RUN pnpm build:",
        "! ------",
        "!ERROR: failed to solve: process \"/bin/sh -c pnpm build\" did not complete successfully: exit code: 1",
        `!Build failed after ${clockText(elapsed)}, the running version stays live`,
      );
      out.build = b;
      return out;
    }
    const pages = routes.length + 13;
    b.push(
      "@11    Collecting page data ...",
      `@11    Generating static pages (0/${pages}) ...`,
      `@11    Generating static pages (${Math.round(pages / 4)}/${pages})`,
      `@11    Generating static pages (${Math.round(pages / 2)}/${pages})`,
      `@11    Generating static pages (${Math.round((pages * 3) / 4)}/${pages})`,
      `@11  ✓ Generating static pages (${pages}/${pages})`,
      "@11    Finalizing page optimization ...",
      "@11    Collecting build traces ...",
      "@11 ",
      "@11 Route (app)                                 Size  First Load JS",
      ...routes.map((r, i) => {
        const glyph = r.includes("[") || r.startsWith("/api") ? "ƒ" : "○";
        const lead = i === 0 ? "┌" : i === routes.length - 1 ? "└" : "├";
        const size = r.startsWith("/api") || r === "/_not-found" ? `${(120 + rnd() * 80).toFixed(0)} B` : `${(1.2 + rnd() * 6).toFixed(2)} kB`;
        return `@11 ${lead} ${glyph} ${r.padEnd(40)}${size.padStart(9)}${`${(102 + rnd() * 40).toFixed(0)} kB`.padStart(15)}`;
      }),
      "@11 + First Load JS shared by all              102 kB",
      "@11 ",
      "@11 ○  (Static)   prerendered as static content",
      "@11 ƒ  (Dynamic)  server-rendered on demand",
      `#11 DONE ${(40 + rnd() * 20).toFixed(1)}s`,
      "#12 [runner 1/3] COPY --from=builder /app/.next/standalone ./",
      "#12 DONE 0.6s",
      "#13 [runner 2/3] COPY --from=builder /app/.next/static ./.next/static",
      "#13 DONE 0.2s",
      "#14 [runner 3/3] COPY --from=builder /app/public ./public",
      "#14 DONE 0.1s",
    );
  } else {
    b.push(
      `@11 > ${d.app.name}@1.0.0 build /app`,
      kind === "bot" ? "@11 > tsc -p tsconfig.build.json" : "@11 > prisma generate && tsc -p tsconfig.build.json",
      ...(kind === "bot"
        ? []
        : [
            "@11 Prisma schema loaded from prisma/schema.prisma",
            `@11 ✔ Generated Prisma Client (v6.8.2) to ./node_modules/@prisma/client in ${Math.round(280 + rnd() * 300)}ms`,
          ]),
    );
    if (failure === "compile") {
      b.push(
        "!@11 src/modules/payouts/payouts.service.ts(88,23): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.",
        "!@11   Type 'undefined' is not assignable to type 'string'.",
        "!@11 src/modules/payouts/payouts.controller.ts(41,9): error TS2322: Type 'Decimal' is not assignable to type 'number'.",
        "!@11 ",
        "!@11 Found 2 errors in 2 files.",
        "!@11 ",
        "!@11 Errors  Files",
        "!@11      1  src/modules/payouts/payouts.controller.ts:41",
        "!@11      1  src/modules/payouts/payouts.service.ts:88",
        "!@11  ELIFECYCLE  Command failed with exit code 2.",
        "!#11 ERROR: process \"/bin/sh -c pnpm build\" did not complete successfully: exit code: 2",
        "! ------",
        "!  > [builder 3/3] RUN pnpm build:",
        "! ------",
        "!ERROR: failed to solve: process \"/bin/sh -c pnpm build\" did not complete successfully: exit code: 2",
        `!Build failed after ${clockText(elapsed)}, the running version stays live`,
      );
      out.build = b;
      return out;
    }
    b.push(`#11 DONE ${(6 + rnd() * 8).toFixed(1)}s`);
    // One preview build runs its test suite verbosely, so the log viewer has a five-thousand-line log.
    if (d.id === "dpl_5") b.push(...testSuite(rnd));
    b.push("#12 [runner 1/2] COPY --from=builder /app/dist ./dist", "#12 DONE 0.3s", "#13 [runner 2/2] COPY --from=builder /app/node_modules ./node_modules", "#13 DONE 1.8s");
  }
  b.push(
    "#15 exporting to image",
    `#15 exporting layers ${(1.5 + rnd() * 2).toFixed(1)}s done`,
    `#15 writing image sha256:${hex(rnd, 64)} done`,
    `#15 naming to ${image} done`,
    `#15 DONE ${(2 + rnd() * 2).toFixed(1)}s`,
  );
  if (d.status === "cancelled") {
    b.splice(Math.floor(b.length * 0.55), b.length, "!Cancel requested by Sam", "Stopping the build, sending SIGTERM to BuildKit", "!ERROR: failed to solve: Canceled: context canceled", `!Build cancelled after ${clockText(elapsed)}`);
    out.build = b;
    return out;
  }
  out.build = b;

  const layers = 4 + Math.floor(rnd() * 3);
  out.push = [
    `The push refers to repository [${image.replace(/:[^:]+$/, "")}]`,
    ...Array.from({ length: layers }, (_, i) => `${hex(rnd, 12)}: ${i < 2 ? "Layer already exists" : "Pushed"}`),
    `${sha}: digest: sha256:${hex(rnd, 64)} size: ${1800 + Math.floor(rnd() * 900)}`,
  ];

  out.deploy = [
    `Pulling ${image}`,
    `Starting ${name}-${sha} on network dockify-${d.projectSlug}`,
    `Injected ${8 + Math.floor(rnd() * 12)} environment variables from ${d.environment}`,
    `Container started, pid ${40_000 + Math.floor(rnd() * 20_000)}`,
  ];
  if (kind === "frontend") out.deploy.push(`   ▲ Next.js ${next}`, `   - Local:        http://0.0.0.0:${port}`, ` ✓ Ready in ${Math.round(180 + rnd() * 400)}ms`);
  else if (kind === "bot") out.deploy.push(`{"level":30,"msg":"logging in as ${d.projectSlug}-${d.app.name}"}`);
  else out.deploy.push(`{"level":30,"msg":"Server listening at http://0.0.0.0:${port}"}`);

  if (failure === "migration") {
    out.deploy.push(
      "Prisma schema loaded from prisma/schema.prisma",
      "Datasource \"db\": PostgreSQL database \"app\", schema \"public\" at \"postgres:5432\"",
      "1 migration found in prisma/migrations",
      "Applying migration `20261026_event_timestamptz`",
      "!Error: P3018",
      "!A migration failed to apply. New migrations cannot be applied before the error is recovered from.",
      "!Migration name: 20261026_event_timestamptz",
      "!Database error code: 0A000",
      "!Database error:",
      "!ERROR: cannot alter type of a column used by a view or rule",
      "!DETAIL: rule _RETURN on view audit_recent depends on column \"created_at\"",
      "!Container exited with code 1 before it became healthy",
      `!Deployment failed, ${name}-${prevSha} keeps serving traffic`,
    );
    return out;
  }

  if (kind === "bot") {
    out.health = ["Waiting for the process to stay up for 10s"];
    if (failure === "crash") {
      for (let i = 1; i <= 3; i++) {
        out.health.push(
          "[chat] connecting to the chat socket",
          "!Error: Unexpected server response: 403",
          "!    at ClientRequest.<anonymous> (/app/node_modules/ws/lib/websocket.js:913:7)",
          "!    at ClientRequest.emit (node:events:518:28)",
          "!    at HTTPParser.parserOnIncomingClient (node:_http_client:716:27)",
          `!Container exited with code 1, restart ${i} of 3`,
        );
      }
      out.health.push("!Health check failed, the process restarted 3 times in 40s", `!Deployment failed, removed ${name}-${sha}`);
      return out;
    }
    out.health.push("Process stable after 10s, 0 restarts", `Stopped ${name}-${prevSha}`, `Deployment ready in ${clockText(elapsed)}`);
    return out;
  }

  const path = kind === "frontend" ? "/api/health" : "/health";
  out.health = [`Waiting for GET :${port}${path} to answer 200, timeout 60s`];
  if (failure === "timeout") {
    for (let i = 1; i <= 6; i++) out.health.push(i < 3 ? `!GET ${path} failed, connection refused, attempt ${i}` : `!GET ${path} 503 in ${Math.round(2 + rnd() * 8)}ms, attempt ${i}`);
    out.health.push("!Health check timed out after 60s", `!Deployment failed, ${name}-${prevSha} keeps serving traffic`);
    return out;
  }
  out.health.push(
    `GET ${path} 503 in ${Math.round(2 + rnd() * 6)}ms, attempt 1`,
    `GET ${path} 200 in ${Math.round(6 + rnd() * 14)}ms, attempt 2`,
    `Healthy, routing traffic to ${name}-${sha}`,
    `Draining ${name}-${prevSha}, 10s grace`,
    `Stopped ${name}-${prevSha}`,
    `Deployment ready in ${clockText(elapsed)}`,
  );
  return out;
}

/** About 4,800 verbose vitest lines for the horseai api build. */
function testSuite(rnd: () => number): string[] {
  const modules = ["payouts", "partners", "leaderboard", "auth", "sessions", "wallet", "rewards", "affiliates", "webhooks", "admin", "audit", "referrals", "notifications", "settings", "cases", "withdrawals"];
  const parts = ["service", "controller", "repository", "schema", "jobs"];
  const verbs = ["returns", "rejects", "computes", "caches", "paginates", "validates", "rounds", "skips", "retries", "locks", "sorts", "maps"];
  const objects = [
    "an empty page", "a negative amount", "the partner share", "expired sessions", "a duplicate webhook", "the monthly board",
    "a missing cursor", "cents to whole coins", "an unknown partner id", "rows by created_at", "a stale snapshot", "the payout window",
    "a revoked token", "two concurrent claims", "a zero balance",
  ];
  const out = ["#12 [builder 4/4] RUN pnpm test -- --reporter=verbose", "@12 > api@1.0.0 test /app", "@12 > vitest run --reporter=verbose", "@12 ", "@12  RUN  v3.2.1 /app", "@12 "];
  let tests = 0;
  let files = 0;
  for (const m of modules) {
    for (const part of parts) {
      files += 1;
      const cls = `${m.charAt(0).toUpperCase()}${m.slice(1)}${part.charAt(0).toUpperCase()}${part.slice(1)}`;
      const n = 52 + Math.floor(rnd() * 14);
      for (let i = 0; i < n; i++) {
        tests += 1;
        const verb = verbs[(i + files) % verbs.length]!;
        const obj = objects[(i * 7 + files) % objects.length]!;
        out.push(`@12  ✓ src/modules/${m}/${m}.${part}.test.ts > ${cls} > ${verb} ${obj} ${Math.round(1 + rnd() * 9)}ms`);
      }
    }
  }
  out.push(
    "@12 ",
    `@12  Test Files  ${files} passed (${files})`,
    `@12       Tests  ${tests} passed (${tests})`,
    "@12    Start at  09:14:02",
    `@12    Duration  ${(14 + rnd() * 8).toFixed(2)}s (transform 3.12s, setup 0ms, collect 9.84s, tests 11.02s)`,
    "@12 ",
    "#12 DONE 22.4s",
  );
  return out;
}
