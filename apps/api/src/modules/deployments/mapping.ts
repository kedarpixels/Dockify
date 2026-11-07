/** Row to contract shapes, and the cursor. Pure, so it is tested without a database. */
import { gunzipSync } from "node:zlib";
import type { AppKind } from "@dockify/contracts";
import type { ActorType, DeploymentStatus as DbStatus } from "@dockify/db";
import { actorRef, deploymentSource, NO_PEOPLE, type People } from "../../actor-view.ts";

export type ApiStatus = DbStatus;
export const IN_FLIGHT: DbStatus[] = ["queued", "building", "deploying", "cancelling"];
export const TERMINAL: DbStatus[] = ["ready", "failed", "cancelled"];

/** Database and contract statuses are the same set, `cancelling` included. */
export function apiStatus(status: DbStatus, _imageId: string | null): ApiStatus {
  return status;
}

/** The list filter's statuses, in database terms. */
export function statusFilter(s: "all" | "building" | "ready" | "failed" | "cancelled" | undefined): DbStatus[] | null {
  if (!s || s === "all") return null;
  if (s === "building") return IN_FLIGHT;
  return [s];
}

export interface DeploymentRow {
  id: string;
  appId: string;
  status: DbStatus;
  commitSha: string | null;
  branch: string | null;
  message: string | null;
  trigger: string;
  imageId: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  actorType?: ActorType;
  actorId?: string | null;
  actorName?: string | null;
  gitAuthor?: string | null;
  gitAuthorAvatarUrl?: string | null;
  gitAuthorName?: string | null;
  imageRef?: string | null;
  provider?: "dockify" | "vercel";
  externalId?: string | null;
  externalUrl?: string | null;
  inspectorUrl?: string | null;
  externalTarget?: "production" | "preview" | null;
  externalSource?: string | null;
  externalCreator?: string | null;
  app: { id: string; name: string; kind: string; image?: string | null; gitRepository: string | null; environment: { name: string; project: { slug: string; id: string } } };
}

export type ExternalColumns = Pick<DeploymentRow, "provider" | "externalId" | "externalUrl" | "inspectorUrl" | "externalTarget" | "externalSource" | "externalCreator">;

/** The contract's external block: null for a build on this server, absent on a row that never read it. */
export function externalOf(d: ExternalColumns) {
  if (d.provider === undefined) return {};
  if (d.provider !== "vercel") return { external: null };
  return {
    external: {
      provider: "vercel" as const,
      id: d.externalId ?? null,
      url: d.externalUrl ?? null,
      inspectorUrl: d.inspectorUrl ?? null,
      target: d.externalTarget ?? null,
      source: d.externalSource ?? null,
      creator: d.externalCreator ?? null,
    },
  };
}

/**
 * Vercel's own life cycle in Dockify's step names: it queues, builds and goes live. Times come from
 * Vercel's record. There is no clone, push or health step here to show as waiting.
 */
export function vercelSteps(d: { status: DbStatus; createdAt: Date; startedAt?: Date | null; finishedAt?: Date | null }) {
  const created = d.createdAt.toISOString();
  const started = d.startedAt?.toISOString() ?? null;
  const finished = d.finishedAt?.toISOString() ?? null;
  type S = "pending" | "running" | "done" | "failed" | "cancelled" | "skipped";
  const end: S = d.status === "failed" ? "failed" : "cancelled";
  const stopped = d.status === "failed" || d.status === "cancelled";
  const queued: S = d.status === "queued" ? "running" : stopped && !started ? end : "done";
  const build: S = d.status === "queued" ? "pending" : d.status === "ready" ? "done" : stopped ? (started ? end : "skipped") : "running";
  const live: S = d.status === "ready" ? "done" : stopped ? "skipped" : "pending";
  return [
    { id: "queued" as const, status: queued, startedAt: created, finishedAt: queued === "running" ? null : (started ?? finished) },
    { id: "build" as const, status: build, startedAt: started, finishedAt: build === "done" || build === end ? finished : null },
    { id: "deploy" as const, status: live, startedAt: live === "done" ? finished : null, finishedAt: live === "done" ? finished : null },
  ];
}

export function toRecent(d: DeploymentRow, people: People = NO_PEOPLE) {
  return {
    id: d.id,
    appId: d.appId,
    status: apiStatus(d.status, d.imageId),
    commit: d.commitSha,
    message: d.message,
    trigger: d.trigger,
    createdAt: d.createdAt.toISOString(),
    finishedAt: d.finishedAt?.toISOString() ?? null,
    app: { id: d.app.id, name: d.app.name, kind: d.app.kind as AppKind },
    projectSlug: d.app.environment.project.slug,
    environment: d.app.environment.name,
    repo: d.app.gitRepository,
    ...externalOf(d),
    ...(d.actorType ? { actor: actorRef({ actorType: d.actorType, actorId: d.actorId ?? null, actorName: d.actorName ?? null, gitAuthor: d.gitAuthor ?? null, gitAuthorAvatarUrl: d.gitAuthorAvatarUrl ?? null }, people) } : {}),
    ...deploymentSource({ actorType: d.actorType ?? "system", actorId: d.actorId ?? null, actorName: d.actorName ?? null, gitAuthor: d.gitAuthor ?? null, gitAuthorAvatarUrl: d.gitAuthorAvatarUrl ?? null, gitAuthorName: d.gitAuthorName ?? null, branch: d.branch, commitSha: d.commitSha, imageRef: d.imageRef ?? null }, d.app, people),
  };
}

const CONTRACT_STEPS = ["queued", "clone", "build", "push", "release", "deploy", "health"] as const;
type ContractStep = { id: (typeof CONTRACT_STEPS)[number]; status: "pending" | "running" | "done" | "failed" | "cancelled" | "skipped"; startedAt: string | null; finishedAt: string | null };

/** The stored timeline; any missing step reads as pending, except "release", shown only once it ran. */
export function toSteps(raw: unknown): ContractStep[] {
  const stored = new Map<string, ContractStep>();
  if (Array.isArray(raw)) for (const s of raw as ContractStep[]) if (s && typeof s === "object") stored.set(s.id, s);
  return CONTRACT_STEPS.filter((id) => id !== "release" || stored.has(id)).map((id) => {
    const s = stored.get(id);
    return s ? { id, status: s.status, startedAt: s.startedAt ?? null, finishedAt: s.finishedAt ?? null } : { id, status: "pending", startedAt: null, finishedAt: null };
  });
}

/** Opaque cursor: createdAt millis and id, so pages are stable under inserts. */
export function encodeCursor(d: { createdAt: Date; id: string }): string {
  return Buffer.from(`${d.createdAt.getTime()}.${d.id}`).toString("base64url");
}
export function decodeCursor(c: string): { createdAt: Date; id: string } | null {
  const raw = Buffer.from(c, "base64url").toString("utf8");
  const m = /^(\d{1,15})\.([0-9a-f-]{36})$/.exec(raw);
  return m ? { createdAt: new Date(Number(m[1])), id: m[2]! } : null;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export interface LogLine {
  seq: number;
  ts: string;
  stream: "stdout" | "stderr";
  text: string;
}

/**
 * The most one chunk may inflate to. The worker writes at most 200 lines of at most 16 Ki
 * characters, so an honest chunk stays well under it; anything larger is a decompression bomb.
 */
export const MAX_CHUNK_BYTES = 16 * 1024 * 1024;

/** Same codec as the worker's deploy log: gzipped NDJSON of { ts, stream, text }. */
export function decodeChunk(firstSeq: number, gz: Uint8Array, lineCount = 1, maxBytes = MAX_CHUNK_BYTES): LogLine[] {
  let raw: Buffer;
  try {
    raw = gunzipSync(gz, { maxOutputLength: maxBytes });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" || e instanceof RangeError) {
      // One placeholder at the chunk's last seq, so the cursor moves past it and it is never reread.
      return [{ seq: firstSeq + Math.max(1, lineCount) - 1, ts: new Date(0).toISOString(), stream: "stderr", text: "[log chunk too large to show]" }];
    }
    throw e;
  }
  const text = raw.toString("utf8");
  if (!text) return [];
  return text.split("\n").map((l, i) => {
    const j = JSON.parse(l) as { ts: string; stream: "stdout" | "stderr"; text: string };
    return { seq: firstSeq + i, ts: j.ts, stream: j.stream === "stderr" ? "stderr" : "stdout", text: j.text };
  });
}

/** One SSE frame; the id is the seq, so a reconnect resumes with Last-Event-ID. */
export function sseFrame(event: string, data: unknown, id?: number): string {
  return `${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
