// The cross-field rules of a new app that the contract schema cannot say. A spec cannot ask for a
// host port, privileged mode, a capability or a host path: the contract has no field for them,
// and containerSpec() in the worker refuses them again.
import type { z } from "zod";
import { projects as P, refusedPull } from "@dockify/contracts";
import { isBlockedHost, repoHostOf } from "./host-rule.ts";

/** The environment's own branch is not a pin: the app follows the environment until someone picks another. */
export const pinnedBranch = (chosen: string | null | undefined, environmentBranch: string): string | null => (chosen && chosen !== environmentBranch ? chosen : null);

export type AppSpec = z.infer<typeof P.AppSpec>;
export type AppKind = AppSpec["kind"];

export interface Refusal {
  /** Dotted path into the body, for the field the UI highlights. */
  field: string;
  reason: string;
}

const STATEFUL = new Set<AppKind>(["postgres", "redis", "s3"]);
const SERVICE_KIND = { postgres: "postgres", redis: "redis", minio: "s3" } as const satisfies Record<string, AppKind>;

/**
 * Must match the list in apps/web/components/new-app/service-versions.ts (versions.test.ts checks).
 * The worker pins the digest the tag resolves to on first deploy, so later deploys never follow the tag.
 */
export const SERVICE_IMAGES: Record<keyof typeof SERVICE_KIND, Record<string, string>> = {
  postgres: { "17": "postgres:17-alpine", "16": "postgres:16-alpine", "15": "postgres:15-alpine" },
  redis: { "8.2": "redis:8.2-alpine", "7.4": "redis:7.4-alpine" },
  minio: {},
};
export const SERVICE_DEFAULT_VERSION = { postgres: "17", redis: "8.2" } as const;
export const SERVICE_PORTS: Record<keyof typeof SERVICE_KIND, number> = { postgres: 5432, redis: 6379, minio: 9000 };
export const STORAGE_UNAVAILABLE = "Storage is not available: MinIO no longer publishes an image Dockify can run. Use S3 compatible storage from your provider instead.";

/** Paths a volume may never cover. Keep in step with containerSpec() in the worker. */
const FORBIDDEN_MOUNTS = ["/", "/proc", "/sys", "/dev", "/etc", "/bin", "/sbin", "/usr", "/lib", "/lib64", "/boot", "/run", "/var/run"];
/** Variables Dockify sets itself; a tenant may not shadow them. */
const RESERVED_ENV = /^(DOCKIFY_|PORT$)/;

const isForbiddenMount = (path: string): boolean => {
  const p = path.replace(/\/+$/, "") || "/";
  if (p.split("/").includes("..")) return true;
  return FORBIDDEN_MOUNTS.some((f) => p === f || (f !== "/" && p.startsWith(`${f}/`)));
};

export function checkSpec(spec: AppSpec, at = ""): Refusal[] {
  const out: Refusal[] = [];
  const f = (field: string) => (at ? `${at}.${field}` : field);
  const src = spec.source;

  if (src.type === "service") {
    if (spec.kind !== SERVICE_KIND[src.service]) out.push({ field: f("kind"), reason: `A ${src.service} service is an app of kind ${SERVICE_KIND[src.service]}` });
    if (src.service === "minio") out.push({ field: f("source.service"), reason: STORAGE_UNAVAILABLE });
    else if (!SERVICE_IMAGES[src.service][src.version]) {
      out.push({ field: f("source.version"), reason: `Supported ${src.service} versions: ${Object.keys(SERVICE_IMAGES[src.service]).join(", ")}` });
    }
    if (spec.build) out.push({ field: f("build"), reason: "A managed service has no build settings" });
    if (spec.run?.startCommand) out.push({ field: f("run.startCommand"), reason: "A managed service runs its own command" });
    if (spec.volumes?.length) out.push({ field: f("volumes"), reason: "A managed service keeps its data on its own volume, which Dockify creates" });
    if (spec.env?.length) out.push({ field: f("env"), reason: "A managed service takes no variables; Dockify sets its credentials and configuration" });
  } else {
    if (STATEFUL.has(spec.kind)) out.push({ field: f("kind"), reason: "Databases and storage are created from the service source" });
  }

  if (src.type === "git") {
    if (isBlockedHost(repoHostOf(src.repoUrl))) out.push({ field: f("source.repoUrl"), reason: "That repository host is not reachable from Dockify" });
    if (spec.run) out.push({ field: f("run"), reason: "A git app sets its start command in build settings" });
    if (spec.build?.builder === "dockerfile" && spec.build.dockerfilePath === "") {
      out.push({ field: f("build.dockerfilePath"), reason: "Name the Dockerfile to build" });
    }
  }

  if (src.type === "image") {
    const refused = refusedPull(src.image);
    if (refused) out.push({ field: f("source.image"), reason: refused });
    if (spec.build) out.push({ field: f("build"), reason: "A prebuilt image has no build settings" });
  }

  if (spec.target === "vercel") {
    if (spec.kind !== "frontend" || src.type !== "git") out.push({ field: f("target"), reason: "Only a frontend built from git can deploy to Vercel" });
    if (spec.volumes?.length) out.push({ field: f("volumes"), reason: "A Vercel deployment has no volumes" });
  }

  const paths = new Set<string>();
  const names = new Set<string>();
  spec.volumes?.forEach((v, i) => {
    if (isForbiddenMount(v.path)) out.push({ field: f(`volumes.${i}.path`), reason: `${v.path} cannot be a volume mount` });
    if (paths.has(v.path)) out.push({ field: f(`volumes.${i}.path`), reason: `${v.path} is mounted twice` });
    if (names.has(v.name)) out.push({ field: f(`volumes.${i}.name`), reason: `${v.name} is used twice` });
    paths.add(v.path);
    names.add(v.name);
  });

  const keys = new Set<string>();
  spec.env?.forEach((e, i) => {
    if (RESERVED_ENV.test(e.key)) out.push({ field: f(`env.${i}.key`), reason: `${e.key} is set by Dockify` });
    // Hook keys have one door: the variables page, where they are confirmed and audited.
    if (P.isDangerousEnvKey(e.key)) out.push({ field: f(`env.${i}.key`), reason: `Set ${e.key} from the project's variables page, where it needs an explicit confirmation` });
    if (keys.has(e.key)) out.push({ field: f(`env.${i}.key`), reason: `${e.key} is set twice` });
    keys.add(e.key);
  });
  return out;
}

/** Namespaced by app so two apps never share a volume; 128 is docker's name limit. */
export const dockerVolumeName = (appId: string, name: string): string => `dk-${appId.replace(/-/g, "").slice(0, 12)}-${name}`.slice(0, 128);

export function appColumns(spec: AppSpec): {
  kind: AppKind;
  deployTarget: "server" | "vercel";
  image: string | null;
  registryId: string | null;
  gitRepository: string | null;
  gitBranch: string | null;
  rootDir: string | null;
  dockerfilePath: string | null;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  port: number | null;
  builder: "auto" | "dockerfile" | "railpack";
  framework: string | null;
  gitRepoId: string | null;
} {
  const src = spec.source;
  const empty = (v: string | undefined): string | null => (v === undefined || v === "" ? null : v);
  const base = {
    kind: spec.kind,
    deployTarget: spec.target,
    vercelFollowOnly: spec.target === "vercel",
    image: null as string | null,
    registryId: null as string | null,
    gitRepository: null as string | null,
    gitBranch: null as string | null,
    rootDir: null as string | null,
    dockerfilePath: null as string | null,
    installCommand: null as string | null,
    buildCommand: null as string | null,
    startCommand: null as string | null,
    port: null as number | null,
    builder: "auto" as "auto" | "dockerfile" | "railpack",
    framework: null as string | null,
    gitRepoId: null as string | null,
  };
  if (src.type === "git") {
    const b = spec.build;
    return {
      ...base,
      gitRepository: src.repoUrl,
      gitBranch: src.branch,
      rootDir: empty(b?.rootDir),
      dockerfilePath: b?.builder === "dockerfile" ? empty(b.dockerfilePath) ?? "Dockerfile" : null,
      installCommand: empty(b?.installCommand),
      buildCommand: empty(b?.buildCommand),
      startCommand: empty(b?.startCommand),
      port: b?.port ?? null,
      builder: b?.builder ?? "auto",
      framework: b?.framework ?? null,
      gitRepoId: src.git?.repoId ?? null,
    };
  }
  if (src.type === "image") {
    return { ...base, image: src.image, registryId: src.registryId, startCommand: empty(spec.run?.startCommand), port: spec.run?.port ?? null };
  }
  return { ...base, image: SERVICE_IMAGES[src.service][src.version] ?? null, port: spec.run?.port ?? SERVICE_PORTS[src.service] };
}

