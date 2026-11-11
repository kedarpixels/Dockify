/**
 * The narrow gate in front of this server's Docker. A node:http server with no port, fed by the link's
 * streams, so the worker's Docker client works unchanged. Every call must match a rule here, and only
 * then goes on to the socket proxy's allowlist (deploy/socket-proxy/haproxy.cfg), which reads no bodies.
 * This module reads the bodies, by exact keys: a key it does not know is refused, so a new Docker
 * feature cannot widen what a compromised control plane can ask for. That is what stops it being host
 * root: no bind mount of /, no control network, no volume with a driver, no privileged exec.
 *
 * What it does not stop, by design: running any image inside tenant limits, reading a tenant's env.
 * That is what a control plane is for.
 *
 * What reaches the socket proxy is never the caller's bytes. A body is parsed, checked, and written again
 * by this module, so a parser that reads the same bytes differently (Go merges two equal keys, and folds
 * a key's case) has nothing of the caller's to read. A call with no body rule takes no body and no
 * Content-Type at all, because Docker reads a form body too, and its fields win over the query.
 */
import { assertSafeSpec, ContainerPolicyError, endWhenDone, isImageReference, LOG_MAX_FILES, LOG_MAX_SIZE } from "@dockify/engine";
import { isIP, connect as netConnect } from "node:net";
import { createServer, request, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { refusedPull } from "./registry-host.ts";
import { foldedKeyProblem, isObject, isStrings } from "./strict-json.ts";

export interface GateUpstream {
  host: string;
  port: number;
}

/** The body cap for a call this module has to read. A create holds an app's whole env. */
const MAX_BODY = 8 * 1024 * 1024;
/** Every body being read at once. The agent's mem_limit is 512m and a link holds up to 256 streams. */
const MAX_BUFFERED = 128 * 1024 * 1024;
const INSPECT_CACHE_MS = 60_000;
/** How much of an answer too large to hold is read: enough for its first key, a container's id. */
const HEAD_BYTES = 256;
/** A response's headers, in front of a tunnel. */
const MAX_ANSWER_HEAD = 64 * 1024;

/** What a tenant's names look like, the same as the socket proxy's and container-spec's. */
const TENANT_NETWORK = /^dockify-(?:env-[a-z0-9-]{1,60}|pv-[a-z0-9-]{1,60}|helpers)$/;
const TENANT_VOLUME = /^(?:dockify-data-[a-z0-9-]{1,100}|dk-[a-z0-9][a-z0-9_.-]{0,124})$/;
const CONTAINER_NAME = /^(?:dk-|dockify-(?:rt|bk|rs)-)[A-Za-z0-9_.-]{1,200}$/;
const FULL_ID = /^[a-f0-9]{64}$/;
/** A name a tenant container may answer to on its network. */
const ALIAS = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const ENV_ENTRY = /^[A-Za-z_][A-Za-z0-9_]{0,127}=/;
const USER = /^[\w.-]{1,64}(?::[\w.-]{1,64})?$/;
const SYSCTL_VALUE = /^[\w.:-]{0,64}$/;
const EXPOSED_PORT = /^\d{1,5}\/tcp$/;
/**
 * The names the control plane's own containers answer to. Docker's DNS gives a container's name and its
 * aliases on its network, and ignores case, so any spelling on a network the agent or Traefik has joined
 * could stand in for them (the agent's dial resolves dk-proxy by name). A trailing dot reads the same.
 */
const RESERVED_NAMES = new Set(["dk-proxy", "dockify-proxy", "dockify-agent"]);
const isReservedName = (name: string): boolean => RESERVED_NAMES.has(name.toLowerCase().replace(/\.+$/, ""));

export class GateRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateRefusal";
  }
}
const refuse = (message: string): never => {
  throw new GateRefusal(message);
};

const isOptionalBool = (v: unknown): boolean => v === undefined || typeof v === "boolean";
const isWhole = (v: unknown, lo: number, hi: number): boolean => typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi;
const isEmptyMap = (v: unknown): boolean => isObject(v) && Object.keys(v).length === 0;
/** A map Go reads as map[string]string. Its keys are data, and Go does not fold them. */
const isTextMap = (v: unknown): boolean => isObject(v) && Object.values(v).every((x) => typeof x === "string");

function exactKeys(o: Record<string, unknown>, allowed: ReadonlySet<string>, what: string): void {
  for (const k of Object.keys(o)) if (!allowed.has(k)) refuse(`${what} may not set ${k.slice(0, 80)}`);
}

const CREATE_KEYS = new Set(["Image", "Env", "Entrypoint", "Cmd", "User", "Labels", "ExposedPorts", "Healthcheck", "HostConfig", "NetworkingConfig"]);
const HOST_CONFIG_KEYS = new Set([
  "CapDrop", "CapAdd", "SecurityOpt", "Privileged", "ReadonlyRootfs", "Tmpfs", "Memory", "MemorySwap", "NanoCpus", "CpuShares", "PidsLimit",
  "Init", "IpcMode", "NetworkMode", "Mounts", "Sysctls", "LogConfig", "RestartPolicy", "PortBindings", "PublishAllPorts",
]);
const MOUNT_KEYS = new Set(["Type", "Source", "Target", "ReadOnly"]);
const HEALTH_KEYS = new Set(["Test", "Interval", "Timeout", "Retries", "StartPeriod"]);
const LOG_KEYS = new Set(["Type", "Config"]);
const LOG_CONFIG_KEYS = new Set(["max-size", "max-file"]);
const RESTART_KEYS = new Set(["Name", "MaximumRetryCount"]);
const RESTART_NAMES = new Set(["no", "unless-stopped", "on-failure"]);
/** What containerSpec gives on-failure is 5; a ceiling here, so the policy can move without a gate change. */
const MAX_RESTART_RETRIES = 10;
/** Nanoseconds: a month, far above any real healthcheck setting. */
const MAX_HEALTH_NS = 30 * 86_400 * 1e9;
/** The one tmpfs containerSpec adds, for a read-only root. */
const READONLY_TMPFS = JSON.stringify({ "/tmp": "rw,noexec,nosuid,size=64m" });

/** Every field of the HostConfig has its type here, so nothing below or in assertSafeSpec reads a coerced value. */
function checkHostConfig(host: Record<string, unknown>): void {
  exactKeys(host, HOST_CONFIG_KEYS, "a container's HostConfig");
  if (host.CapDrop !== undefined && !isStrings(host.CapDrop)) refuse("CapDrop must be a list of names");
  if (host.CapAdd !== undefined && !isStrings(host.CapAdd)) refuse("CapAdd must be a list of names");
  if (!isOptionalBool(host.ReadonlyRootfs)) refuse("ReadonlyRootfs must be true or false");
  if (host.Privileged !== undefined && host.Privileged !== false) refuse("privileged containers are never allowed");
  if (host.IpcMode !== "private") refuse("IpcMode must be private");
  if (typeof host.NetworkMode !== "string" || !TENANT_NETWORK.test(host.NetworkMode)) refuse(`network ${String(host.NetworkMode).slice(0, 80)} is not a tenant network`);
  if (!Array.isArray(host.Mounts)) refuse("Mounts must be a list");
  for (const m of host.Mounts as unknown[]) {
    if (!isObject(m)) return refuse("a mount must be an object");
    exactKeys(m, MOUNT_KEYS, "a mount");
    if (m.Type !== "volume") refuse("a mount must be a volume");
    if (typeof m.Source !== "string" || (!TENANT_VOLUME.test(m.Source) && !FULL_ID.test(m.Source))) refuse(`volume ${String(m.Source).slice(0, 80)} is not a tenant volume`);
    if (typeof m.Target !== "string") refuse("a mount needs a target");
    if (!isOptionalBool(m.ReadOnly)) refuse("ReadOnly must be true or false");
  }
  if (host.Tmpfs !== undefined && JSON.stringify(host.Tmpfs) !== READONLY_TMPFS) refuse("Tmpfs must be the read-only root's /tmp");
  if (host.Sysctls !== undefined) {
    if (!isTextMap(host.Sysctls)) refuse("Sysctls must be a map of text");
    for (const v of Object.values(host.Sysctls as Record<string, string>)) if (!SYSCTL_VALUE.test(v)) refuse("a sysctl has a bad value");
  }
  if (host.PortBindings !== undefined && !isEmptyMap(host.PortBindings)) refuse("no port is published on a host");
  if (host.PublishAllPorts !== undefined && host.PublishAllPorts !== false) refuse("no port is published on a host");
  if (host.Init !== true) refuse("Init must be true");
  const log = host.LogConfig;
  if (!isObject(log)) return refuse("logs must use json-file");
  exactKeys(log, LOG_KEYS, "LogConfig");
  if (log.Type !== "json-file") refuse("logs must use json-file");
  if (!isObject(log.Config)) return refuse("a log size cap is required");
  exactKeys(log.Config, LOG_CONFIG_KEYS, "LogConfig's Config");
  if (log.Config["max-size"] !== LOG_MAX_SIZE || log.Config["max-file"] !== LOG_MAX_FILES) refuse("the log size cap is fixed");
  const restart = host.RestartPolicy;
  if (!isObject(restart)) return refuse("that restart policy is not allowed");
  exactKeys(restart, RESTART_KEYS, "RestartPolicy");
  if (typeof restart.Name !== "string" || !RESTART_NAMES.has(restart.Name)) refuse("that restart policy is not allowed");
  if (restart.MaximumRetryCount !== undefined && (restart.Name !== "on-failure" || !isWhole(restart.MaximumRetryCount, 0, MAX_RESTART_RETRIES))) refuse("that restart policy is not allowed");
}

/** Throws unless a create body is one containerSpec() could have written. */
export function checkCreateBody(body: unknown): void {
  if (!isObject(body)) return refuse("a create body must be an object");
  const b = body;
  exactKeys(b, CREATE_KEYS, "a container");
  if (typeof b.Image !== "string" || !isImageReference(b.Image)) refuse("that image reference is not allowed");
  if (!isStrings(b.Env) || b.Env.some((e) => !ENV_ENTRY.test(e) || e.includes("\0"))) refuse("Env must be a list of NAME=value");
  if (b.Entrypoint !== undefined && !isStrings(b.Entrypoint)) refuse("Entrypoint must be a list of text");
  if (b.Cmd !== undefined && !isStrings(b.Cmd)) refuse("Cmd must be a list of text");
  if (b.User !== undefined && (typeof b.User !== "string" || !USER.test(b.User))) refuse("that user is not allowed");
  if (!isTextMap(b.Labels)) refuse("Labels must be a map of text");
  if (b.ExposedPorts !== undefined) {
    if (!isObject(b.ExposedPorts)) return refuse("ExposedPorts must be a map");
    for (const [k, v] of Object.entries(b.ExposedPorts)) if (!EXPOSED_PORT.test(k) || !isEmptyMap(v)) refuse("ExposedPorts must name tcp ports only");
  }
  const hc = b.HostConfig;
  if (!isObject(hc)) return refuse("a create body must have a HostConfig");
  checkHostConfig(hc);
  try {
    assertSafeSpec(b);
  } catch (e) {
    if (e instanceof ContainerPolicyError) refuse(e.message);
    throw e;
  }
  // assertSafeSpec holds the same pattern; this stays here so the gate says so whatever that file does.
  if (JSON.stringify(hc.SecurityOpt) !== JSON.stringify(["no-new-privileges:true"])) refuse("SecurityOpt must be exactly [no-new-privileges:true]");
  if (b.Healthcheck !== undefined) {
    if (!isObject(b.Healthcheck)) return refuse("a healthcheck must be an object");
    const h = b.Healthcheck;
    exactKeys(h, HEALTH_KEYS, "a healthcheck");
    if (!isStrings(h.Test)) refuse("a healthcheck's Test must be a list of text");
    for (const k of ["Interval", "Timeout", "StartPeriod"]) if (h[k] !== undefined && !isWhole(h[k], 0, MAX_HEALTH_NS)) refuse(`a healthcheck's ${k} is out of range`);
    if (h.Retries !== undefined && !isWhole(h.Retries, 0, 1_000_000)) refuse("a healthcheck's Retries is out of range");
  }
  if ((b.Labels as Record<string, string>)["dockify.managed"] !== "true") refuse("a container must carry dockify.managed=true");
  const net = hc.NetworkMode as string;
  const nc = b.NetworkingConfig;
  if (!isObject(nc)) return refuse("a create body must have a NetworkingConfig");
  exactKeys(nc, new Set(["EndpointsConfig"]), "NetworkingConfig");
  const eps = nc.EndpointsConfig;
  if (!isObject(eps) || Object.keys(eps).length !== 1 || !Object.hasOwn(eps, net)) return refuse("a container joins only its own network");
  const ep = eps[net];
  if (!isObject(ep)) return refuse("a container joins only its own network");
  exactKeys(ep, new Set(["Aliases"]), "an endpoint");
  if (ep.Aliases !== undefined && !Array.isArray(ep.Aliases)) refuse("Aliases must be a list");
  for (const a of (ep.Aliases as unknown[] | undefined) ?? []) {
    if (typeof a !== "string" || !ALIAS.test(a) || isReservedName(a) || isIP(a)) refuse(`alias ${String(a).slice(0, 80)} is not allowed`);
  }
}

export function checkVolumeBody(body: unknown): void {
  if (!isObject(body)) return refuse("a volume body must be an object");
  exactKeys(body, new Set(["Name", "Labels"]), "a volume");
  if (typeof body.Name !== "string" || !TENANT_VOLUME.test(body.Name)) refuse(`volume ${String(body.Name).slice(0, 80)} is not a tenant volume`);
  if (body.Labels !== undefined && !isTextMap(body.Labels)) refuse("Labels must be a map of text");
}

/** The exact body DockerClient.ensureNetwork sends. */
export function checkNetworkBody(body: unknown): void {
  if (!isObject(body)) return refuse("a network body must be an object");
  const b = body;
  exactKeys(b, new Set(["Name", "Driver", "Internal", "Attachable", "Labels", "CheckDuplicate", "Options"]), "a network");
  if (typeof b.Name !== "string" || !TENANT_NETWORK.test(b.Name)) refuse(`network ${String(b.Name).slice(0, 80)} is not a tenant network`);
  if (b.Driver !== "bridge") refuse("a network must use the bridge driver");
  if (b.Attachable !== false) refuse("a network must not be attachable");
  if (typeof b.Internal !== "boolean") refuse("a network must say whether it is internal");
  if (b.Labels !== undefined && !isTextMap(b.Labels)) refuse("Labels must be a map of text");
  if (!isOptionalBool(b.CheckDuplicate)) refuse("CheckDuplicate must be true or false");
  const opts = b.Options;
  if (!isObject(opts)) return refuse("a network must name its bridge");
  exactKeys(opts, new Set(["com.docker.network.bridge.name"]), "a network's options");
  const bridge = opts["com.docker.network.bridge.name"];
  if (typeof bridge !== "string" || !/^dk-[0-9a-f]{12}$/.test(bridge)) refuse("a bridge must be named dk-<hash>");
}

const networkMember = (allowAgent: boolean) => (body: unknown): void => {
  if (!isObject(body)) return refuse("the body must be an object");
  exactKeys(body, new Set(["Container", "Force"]), "a network change");
  if (!isOptionalBool(body.Force)) refuse("Force must be true or false");
  const c = body.Container;
  if (typeof c !== "string") return refuse("a network change must name a container");
  // The agent joins networks itself, and never by a call through here; only a sweep ever removes it.
  const ok = c === "dockify-proxy" || CONTAINER_NAME.test(c) || (allowAgent && c === "dockify-agent");
  if (!ok) refuse(`container ${c.slice(0, 80)} may not change networks`);
};

const isConsoleSize = (v: unknown): boolean => Array.isArray(v) && v.length === 2 && v.every((n) => isWhole(n, 0, 65_535));

/** What the terminal and the data module's dumps send. Never Privileged, and never a host path. */
export function checkExecBody(body: unknown): void {
  if (!isObject(body)) return refuse("an exec body must be an object");
  const b = body;
  exactKeys(b, new Set(["AttachStdin", "AttachStdout", "AttachStderr", "Tty", "Cmd", "Env", "User", "ConsoleSize"]), "an exec");
  if (!isStrings(b.Cmd) || !b.Cmd.length) refuse("an exec needs a command");
  for (const k of ["AttachStdin", "AttachStdout", "AttachStderr", "Tty"]) if (!isOptionalBool(b[k])) refuse(`${k} must be true or false`);
  if (b.Env !== undefined && (!isStrings(b.Env) || b.Env.some((e) => e.includes("\0")))) refuse("Env must be a list of text");
  if (b.User !== undefined && (typeof b.User !== "string" || !USER.test(b.User))) refuse("that user is not allowed");
  if (b.ConsoleSize !== undefined && !isConsoleSize(b.ConsoleSize)) refuse("ConsoleSize must be two numbers");
}

const checkExecStart = (body: unknown): void => {
  if (!isObject(body)) return refuse("an exec start body must be an object");
  exactKeys(body, new Set(["Detach", "Tty", "ConsoleSize"]), "an exec start");
  if (!isOptionalBool(body.Detach) || !isOptionalBool(body.Tty)) refuse("Detach and Tty must be true or false");
  if (body.ConsoleSize !== undefined && !isConsoleSize(body.ConsoleSize)) refuse("ConsoleSize must be two numbers");
};

/** The worker's hijack sends {} with an attach, and nothing else: an attach reads its options from the query. */
const checkEmpty = (body: unknown): void => {
  if (body !== undefined && !isEmptyMap(body)) refuse("this call takes no body");
};

/** Parses, checks and writes a body again: the one form of it that ever leaves this module. Null is no body. */
export function canonicalBody(raw: Buffer, check: (body: unknown) => void): Buffer | null {
  if (!raw.length) {
    check(undefined);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    refuse("that body is not JSON");
  }
  const problem = foldedKeyProblem(parsed);
  if (problem) refuse(`that body is not allowed: ${problem}`);
  check(parsed);
  return Buffer.from(JSON.stringify(parsed));
}

interface Rule {
  method: string;
  path: RegExp;
  /** Refused when a query is present and does not match. Absent means no query is allowed. */
  query?: RegExp;
  /** The query must be there. */
  queryRequired?: boolean;
  /** The container in the path must carry dockify.managed=true. */
  managed?: boolean;
  /**
   * Read and check the JSON body, and forward only what this module writes from it. A rule without one
   * takes no body and no Content-Type, so no rule ever passes on bytes it has not read.
   */
  body?: (body: unknown) => void;
  /** Its answer is a container inspect, whose env is dropped unless the container is a tenant's. */
  stripEnv?: boolean;
  /** Its answer may be a 101, and from then on the bytes are a process's stdio. */
  upgrade?: boolean;
  /** Carries a registry's credential, for that one pull. */
  registryAuth?: boolean;
  /** Reads the query once its form has passed: refuses what the form alone cannot say. */
  checkQuery?: (query: string) => void;
}

/** A pull is dockerd fetching from the host's network. Only the first field is a reference, by the rule's query. */
const checkPull = (query: string): void => {
  const m = /^fromImage=([^&]*)/.exec(query);
  const why = m ? refusedPull(decoded(m[1]!)) : null;
  if (why) refuse(why);
};

const seg = "([^/]+)";
const name = "((?:dk-|dockify-(?:rt|bk|rs)-)[A-Za-z0-9_.-]+)";
const anything = /^.*$/;

/** In the order of haproxy.cfg. docker-gate.test.ts holds them to every call the worker makes. */
const RULES: readonly Rule[] = [
  { method: "GET", path: /^\/containers\/json$/, query: anything },
  { method: "GET", path: new RegExp(`^/containers/${seg}/json$`), stripEnv: true, query: /^$/ },
  { method: "GET", path: new RegExp(`^/containers/${seg}/logs$`), managed: true, query: anything },
  { method: "GET", path: new RegExp(`^/containers/${seg}/stats$`), managed: true, query: /^stream=(?:false|true)$/ },
  { method: "GET", path: /^\/images\/json$/, query: anything },
  { method: "GET", path: new RegExp(`^/images/${seg}/json$`) },
  { method: "GET", path: new RegExp(`^/networks/${seg}$`) },
  { method: "GET", path: /^\/networks$/, query: /^filters=%7B%22name%22%3A%5B%22dockify-(?:env|pv)-%22%5D%7D$/, queryRequired: true },
  { method: "GET", path: new RegExp(`^/exec/${seg}/json$`) },
  { method: "GET", path: /^\/system\/df$/, query: /^type=(?:image|volume)(?:&type=(?:image|volume))?$/, queryRequired: true },
  { method: "GET", path: /^\/events$/, query: /^filters=%7B%22type%22%3A%5B%22container%22%5D%2C%22event%22%3A%5B%22start%22%5D%2C%22label%22%3A%5B%22dockify\.managed%3Dtrue%22%5D%7D$/, queryRequired: true },

  { method: "POST", path: /^\/containers\/create$/, query: /^name=(?:dk-|dockify-(?:rt|bk|rs)-)[A-Za-z0-9_.-]{1,200}$/, queryRequired: true, body: checkCreateBody },
  { method: "POST", path: new RegExp(`^/containers/${seg}/start$`), managed: true },
  { method: "POST", path: new RegExp(`^/containers/${seg}/stop$`), managed: true, query: /^t=\d{1,4}$/ },
  { method: "POST", path: new RegExp(`^/containers/${seg}/kill$`), managed: true, query: /^signal=[A-Z0-9]{1,16}$/ },
  { method: "POST", path: new RegExp(`^/containers/(dk-[A-Za-z0-9_.-]+)/rename$`), managed: true, query: /^name=dk-[A-Za-z0-9_.-]+$/, queryRequired: true },
  { method: "POST", path: new RegExp(`^/containers/${seg}/wait$`), managed: true },
  { method: "DELETE", path: new RegExp(`^/containers/${seg}$`), managed: true, query: /^force=true&v=(?:true|false)$/ },
  { method: "POST", path: new RegExp(`^/containers/${name}/attach$`), managed: true, query: /^stream=1&stdout=1&stderr=1&stdin=[01]$/, body: checkEmpty, upgrade: true },
  { method: "POST", path: new RegExp(`^/containers/${name}/exec$`), managed: true, body: checkExecBody },
  { method: "POST", path: new RegExp(`^/exec/${seg}/start$`), body: checkExecStart, upgrade: true },
  { method: "POST", path: /^\/exec\/[0-9a-f]{64}\/resize$/, query: /^h=[0-9]{1,3}&w=[0-9]{1,3}$/, queryRequired: true },

  // A reference as URLSearchParams writes one: nothing else encoded, so no second field can hide in a value.
  { method: "POST", path: /^\/images\/create$/, query: /^fromImage=[A-Za-z0-9._-]*(?:%(?:2F|3A|40)[A-Za-z0-9._-]*)*(?:&tag=[A-Za-z0-9._-]+)?$/, queryRequired: true, registryAuth: true, checkQuery: checkPull },
  // By the id the worker read from Docker, or by the tag a build gave it. A tag of anything else stays,
  // and Docker refuses by itself to remove an image a container was made from without force.
  { method: "DELETE", path: /^\/images\/(?:sha256%3A[a-f0-9]{64}|dockify%2Fapp-[A-Za-z0-9._-]+%3A[A-Za-z0-9._-]+)$/, query: /^noprune=false$/ },

  { method: "POST", path: /^\/networks\/create$/, body: checkNetworkBody },
  { method: "POST", path: new RegExp(`^/networks/${seg}/connect$`), body: networkMember(false) },
  { method: "POST", path: new RegExp(`^/networks/${seg}/disconnect$`), body: networkMember(true) },
  { method: "DELETE", path: /^\/networks\/dockify-(?:env|pv)-[0-9a-f-]{36}$/ },
  { method: "POST", path: /^\/volumes\/create$/, body: checkVolumeBody },
  { method: "DELETE", path: /^\/volumes\/(?:dockify-data-|dk-)[^/]+$/ },
  { method: "DELETE", path: /^\/volumes\/[0-9a-f]{64}$/ },
];

/** The network named in a connect or disconnect must be a tenant's. */
const NETWORK_CHANGE = /^\/networks\/([^/]+)\/(?:connect|disconnect)$/;

const decoded = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return refuse("that path is not allowed");
  }
};

/** Splits off a version prefix the way the socket proxy allows it, and refuses what it would not parse. */
function splitUrl(url: string): { path: string; query: string; hasQuery: boolean } {
  const q = url.indexOf("?");
  const rawPath = q === -1 ? url : url.slice(0, q);
  const query = q === -1 ? "" : url.slice(q + 1);
  const path = rawPath.replace(/^\/v1\.[0-9]+(?=\/)/, "");
  const images = /^\/images\//.test(path);
  // An encoded slash could name a link alias (dk-x%2Fapi), and dots could walk out of a segment.
  if (/%2f|%5c/i.test(path) && !images) refuse("that path is not allowed");
  // Nothing Dockify sends encodes a dot, and an encoded one is only ever a way past the check below.
  if (/%2e|%00/i.test(path)) refuse("that path is not allowed");
  if (path.split("/").some((p) => p === ".." || p === ".")) refuse("that path is not allowed");
  // An image's name holds encoded slashes, so what it decodes to is checked as well: ..%2f..%2fcontainers.
  if (images && /\.\.|\\/.test(decoded(path))) refuse("that path is not allowed");
  return { path, query, hasQuery: q !== -1 };
}

/** A header by name, whatever its case: a real request's are lower case, a test's need not be. */
const header = (headers: Record<string, unknown>, wanted: string): string | undefined => {
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === wanted && v !== undefined) return String(v);
  return undefined;
};

/** Whether this request says a body follows. A Content-Length of 0 is what node:http sends for no body. */
const saysBody = (headers: Record<string, unknown>): boolean => {
  if (header(headers, "transfer-encoding") !== undefined) return true;
  const length = header(headers, "content-length");
  return length !== undefined && length.trim() !== "0";
};

const JSON_TYPE = /^application\/json(?:\s*;.*)?$/i;

export function ruleFor(method: string, url: string, headers: Record<string, unknown> = {}): { rule: Rule; match: RegExpExecArray; path: string } {
  const { path, query, hasQuery } = splitUrl(url);
  const contentType = header(headers, "content-type");
  for (const rule of RULES) {
    if (rule.method !== method) continue;
    const match = rule.path.exec(path);
    if (!match) continue;
    if (rule.queryRequired && !hasQuery) continue;
    if (hasQuery) {
      if (!rule.query) continue;
      if (!rule.query.test(query)) continue;
    }
    if (rule.body) {
      if (contentType !== undefined && !JSON_TYPE.test(contentType)) continue;
    } else if (contentType !== undefined || saysBody(headers)) {
      continue;
    }
    const net = NETWORK_CHANGE.exec(path);
    if (net && !TENANT_NETWORK.test(decoded(net[1]!))) refuse(`network ${net[1]} is not a tenant network`);
    const named = /^name=(.+)$/.exec(query)?.[1];
    if (named && isReservedName(named)) refuse(`the name ${named} is reserved`);
    rule.checkQuery?.(query);
    return { rule, match, path };
  }
  return refuse(`${method} ${path} is not a call this server takes`);
}

export interface DockerGate {
  /** One stream of the link: raw HTTP/1.1, one exchange. */
  handle(stream: Duplex): void;
  close(): void;
}

export function createDockerGate(upstream: GateUpstream, opts: { now?: () => number; maxBuffered?: number } = {}): DockerGate {
  const now = opts.now ?? (() => Date.now());
  const maxBuffered = opts.maxBuffered ?? MAX_BUFFERED;
  const managedById = new Map<string, { managed: boolean; at: number }>();
  let buffered = 0;

  /** Reads one container's inspect through the socket proxy. Past the cap, `text` is only its start and `whole` is false. */
  const inspect = (ref: string): Promise<{ status: number; text: string; whole: boolean }> =>
    new Promise((resolve, reject) => {
      const req = request({ ...upstream, agent: false, method: "GET", path: `/v1.43/containers/${encodeURIComponent(ref)}/json` }, (res) => {
        const status = res.statusCode ?? 500;
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          if (size > MAX_BODY) return;
          size += c.length;
          chunks.push(c);
          if (size <= MAX_BODY) return;
          resolve({ status, text: Buffer.concat(chunks).subarray(0, HEAD_BYTES).toString("latin1"), whole: false });
          req.destroy();
        });
        res.on("end", () => resolve({ status, text: Buffer.concat(chunks).toString("utf8"), whole: true }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });

  /**
   * Whether Docker lists this exact container under dockify.managed=true. Only the start of the answer
   * is read: [] when the filter leaves nothing, and the id first when it leaves the container.
   */
  const listedAsManaged = (id: string): Promise<boolean> =>
    new Promise((resolve, reject) => {
      const filters = encodeURIComponent(JSON.stringify({ id: [id], label: ["dockify.managed=true"] }));
      const req = request({ ...upstream, agent: false, method: "GET", path: `/v1.43/containers/json?all=true&filters=${filters}` }, (res) => {
        let head = "";
        const settle = (ended: boolean): void => {
          const text = head.trimStart();
          if (!ended && text.length < HEAD_BYTES) return;
          res.removeAllListeners("data");
          req.destroy();
          if ((res.statusCode ?? 500) !== 200) reject(new Error(`Docker answered ${res.statusCode} to a list`));
          else if (/^\[\s*\]\s*$/.test(text)) resolve(false);
          else if (/^\[\s*\{\s*"Id"\s*:\s*"([a-f0-9]{64})"/.exec(text)?.[1] === id) resolve(true);
          else reject(new Error("a list answer could not be read"));
        };
        res.on("data", (c: Buffer) => {
          head += c.toString("latin1");
          settle(false);
        });
        res.on("end", () => settle(true));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });

  /** True when the container is a tenant's. Cached by full id only: a name can move. */
  const isManaged = async (ref: string): Promise<boolean | null> => {
    const hit = FULL_ID.test(ref) ? managedById.get(ref) : undefined;
    if (hit && now() - hit.at < INSPECT_CACHE_MS) return hit.managed;
    const { status, text, whole } = await inspect(ref);
    if (status === 404) return null;
    if (status >= 400) throw new Error(`Docker answered ${status} to an inspect`);
    let id: string | undefined;
    let managed: boolean;
    if (whole) {
      const info = JSON.parse(text) as { Id?: string; Config?: { Labels?: Record<string, string> | null } };
      id = info.Id;
      managed = info.Config?.Labels?.["dockify.managed"] === "true";
    } else {
      // An image's labels can make an inspect too large to read, and the container must still be
      // removable. Docker writes the id it resolved first, and the label is then asked of that id.
      id = /^\{\s*"Id"\s*:\s*"([a-f0-9]{64})"/.exec(text)?.[1];
      if (!id) throw new Error("an inspect answer was too large");
      managed = await listedAsManaged(id);
    }
    if (id && FULL_ID.test(id)) managedById.set(id, { managed, at: now() });
    if (managedById.size > 4096) managedById.clear();
    return managed;
  };

  const answer = (res: ServerResponse, status: number, message: string): void => {
    if (res.headersSent) return void res.destroy();
    const text = JSON.stringify({ message });
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), Connection: "close" });
    res.end(text);
  };

  /** Everything the socket proxy hears about a request, written here. Nothing of the caller's framing goes on. */
  const headersFor = (req: IncomingMessage, rule: Rule, body: Buffer | null): OutgoingHttpHeaders => {
    const out: OutgoingHttpHeaders = {};
    const auth = req.headers["x-registry-auth"];
    if (rule.registryAuth && auth !== undefined) out["x-registry-auth"] = auth;
    if (body) {
      out["content-type"] = "application/json";
      out["content-length"] = body.length;
    }
    return out;
  };

  const readBody = async (req: IncomingMessage): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const c of req) {
        const n = (c as Buffer).length;
        if (size + n > MAX_BODY) refuse("that body is too large");
        if (buffered + n > maxBuffered) refuse("too many bodies are being read at once");
        size += n;
        buffered += n;
        chunks.push(c as Buffer);
      }
      return Buffer.concat(chunks);
    } finally {
      buffered -= size;
    }
  };

  /** A refusal answers at once. An error reaching Docker reads as a server error, never as a refusal. */
  const gate = async (req: IncomingMessage): Promise<{ rule: Rule; body: Buffer | null; notFound: boolean }> => {
    const { rule, match } = ruleFor(req.method ?? "", req.url ?? "", req.headers);
    const body = rule.body ? canonicalBody(await readBody(req), rule.body) : null;
    if (rule.managed) {
      const managed = await isManaged(decoded(match[1]!));
      if (managed === null) return { rule, body, notFound: true };
      if (!managed) refuse("that container is not a tenant's");
    }
    return { rule, body, notFound: false };
  };

  const relay = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { rule, body, notFound } = await gate(req);
    if (notFound) return answer(res, 404, "No such container");
    await new Promise<void>((resolve, reject) => {
      const up = request({ ...upstream, agent: false, method: req.method ?? "GET", path: req.url ?? "/", headers: headersFor(req, rule, body) }, (upRes) => {
        if (rule.stripEnv && (upRes.statusCode ?? 500) < 400) {
          void stripped(upRes, res).then(resolve, reject);
          return;
        }
        res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage ?? "", upRes.headers);
        upRes.pipe(res);
        upRes.on("end", resolve);
        upRes.on("error", reject);
      });
      up.on("error", reject);
      // A caller that goes away takes the call with it: a logs follow ends here.
      res.on("close", () => {
        up.destroy();
        resolve();
      });
      if (body) up.end(body);
      else up.end();
    });
  };

  /** Another container's env, a tunnel token above all, never leaves this server. */
  const stripped = async (upRes: IncomingMessage, res: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of upRes) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) throw new Error("an inspect answer was too large");
      chunks.push(c as Buffer);
    }
    const info = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ExecIDs?: unknown; Config?: { Env?: unknown; Labels?: Record<string, string> | null } };
    if (info.Config?.Labels?.["dockify.managed"] !== "true") {
      if (info.Config) delete info.Config.Env;
      // Running execs of a control container: an updater's dump or an admin's rescue.
      delete info.ExecIDs;
    }
    const text = JSON.stringify(info);
    res.writeHead(upRes.statusCode ?? 200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), Connection: "close" });
    res.end(text);
  };

  const server: Server = createServer((req, res) => {
    relay(req, res).catch((e: unknown) => {
      if (e instanceof GateRefusal) answer(res, 400, `refused by this server's agent: ${e.message}`);
      else answer(res, 502, `the agent could not reach Docker: ${e instanceof Error ? e.message : String(e)}`);
    });
  });
  server.keepAliveTimeout = 0;
  server.requestTimeout = 0;
  server.headersTimeout = 0;

  /** exec and attach: the same checks, then a raw tunnel, because after 101 the bytes are not HTTP. */
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const refuseUpgrade = (status: number, message: string): void => {
      const text = JSON.stringify({ message });
      socket.end(`HTTP/1.1 ${status} ${status === 404 ? "Not Found" : status === 400 ? "Bad Request" : "Bad Gateway"}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
    };
    void (async () => {
      const { rule, match } = ruleFor(req.method ?? "", req.url ?? "", req.headers);
      if (!rule.upgrade || !rule.body) return refuse("that call does not upgrade");
      if (req.headers["transfer-encoding"] !== undefined) refuse("that call needs a Content-Length");
      // The body is what follows the headers, and it is exactly Content-Length bytes. What comes after it
      // waits here, because it may only ever reach Docker once the connection has stopped being HTTP.
      const want = Number(req.headers["content-length"] ?? 0);
      if (!Number.isInteger(want) || want < 0 || want > MAX_BODY) refuse("that body is too large");
      if (buffered + want > maxBuffered) refuse("too many bodies are being read at once");
      let got = head;
      buffered += want;
      try {
        if (got.length < want) {
          got = await new Promise<Buffer>((resolve, reject) => {
            let buf = head;
            const onData = (c: Buffer): void => {
              buf = Buffer.concat([buf, c]);
              if (buf.length < want) return;
              socket.off("data", onData);
              socket.pause();
              resolve(buf);
            };
            socket.on("data", onData);
            socket.once("error", reject);
            socket.once("close", () => reject(new Error("the caller went away")));
          });
        }
      } finally {
        buffered -= want;
      }
      const early = got.subarray(want);
      const body = canonicalBody(got.subarray(0, want), rule.body);
      if (rule.managed) {
        const managed = await isManaged(decoded(match[1]!));
        if (managed === null) return refuseUpgrade(404, "No such container");
        if (!managed) refuse("that container is not a tenant's");
      }
      socket.pause();
      const up = netConnect(upstream);
      const lines = [`${req.method} ${req.url} HTTP/1.1`, "Host: docker", "Connection: Upgrade", "Upgrade: tcp"];
      if (body) lines.push("Content-Type: application/json");
      lines.push(`Content-Length: ${body?.length ?? 0}`);
      up.write(Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`), body ?? Buffer.alloc(0)]));
      up.on("error", () => socket.destroy());
      socket.on("error", () => up.destroy());
      socket.on("close", () => up.destroy());
      // Only a 101 ends HTTP. Anything else leaves the connection a keep-alive one in the socket proxy's
      // hands, where the caller's next bytes would be a second request no body check ever saw.
      let answer: Buffer = Buffer.alloc(0);
      const onAnswer = (c: Buffer): void => {
        answer = Buffer.concat([answer, c]);
        const end = answer.indexOf("\r\n\r\n");
        if (end === -1) {
          if (answer.length > MAX_ANSWER_HEAD) up.destroy();
          return;
        }
        up.off("data", onAnswer);
        up.pause();
        socket.write(answer);
        const upgraded = /^HTTP\/1\.1 101 /.test(answer.toString("latin1", 0, 16));
        endWhenDone(up, socket);
        up.pipe(socket, { end: false });
        if (!upgraded) return;
        if (early.length) up.write(early);
        socket.pipe(up);
        socket.resume();
      };
      up.on("data", onAnswer);
    })().catch((e: unknown) => {
      if (e instanceof GateRefusal) refuseUpgrade(400, `refused by this server's agent: ${e.message}`);
      else refuseUpgrade(502, `the agent could not reach Docker: ${e instanceof Error ? e.message : String(e)}`);
    });
  });

  return {
    handle(stream) {
      stream.on("error", () => {});
      server.emit("connection", stream);
    },
    close() {
      server.close();
    },
  };
}
