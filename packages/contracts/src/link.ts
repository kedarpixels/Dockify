/**
 * What crosses the link between the worker and a server's agent. A node's answers are hostile input,
 * and so are the worker's calls to the agent: both ends parse with these, with short caps.
 */
import { z } from "zod";

/** Raised whenever a call changes shape. The worker must work with an agent one behind (PROTO_MIN). */
export const PROTO_CURRENT = 1;
export const PROTO_MIN = PROTO_CURRENT;

const short = z.string().max(256);

export const AgentInfo = z.object({
  version: z.string().max(64),
  proto: z.number().int().min(0).max(1_000_000),
  hostname: short,
  publicIpv4: short.nullable(),
  publicIpv6: short.nullable(),
  cores: z.number().int().min(1).max(4096),
  memoryBytes: z.number().int().min(0),
  dockerVersion: z.string().max(64).nullable(),
  kernel: short,
  os: short.nullable(),
  ingress: z.enum(["cloudflare_tunnel", "direct_tls"]),
  /** Its clock, in milliseconds. Only ever compared, for the skew warning. */
  clock: z.number(),
});
export type AgentInfo = z.infer<typeof AgentInfo>;

export const HostAnswer = z.object({
  cpu: z.object({ idle: z.number(), total: z.number() }).nullable(),
  memUsedBytes: z.number(),
  memTotalBytes: z.number(),
  disk: z.object({ usedBytes: z.number(), totalBytes: z.number(), freeBytes: z.number() }).nullable(),
  net: z.object({ rx: z.number(), tx: z.number() }).nullable(),
});

/** Never a raw address: a container on a tenant network, or this server's proxy by its known ports. */
export const DialRequest = z.union([
  z.strictObject({ container: z.string().regex(/^(?:dk-|dockify-(?:rt|bk|rs)-)[A-Za-z0-9_.-]{1,200}$|^[a-f0-9]{64}$/), network: z.string().regex(/^dockify-(?:env-[a-z0-9-]{1,60}|pv-[a-z0-9-]{1,60}|helpers)$/), port: z.number().int().min(1).max(65535), timeoutMs: z.number().int().min(1).max(120_000).optional() }),
  z.strictObject({ proxy: z.union([z.literal(80), z.literal(443), z.literal(8080), z.literal(8082)]), timeoutMs: z.number().int().min(1).max(120_000).optional() }),
]);
export type DialRequest = z.infer<typeof DialRequest>;

const routeFileName = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,200}\.yml$/);

export const RouteChangeBody = z.strictObject({
  writes: z.record(routeFileName, z.string().max(256 * 1024)).optional(),
  removes: z.array(routeFileName).max(10_000).optional(),
});

export const BuildVarBody = z.strictObject({
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
  value: z.string().max(4 * 1024 * 1024),
  isSecret: z.boolean(),
  target: z.enum(["build", "runtime", "both"]),
});

/** The ceiling DOCKIFY_MAX_REPO_BYTES has on the worker. What a server takes is its own agent's to say. */
const contextBytes = z.number().int().min(1).max(50 * 1024 ** 3);

/**
 * Names that end up inside buildctl options. --output and --secret split on commas, so a comma here would
 * add an option of the caller's: dest= writes the image over any file the agent can write.
 */
const argvWord = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);

/** The first line of POST /v1/build, before the context's tar. */
export const BuildRequest = z.strictObject({
  /** The folder holding the repository, relative to the archive's root. */
  repoDir: z.string().max(200),
  rootDir: z.string().max(1024),
  dockerfilePath: z.string().max(1024),
  builder: z.string().max(32).optional(),
  installCommand: z.string().max(16 * 1024).optional(),
  buildCommand: z.string().max(16 * 1024).optional(),
  startCommand: z.string().max(16 * 1024).optional(),
  cacheScope: argvWord.optional(),
  appId: argvWord,
  deploymentId: argvWord,
  vars: z.array(BuildVarBody).max(4096),
  timeoutMs: z.number().int().min(1).max(24 * 3_600_000),
  planTimeoutMs: z.number().int().min(1).max(24 * 3_600_000).optional(),
  maxBytes: contextBytes,
});
export type BuildRequest = z.infer<typeof BuildRequest>;

/** The first line of POST /v1/build/detect. */
export const PlanRequest = z.strictObject({
  repoDir: z.string().max(200),
  rootDir: z.string().max(1024),
  vars: z.array(BuildVarBody).max(4096),
  overrides: z.strictObject({ installCommand: z.string().max(16 * 1024), buildCommand: z.string().max(16 * 1024), startCommand: z.string().max(16 * 1024) }),
  timeoutMs: z.number().int().min(1).max(24 * 3_600_000),
  maxBytes: contextBytes,
});
export type PlanRequest = z.infer<typeof PlanRequest>;

/** One line of a build's answer. `end` is the last one, unless the link drops. */
export const BuildLine = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("system"), m: z.string().max(64 * 1024) }),
  z.strictObject({ t: z.literal("stdout"), m: z.string().max(64 * 1024) }),
  z.strictObject({ t: z.literal("stderr"), m: z.string().max(64 * 1024) }),
  z.strictObject({ t: z.literal("end"), result: z.unknown() }),
  z.strictObject({ t: z.literal("error"), m: z.string().max(8 * 1024), permanent: z.boolean() }),
]);
export type BuildLine = z.infer<typeof BuildLine>;

export const BuildResultBody = z.strictObject({
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  imageRef: z.string().max(512),
  port: z.number().int().min(1).max(65535).nullable().optional(),
});

/** The fields of Railpack's read the worker uses; the agent keeps its folders to itself. */
export const PlanBody = z.object({
  framework: z.string().max(256).nullable(),
  provider: z.string().max(256).nullable(),
  installCommand: z.string().max(16 * 1024),
  buildCommand: z.string().max(16 * 1024),
  startCommand: z.string().max(16 * 1024),
  staticSite: z.boolean(),
  warnings: z.array(z.string().max(4 * 1024)).max(100),
  planJson: z.string().max(4 * 1024 * 1024),
});

export const CacheRequest = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("du"), timeoutMs: z.number().int().min(1).max(3_600_000) }),
  z.strictObject({ op: z.literal("prune"), timeoutMs: z.number().int().min(1).max(3_600_000) }),
  z.strictObject({ op: z.literal("pruneScope"), scope: argvWord, timeoutMs: z.number().int().min(1).max(3_600_000) }),
  z.strictObject({ op: z.literal("trim"), keepBytes: z.number().int().min(0) }),
]);
export type CacheRequest = z.infer<typeof CacheRequest>;

export const JoinLine = z.strictObject({ join: z.string().min(1).max(512) });

export const LINK_LIMITS = {
  /** The whole handshake, outer and inner. */
  handshakeMs: 10_000,
  /** One WebSocket message on the way in, and what each end cuts its own writes to. */
  wsMaxPayload: 1024 * 1024,
  wsWriteBytes: 256 * 1024,
  /** Connections that have not proven a pin yet. */
  maxUnauthenticated: 32,
  /** A join line, and how long the worker waits for it. */
  joinLineBytes: 4 * 1024,
  joinLineMs: 10_000,
  h2MaxSessionMemoryMb: 64,
  /** One log follow per container is a stream each, and a call past this would wait for one to end. */
  h2MaxConcurrentStreams: 256,
  /** Log follows one server may hold, so what is left of the streams always carries Docker calls and builds. */
  logFollowsMax: 200,
  h2InitialWindow: 4 * 1024 * 1024,
  /** Most of the bandwidth a session may have outstanding across streams. */
  h2SessionWindow: 32 * 1024 * 1024,
  pingEveryMs: 15_000,
  /** Two unanswered pings end the session. */
  pingMisses: 2,
  redialFirstMs: 1_000,
  redialMaxMs: 60_000,
  redialJitter: 0.2,
  /** The first line of a build. */
  buildHeaderBytes: 8 * 1024 * 1024,
  /** A build's context, when a server's own config says nothing else. A caller may ask for less, never more. */
  contextBytesDefault: 2 * 1024 ** 3,
} as const;
