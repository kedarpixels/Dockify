/**
 * The pull_request webhook path (HMAC already verified by the receiver). opened, reopened and
 * synchronize create or update the preview pr-<n>; closed (merged or not) deletes it. Only
 * projects with previews on are touched. Every decision that needs the caps runs under one
 * server-wide advisory lock, so two PRs opened at once can never both take the last slot.
 *
 * The worker owns the rest: it builds and runs the containers, posts the sticky PR comment and the
 * commit status (preview_feedback), and tears down (preview_cleanup). This file only writes rows
 * and queues those jobs in the same transaction.
 */
import { projects as P } from "@dockify/contracts";
import { defaultServerId, enqueuePreviewTx, type Db, type PreviewStatus, type Tx } from "@dockify/db";
import { requestDeployTx } from "../deployments/enqueue.ts";
import type { PullRequestEvent } from "../integrations/github/events.ts";
import { repoIdentity } from "../integrations/github/events.ts";
import { diskBlocks, diskPct, includedInPreviews, isLive, pickBaseEnvironment, planAdmission, previewNeedsOwnDb, previewHostname, previewName, type LivePreview } from "./logic.ts";

export const SERVER_LOCK = "preview:server";

export interface Delivery {
  projectId: string | null;
  summary: string;
}

const PROJECT_SELECT = {
  id: true, gitRepoId: true, previewMaxConcurrent: true, previewDomain: true, previewBaseEnv: true, previewFromForks: true, previewIsolatedDb: true,
  environments: {
    select: {
      id: true, name: true,
      apps: { select: { id: true, name: true, kind: true, previewEnabled: true, gitRepository: true, gitRepoId: true, deployTarget: true } },
    },
  },
} as const;

export async function latestDiskPct(db: Tx, now = Date.now()): Promise<number | null> {
  const s = await db.metricSample.findFirst({
    where: { appId: null, resolution: "raw", diskTotalBytes: { not: null } },
    orderBy: { at: "desc" },
    select: { diskBytes: true, diskTotalBytes: true, at: true },
  });
  return diskPct(s, now);
}

export interface InstancePreview {
  cap: number;
  domain: string | null;
  publicUrl: string;
}

export async function instancePreview(db: Tx): Promise<InstancePreview> {
  const i = await db.instance.findUnique({ where: { id: 1 }, select: { previewServerMax: true, previewDomain: true, publicUrl: true } });
  return { cap: i?.previewServerMax ?? 4, domain: i?.previewDomain ?? null, publicUrl: i?.publicUrl ?? "" };
}

/** Whether the last check saw *.domain resolve to this server. */
export async function domainResolves(db: Tx, domain: string): Promise<{ ok: boolean; detail: string | null }> {
  const row = await db.previewDomain.findUnique({ where: { domain }, select: { dnsStatus: true, dnsDetail: true } });
  return { ok: row?.dnsStatus === "ok", detail: row?.dnsDetail ?? null };
}

/** Marks a preview for removal and queues its teardown and its PR comment update. */
export async function retirePreview(tx: Tx, id: string, reason: string, error: string | null = null): Promise<void> {
  const row = await tx.previewEnv.findUnique({ where: { id }, select: { status: true } });
  if (!row || row.status === "closed" || row.status === "closing") return;
  if (row.status === "blocked") {
    // Nothing ever ran: closed straight away.
    await tx.previewEnv.update({ where: { id }, data: { status: "closed", reason, error, closedAt: new Date() } });
  } else {
    await tx.previewEnv.update({ where: { id }, data: { status: "closing", reason, error } });
    await enqueuePreviewTx(tx, "preview_cleanup", id, await defaultServerId(tx));
  }
  await enqueuePreviewTx(tx, "preview_feedback", id);
}

type Project = Awaited<ReturnType<typeof loadProjects>>[number];
const loadProjects = (db: Db) => db.project.findMany({ where: { archivedAt: null, previewEnabled: true }, select: PROJECT_SELECT });

type ProjectApp = Project["environments"][number]["apps"][number];

/** Whether this app builds from the pull request's base repository: by id when both sides have one, else by URL. */
export function appBuildsRepo(a: Pick<ProjectApp, "gitRepository" | "gitRepoId">, pr: Pick<PullRequestEvent, "repoId" | "identity">): boolean {
  return !!a.gitRepository && (a.gitRepoId && pr.repoId ? a.gitRepoId === pr.repoId : repoIdentity(a.gitRepository) === pr.identity);
}

function repoMatches(p: Project, pr: PullRequestEvent): boolean {
  // Each app's own repository first: the dashboard stores the id on the app, and the project's may name another.
  const byApp = p.environments.some((e) => e.apps.some((a) => appBuildsRepo(a, pr)));
  return byApp || (!!p.gitRepoId && p.gitRepoId === pr.repoId);
}

/** PR numbers are per repository, so a preview is found by its base repository too, never by the number alone. */
const keyOf = (p: Project, pr: PullRequestEvent) => ({ projectId_repoKey_prNumber: { projectId: p.id, repoKey: pr.identity, prNumber: pr.number } });

async function onClose(db: Db, p: Project, pr: PullRequestEvent): Promise<string | null> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${SERVER_LOCK}))`;
    const row = await tx.previewEnv.findUnique({ where: keyOf(p, pr), select: { id: true, status: true } });
    if (!row || row.status === "closed" || row.status === "closing") return null;
    await retirePreview(tx, row.id, pr.merged ? "merged" : "closed");
    return `PR #${pr.number} ${pr.merged ? "merged" : "closed"}, deleting preview ${previewName(pr.number)}`;
  });
}

async function onOpen(db: Db, p: Project, pr: PullRequestEvent, now: Date): Promise<string> {
  const base = pickBaseEnvironment(p.environments, p.previewBaseEnv);
  const inst = await instancePreview(db);
  const domain = P.effectivePreviewDomain(p.previewDomain, inst.domain, inst.publicUrl).domain;
  // Only the apps that build this repository: another repository's app has no such commit and no such PR.
  const apps = (base?.apps ?? []).filter(includedInPreviews).filter((a) => appBuildsRepo(a, pr));
  const disk = await latestDiskPct(db, now.getTime());
  const cap = inst.cap;
  const dns = domain ? await domainResolves(db, domain) : { ok: false, detail: null };
  const fields = {
    title: pr.title, author: pr.author, branch: pr.branch, commitSha: pr.commitSha, repo: pr.fullName ?? pr.identity.split("/").slice(1).join("/"),
    fromFork: pr.fromFork, lastCommitAt: now,
  };

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${SERVER_LOCK}))`;
    const existing = await tx.previewEnv.findUnique({ where: keyOf(p, pr), select: { id: true, status: true } });

    const block = async (reason: string, error: string) => {
      const data = { ...fields, domain: domain ?? "", status: "blocked" as PreviewStatus, reason, error, closedAt: null };
      const row = existing
        ? await tx.previewEnv.update({ where: { id: existing.id }, data, select: { id: true } })
        : await tx.previewEnv.create({ data: { ...data, projectId: p.id, repoKey: pr.identity, prNumber: pr.number, baseEnvironmentId: base!.id, isolatedDb: previewNeedsOwnDb(p) }, select: { id: true } });
      await enqueuePreviewTx(tx, "preview_feedback", row.id);
      return `PR #${pr.number}: ${error}`;
    };

    if (existing?.status === "closing") return `PR #${pr.number}: the previous preview is still being removed; push again in a minute`;
    if (!base) return `PR #${pr.number}: the base environment ${p.previewBaseEnv} does not exist`;
    if (!domain) return `PR #${pr.number}: set a preview domain to get previews`;
    if (!apps.length) return `PR #${pr.number}: no app in ${base.name} is included in previews`;
    const live = existing && isLive(existing.status);
    if (!live) {
      // Refuse until *.domain resolves to this server: a preview nobody can reach is wasted work.
      if (!dns.ok) {
        await enqueuePreviewTx(tx, "preview_dns", domain);
        return block("dns", `the preview domain ${domain} does not resolve to this server yet${dns.detail ? ` (${dns.detail})` : ""}. Create the record *.${domain}, press Check DNS in the dashboard, then push again`);
      }

      if (diskBlocks(disk)) return block("disk", `disk is ${disk}% full, so no new preview starts until it is below 85%`);
      const rows = await tx.previewEnv.findMany({
        where: { status: { in: ["building", "ready", "asleep", "failed"] } },
        select: { id: true, projectId: true, prNumber: true, status: true, lastCommitAt: true, lastRequestAt: true },
      });
      const others: LivePreview[] = rows
        .filter((r) => r.id !== existing?.id)
        .map((r) => ({ id: r.id, projectId: r.projectId, prNumber: r.prNumber, status: r.status, lastActivity: new Date(Math.max(r.lastCommitAt.getTime(), r.lastRequestAt?.getTime() ?? 0)) }));
      const plan = planAdmission(others, p.id, p.previewMaxConcurrent, cap);
      if (plan.kind === "blocked") {
        return block("cap", plan.scope === "project"
          ? `the project already runs ${p.previewMaxConcurrent} preview(s) and none is idle enough to evict`
          : `the server already runs ${cap} preview(s) and none is idle enough to evict`);
      }
      for (const e of plan.evict) await retirePreview(tx, e.id, "evicted", `Evicted to make room for #${pr.number}`);
    }

    const data = { ...fields, status: "building" as PreviewStatus, reason: null, error: null, closedAt: null, sleptAt: null };
    const row = existing
      ? await tx.previewEnv.update({ where: { id: existing.id }, data: { ...data, ...(live ? {} : { baseEnvironmentId: base.id, isolatedDb: previewNeedsOwnDb(p), domain }) }, select: { id: true } })
      : await tx.previewEnv.create({ data: { ...data, domain, projectId: p.id, repoKey: pr.identity, prNumber: pr.number, baseEnvironmentId: base.id, isolatedDb: previewNeedsOwnDb(p) }, select: { id: true } });

    const skipped: string[] = [];
    let queued = 0;
    for (const a of apps) {
      const member = await tx.previewDeployment.findUnique({ where: { envId_appId: { envId: row.id, appId: a.id } }, select: { id: true } });
      let pdId = member?.id;
      if (!pdId) {
        // Two projects can both have an app `web` and a PR #1. Their project's id then tells them apart:
        // a hostname another preview or a real domain holds is never shared.
        const free = async (candidate: string) => {
          const [taken, takenDomain] = await Promise.all([
            tx.previewDeployment.findUnique({ where: { hostname: candidate }, select: { id: true } }),
            tx.domain.findUnique({ where: { hostname: candidate }, select: { id: true } }),
          ]);
          return !taken && !takenDomain;
        };
        const plain = previewHostname(pr.number, a.name, domain);
        const scoped = previewHostname(pr.number, `${a.name.slice(0, 30)}-${p.id.slice(0, 6)}`, domain);
        const hostname = (await free(plain)) ? plain : (await free(scoped)) ? scoped : null;
        if (!hostname) {
          skipped.push(a.name);
          continue;
        }
        pdId = (await tx.previewDeployment.create({ data: { envId: row.id, appId: a.id, hostname }, select: { id: true } })).id;
      }
      const out = await requestDeployTx(tx, a.id, {
        trigger: "preview", actorType: "webhook", actorName: "GitHub", branch: pr.branch, commitSha: pr.commitSha, message: pr.title, previewId: pdId, fromFork: pr.fromFork,
      }, "coalesce");
      if (out.kind === "queued") queued++;
    }
    await enqueuePreviewTx(tx, "preview_feedback", row.id);
    const verb = live ? "updating" : "building";
    return `PR #${pr.number}: ${verb} ${previewName(pr.number)} (${queued} app(s) queued${skipped.length ? `, hostname taken for ${skipped.join(", ")}` : ""})`;
  });
}

export async function onPullRequest(db: Db, pr: PullRequestEvent, now = new Date()): Promise<Delivery> {
  const notes: string[] = [];
  let projectId: string | null = null;
  for (const p of await loadProjects(db)) {
    if (!repoMatches(p, pr)) continue;
    projectId ??= p.id;
    if (pr.step === "close") {
      const note = await onClose(db, p, pr);
      if (note) notes.push(note);
      continue;
    }
    // Fork code never sees a secret. Without the opt-in it does not build at all.
    if (pr.fromFork && !p.previewFromForks) {
      notes.push(`PR #${pr.number} comes from a fork; previews from forks are off for this project`);
      continue;
    }
    if (pr.fromFork && !pr.commitSha) {
      notes.push(`PR #${pr.number} comes from a fork and carries no head commit`);
      continue;
    }
    notes.push(await onOpen(db, p, pr, now));
  }
  return { projectId, summary: notes.join("; ") || `PR #${pr.number}: no project builds previews for this repository` };
}
