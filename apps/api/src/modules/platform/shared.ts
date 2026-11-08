import type { FastifyRequest } from "fastify";
import { enqueueTx, type Prisma, type Tx } from "@dockify/db";
import { runningVersion } from "@dockify/contracts";

/** Every platform route except the anonymous ones has an actor; the policy hook guarantees it. */
export { actorFields as actorAudit, requireActor } from "../../actor.ts";

export const reqMeta = (req: FastifyRequest) => ({ ip: req.clientIp || null, userAgent: req.headers["user-agent"] ?? null });

/** Serialises writers of one area (team, tokens, updates) inside a transaction. */
export async function lockArea(tx: Tx, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`dockify.${key}`}))`;
}

export interface EnqueueInput {
  kind: "prune";
  lane: "maintenance";
  serverId: string;
  payload: Prisma.InputJsonValue;
  dedupeKey: string;
  maxAttempts?: number;
}

/** Enqueues through the shared @dockify/db queue. Must run inside a transaction. */
export async function enqueueJob(tx: Prisma.TransactionClient, input: EnqueueInput): Promise<string> {
  return enqueueTx(tx, { ...input, maxAttempts: input.maxAttempts ?? 1 });
}

/** Platform settings read from the environment the installer writes. Never from the database. */
export interface PlatformEnv {
  version: string;
  releaseFeedUrl: string | null;
  releasePublicKey: string | null;
  hostOs: string | null;
  dockerVersion: string | null;
  publicIp: string | null;
  region: string;
  /** The server's own hostname, which the installer records (the api's container has its own). */
  hostName: string | null;
  /** The outbound link speed the installer was told (DOCKIFY_NET_CAPACITY_MBPS), or null when unknown. */
  networkCapacityMbps: number | null;
}

export function loadPlatformEnv(env: NodeJS.ProcessEnv = process.env): PlatformEnv {
  const s = (k: string) => {
    const v = env[k]?.trim();
    return v ? v : null;
  };
  const cap = Number(env.DOCKIFY_NET_CAPACITY_MBPS ?? 0);
  return {
    // The image's own version (contracts runningVersion), never the .env value an update leaves stale.
    version: runningVersion(env),
    releaseFeedUrl: s("DOCKIFY_RELEASE_FEED"),
    releasePublicKey: s("DOCKIFY_RELEASE_PUBKEY"),
    hostOs: s("DOCKIFY_HOST_OS"),
    dockerVersion: s("DOCKIFY_DOCKER_VERSION"),
    publicIp: s("DOCKIFY_PUBLIC_IP"),
    region: s("DOCKIFY_REGION") ?? "",
    hostName: s("DOCKIFY_HOST_NAME"),
    networkCapacityMbps: Number.isFinite(cap) && cap > 0 ? cap : null,
  };
}
