/**
 * containerSpec() is the ONLY place a Docker container create body is made. Every tenant container,
 * one-off release command and preview goes through it, and assertSafeSpec() re-checks the final body
 * just before it reaches the daemon, so a bug in a caller (or a body built by hand) cannot slip
 * privileges past the policy.
 *
 * Always: CapDrop ALL plus a fixed minimal add-back, no-new-privileges, a memory cap with no extra
 * swap, a CPU cap and a lower CPU weight than the control plane, a pids cap, a log size cap, a named
 * Dockify network, and none of an image's own labels on the keys Compose and Dockify read.
 * Never: privileged, host network, PID,
 * IPC, UTS, user or cgroup namespaces, devices, bind mounts, host ports, or host-gateway.
 */
import { CAPABILITY_ALLOWLIST, defaultCpuCores, isAllowedSysctl } from "@dockify/contracts";

export class ContainerPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerPolicyError";
  }
}

/**
 * What every container gets back after CapDrop ALL: enough for an entrypoint to chown its data
 * dir and drop to a service user (postgres, nginx, redis). Not user selectable. Compared with
 * Docker's default set this removes MKNOD, NET_RAW, SETFCAP, SETPCAP, SYS_CHROOT, AUDIT_WRITE, FSETID.
 */
export const BASE_CAPABILITIES = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID", "KILL", "NET_BIND_SERVICE"] as const;
const ALLOWED_CAPS = new Set<string>([...BASE_CAPABILITIES, ...CAPABILITY_ALLOWLIST]);

export const DEFAULT_MEMORY_MB = 512;
export const MAX_MEMORY_MB = 262_144;
export const DEFAULT_PIDS = 512;
export const MAX_PIDS = 65_536;
export const MAX_CPU_CORES = 64;
/** Docker's default weight is 1024, which the control plane keeps: under contention it gets twice a tenant's share. */
export const TENANT_CPU_SHARES = 512;
export const LOG_MAX_SIZE = "10m";
export const LOG_MAX_FILES = "3";

/**
 * Docker merges an image's labels into its container's unless the create body sets that key, so a
 * Dockerfile (a fork's included) could otherwise claim to be a Compose service, and `docker compose
 * exec` would run the update's dump, the restore or `dockify admin` inside it, or claim Dockify's own
 * labels. Each of these is always in the body, blank unless the caller set it.
 */
const COMPOSE_LABELS = ["com.docker.compose.project", "com.docker.compose.service", "com.docker.compose.oneoff", "com.docker.compose.container-number"] as const;
const IMAGE_MAY_NOT_SET = [
  ...COMPOSE_LABELS,
  "dockify.app", "dockify.deployment", "dockify.environment", "dockify.project", "dockify.role", "dockify.preview", "dockify.preview.app",
] as const;
const blankLabels = (): Record<string, string> => Object.fromEntries(IMAGE_MAY_NOT_SET.map((k) => [k, ""]));

const NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
/**
 * A tenant's network: an environment's, a preview's, or the helpers'. Never a Compose network
 * (dockify_control, dockify_data), whose names start with "dockify_", or the deploy network.
 */
const NETWORK = /^dockify-(?:env-[a-z0-9-]{1,60}|pv-[a-z0-9-]{1,60}|helpers)$/;
/**
 * A tenant's volume: a managed service's data, an app's or preview's own, a restore test's copy, or
 * an anonymous one (64 hex characters) that a data helper reads. Never a Compose volume such as
 * dockify_dockify-db, which holds the control plane's database.
 */
const VOLUME = /^(?:dockify-data-[a-z0-9-]{1,100}|dk-[a-z0-9][a-z0-9_.-]{0,124}|[0-9a-f]{64})$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const IMAGE_REF = /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::\d{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[\w][\w.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;
/** Paths a volume may never cover: the kernel interfaces and the container root itself. */
const FORBIDDEN_MOUNTS = ["/", "/proc", "/sys", "/dev", "/etc", "/bin", "/sbin", "/usr", "/lib", "/lib64", "/boot", "/run", "/var/run"];

/** A pinned image id or a reference: what a create body's Image may be. */
export const isImageReference = (image: string): boolean => IMAGE_ID.test(image) || IMAGE_REF.test(image);

export interface VolumeMount {
  /** The Docker named volume. Never a host path. */
  name: string;
  mountPath: string;
  readOnly?: boolean;
}

export interface ContainerInput {
  name: string;
  /** A pinned image id (sha256:...) or a reference. */
  image: string;
  network: string;
  /** DNS names other containers on the network use for this one. */
  aliases?: string[];
  env?: Record<string, string>;
  /** Replaces the image's ENTRYPOINT when set; left out, the image's own runs. */
  entrypoint?: string[];
  cmd?: string[];
  /** Port the app listens on inside its network. Never published on the host. */
  port?: number | null;
  memoryMb?: number | null;
  cpuCores?: number | null;
  pidsLimit?: number | null;
  /** From the shared allowlist only (NET_ADMIN, NET_RAW). */
  capAdd?: readonly string[];
  /** net.ipv4.* and net.ipv6.conf.* only. */
  sysctls?: Record<string, string>;
  volumes?: VolumeMount[];
  readOnlyRootfs?: boolean;
  user?: string;
  labels?: Record<string, string>;
  restart?: "no" | "unless-stopped" | "on-failure";
  healthcheck?: { test: string[]; intervalSeconds: number; timeoutSeconds: number; retries: number; startSeconds: number };
}

/** The subset of the Docker Engine ContainerCreate body Dockify produces. */
export interface ContainerSpec {
  Image: string;
  Env: string[];
  Entrypoint?: string[];
  Cmd?: string[];
  User?: string;
  Labels: Record<string, string>;
  ExposedPorts?: Record<string, Record<string, never>>;
  Healthcheck?: { Test: string[]; Interval: number; Timeout: number; Retries: number; StartPeriod: number };
  HostConfig: {
    CapDrop: string[];
    CapAdd: string[];
    SecurityOpt: string[];
    Privileged: false;
    ReadonlyRootfs: boolean;
    Tmpfs?: Record<string, string>;
    Memory: number;
    MemorySwap: number;
    NanoCpus: number;
    CpuShares: number;
    PidsLimit: number;
    Init: true;
    IpcMode: "private";
    NetworkMode: string;
    Mounts: Array<{ Type: "volume"; Source: string; Target: string; ReadOnly: boolean }>;
    Sysctls?: Record<string, string>;
    LogConfig: { Type: "json-file"; Config: { "max-size": string; "max-file": string } };
    RestartPolicy: { Name: string; MaximumRetryCount?: number };
    PortBindings: Record<string, never>;
    PublishAllPorts: false;
  };
  NetworkingConfig: { EndpointsConfig: Record<string, { Aliases: string[] }> };
}

const deny = (message: string): never => {
  throw new ContainerPolicyError(message);
};

const MIB = 1024 * 1024;
const wholeIn = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;

function checkMountPath(p: string): void {
  if (!p.startsWith("/") || p.includes("..") || p.includes("\\") || p.length > 200) deny(`volume path ${p} must be an absolute path without ".."`);
  const norm = p.replace(/\/+$/, "") || "/";
  if (FORBIDDEN_MOUNTS.some((f) => norm === f || (f !== "/" && norm.startsWith(`${f}/`)))) deny(`volume path ${p} is reserved`);
}

/** `hostCores`: the server's core count, what a tenant with no limit of its own gets its default from. */
export function containerSpec(input: ContainerInput, hostCores?: number | null): ContainerSpec {
  if (!NAME.test(input.name)) deny(`container name ${input.name} is not allowed`);
  if (!isImageReference(input.image)) deny(`image ${input.image} is not a valid image reference`);
  if (!NETWORK.test(input.network)) deny(`network ${input.network} is not a Dockify network`);

  const capAdd = [...new Set(input.capAdd ?? [])];
  for (const cap of capAdd) {
    if (!(CAPABILITY_ALLOWLIST as readonly string[]).includes(cap)) deny(`capability ${cap} is not on the allowlist`);
  }
  const sysctls = input.sysctls ?? {};
  for (const [k, v] of Object.entries(sysctls)) {
    if (!isAllowedSysctl(k)) deny(`sysctl ${k} is not on the allowlist`);
    if (!/^[\w.:-]{0,64}$/.test(v)) deny(`sysctl ${k} has an invalid value`);
  }

  const memoryMb = input.memoryMb ?? DEFAULT_MEMORY_MB;
  if (!wholeIn(memoryMb, 6, MAX_MEMORY_MB)) deny(`memory limit ${memoryMb} MB is out of range`);
  const pids = input.pidsLimit ?? DEFAULT_PIDS;
  if (!wholeIn(pids, 16, MAX_PIDS)) deny(`pids limit ${pids} is out of range`);
  // An app with no limit of its own gets the default, so no tenant ever runs without one. A default
  // read from the wrong machine would be a silent wrong limit, so an unknown count is refused.
  const cpu = input.cpuCores ?? (hostCores ? defaultCpuCores(hostCores) : deny(`container ${input.name} has no CPU limit and this server's core count is not known`));
  if (!(Number.isFinite(cpu) && cpu >= 0.01 && cpu <= MAX_CPU_CORES)) deny(`cpu limit ${cpu} is out of range`);

  const env: string[] = [];
  for (const [k, v] of Object.entries(input.env ?? {})) {
    if (!ENV_KEY.test(k)) deny(`env key ${k} is not allowed`);
    if (v.includes("\0")) deny(`env ${k} contains a NUL byte`);
    env.push(`${k}=${v}`);
  }

  const seenPaths = new Set<string>();
  const mounts = (input.volumes ?? []).map((m) => {
    if (!VOLUME.test(m.name)) deny(`volume ${m.name} must be a named volume`);
    checkMountPath(m.mountPath);
    if (seenPaths.has(m.mountPath)) deny(`two volumes mount at ${m.mountPath}`);
    seenPaths.add(m.mountPath);
    return { Type: "volume" as const, Source: m.name, Target: m.mountPath, ReadOnly: m.readOnly ?? false };
  });

  if (input.port != null && !wholeIn(input.port, 1, 65535)) deny(`port ${input.port} is out of range`);
  for (const a of input.aliases ?? []) if (!NAME.test(a)) deny(`network alias ${a} is not allowed`);
  if (input.user !== undefined && !/^[\w.-]{1,64}(?::[\w.-]{1,64})?$/.test(input.user)) deny(`user ${input.user} is not allowed`);

  const memoryBytes = memoryMb * 1024 * 1024;
  const readOnly = input.readOnlyRootfs ?? false;
  const restart = input.restart ?? "unless-stopped";
  const spec: ContainerSpec = {
    Image: input.image,
    Env: env,
    ...(input.entrypoint ? { Entrypoint: [...input.entrypoint] } : {}),
    ...(input.cmd ? { Cmd: [...input.cmd] } : {}),
    ...(input.user ? { User: input.user } : {}),
    Labels: { ...blankLabels(), ...(input.labels ?? {}), "dockify.managed": "true" },
    ...(input.port != null ? { ExposedPorts: { [`${input.port}/tcp`]: {} } } : {}),
    ...(input.healthcheck
      ? {
          Healthcheck: {
            Test: input.healthcheck.test,
            Interval: input.healthcheck.intervalSeconds * 1e9,
            Timeout: input.healthcheck.timeoutSeconds * 1e9,
            Retries: input.healthcheck.retries,
            StartPeriod: input.healthcheck.startSeconds * 1e9,
          },
        }
      : {}),
    HostConfig: {
      CapDrop: ["ALL"],
      CapAdd: [...BASE_CAPABILITIES, ...capAdd],
      SecurityOpt: ["no-new-privileges:true"],
      Privileged: false,
      ReadonlyRootfs: readOnly,
      ...(readOnly ? { Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" } } : {}),
      Memory: memoryBytes,
      MemorySwap: memoryBytes,
      NanoCpus: Math.round(cpu * 1e9),
      CpuShares: TENANT_CPU_SHARES,
      PidsLimit: pids,
      Init: true,
      IpcMode: "private",
      NetworkMode: input.network,
      Mounts: mounts,
      ...(Object.keys(sysctls).length ? { Sysctls: { ...sysctls } } : {}),
      LogConfig: { Type: "json-file", Config: { "max-size": LOG_MAX_SIZE, "max-file": LOG_MAX_FILES } },
      RestartPolicy: restart === "on-failure" ? { Name: "on-failure", MaximumRetryCount: 5 } : { Name: restart },
      PortBindings: {},
      PublishAllPorts: false,
    },
    NetworkingConfig: { EndpointsConfig: { [input.network]: { Aliases: [...(input.aliases ?? [])] } } },
  };
  assertSafeSpec(spec);
  return spec;
}

const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === "" || v === false || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && Object.keys(v as object).length === 0);

/**
 * Re-checks any container create body against the policy, independent of how it was built.
 * Call it on the exact object handed to the Docker API.
 */
export function assertSafeSpec(spec: unknown): void {
  if (typeof spec !== "object" || spec === null) deny("container spec is not an object");
  const s = spec as Record<string, unknown>;
  const hc = (s.HostConfig ?? deny("container spec has no HostConfig")) as Record<string, unknown>;

  if (hc.Privileged !== false && hc.Privileged !== undefined) deny("privileged containers are never allowed");
  const capDrop = hc.CapDrop;
  if (!Array.isArray(capDrop) || capDrop.length !== 1 || capDrop[0] !== "ALL") deny("CapDrop must be exactly [ALL]");
  for (const cap of (hc.CapAdd as unknown[] | undefined) ?? []) {
    if (typeof cap !== "string" || !ALLOWED_CAPS.has(cap.replace(/^CAP_/, ""))) deny(`capability ${String(cap)} is not allowed`);
  }
  // Exactly this and nothing else: a seccomp=<json> or apparmor= entry replaces a profile without
  // ever saying "unconfined", so matching bad values cannot be enough.
  const secOpt = hc.SecurityOpt;
  if (!Array.isArray(secOpt) || secOpt.length !== 1 || secOpt[0] !== "no-new-privileges:true") deny("SecurityOpt must be exactly [no-new-privileges:true]");

  const net = String(hc.NetworkMode ?? "");
  if (!NETWORK.test(net)) deny(`network mode ${net || "(default)"} is not a Dockify network`);
  for (const key of ["PidMode", "UTSMode", "UsernsMode", "CgroupnsMode", "Cgroup"] as const) {
    const v = hc[key];
    if (v !== undefined && v !== "" && v !== "private") deny(`${key} ${String(v)} is not allowed`);
  }
  if (hc.IpcMode !== undefined && hc.IpcMode !== "private" && hc.IpcMode !== "none") deny(`IpcMode ${String(hc.IpcMode)} is not allowed`);

  for (const key of ["Binds", "Devices", "DeviceRequests", "DeviceCgroupRules", "VolumesFrom", "Links", "CgroupParent", "Runtime", "VolumeDriver"] as const) {
    if (!isEmpty(hc[key])) deny(`${key} is never allowed`);
  }
  if (hc.OomKillDisable === true) deny("OomKillDisable is not allowed");
  if (hc.PublishAllPorts === true) deny("publishing ports on the host is not allowed");
  if (!isEmpty(hc.PortBindings)) deny("publishing ports on the host is not allowed");
  for (const h of (hc.ExtraHosts as unknown[] | undefined) ?? []) {
    if (String(h).includes("host-gateway")) deny("host-gateway would expose the host to the container");
  }
  for (const m of (hc.Mounts as Array<Record<string, unknown>> | undefined) ?? []) {
    if (m.Type !== "volume") deny(`mount type ${String(m.Type)} is not allowed`);
    if (!VOLUME.test(String(m.Source ?? ""))) deny(`volume ${String(m.Source)} must be a named volume`);
    checkMountPath(String(m.Target ?? ""));
    const opts = m.VolumeOptions as Record<string, unknown> | undefined;
    if (opts?.DriverConfig) deny("volume driver options are not allowed");
  }
  for (const [k] of Object.entries((hc.Sysctls as Record<string, string> | undefined) ?? {})) {
    if (!isAllowedSysctl(k)) deny(`sysctl ${k} is not allowed`);
  }
  // The same bounds containerSpec holds its input to, for a body that did not come from it. A limit past
  // these is no limit: one tenant could starve or OOM the control plane on the same host.
  const mem = hc.Memory;
  if (typeof mem !== "number" || mem <= 0) deny("a memory limit is required");
  if (!wholeIn(mem as number, 6 * MIB, MAX_MEMORY_MB * MIB)) deny("the memory limit is out of range");
  if (hc.MemorySwap !== mem) deny("swap beyond the memory limit is not allowed");
  const pids = hc.PidsLimit;
  if (typeof pids !== "number" || pids <= 0) deny("a pids limit is required");
  if (!wholeIn(pids as number, 16, MAX_PIDS)) deny("the pids limit is out of range");
  if (typeof hc.NanoCpus !== "number" || hc.NanoCpus <= 0) deny("a cpu limit is required");
  if (!wholeIn(hc.NanoCpus as number, 0.01 * 1e9, MAX_CPU_CORES * 1e9)) deny("the cpu limit is out of range");
  if (hc.CpuShares !== TENANT_CPU_SHARES) deny(`CpuShares must be ${TENANT_CPU_SHARES}, below the control plane's`);
  const labels = (s.Labels ?? {}) as Record<string, unknown>;
  for (const key of COMPOSE_LABELS) if (labels[key] !== "") deny(`${key} must be blank on a tenant container, or an image could pose as a Compose service`);
  const log = hc.LogConfig as { Type?: string; Config?: Record<string, string> } | undefined;
  if (!log?.Config?.["max-size"] || !log.Config["max-file"]) deny("a log size cap is required");
  if (log?.Type !== "json-file" || log.Config?.["max-size"] !== LOG_MAX_SIZE || log.Config["max-file"] !== LOG_MAX_FILES) deny("logs must use json-file with the fixed size cap");
}
