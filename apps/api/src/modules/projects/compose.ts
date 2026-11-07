/**
 * Docker Compose as an import only (PRODUCT-STRATEGY cut 4): each service becomes one Dockify app
 * spec, and anything Compose can express that Dockify never runs is a refusal, not a silent drop.
 * The import is all or nothing: one refusal and no app is created.
 *
 * Refused: privileged, cap_add, security_opt, devices, network_mode, pid, ipc, uts, userns_mode,
 * cgroup and cgroup_parent, sysctls, extra_hosts, dns, host-path or socket mounts, tmpfs, build
 * (the git source replaces it), env_file (the file is not here), and an unpinned postgres or redis
 * version. Ignored with a warning: host ports (Dockify never publishes one; use a domain),
 * container_name, restart, depends_on, networks, labels, healthcheck, resource limits.
 */
import { parse as parseYaml } from "yaml";
import { projects as P, unreservedServiceName } from "@dockify/contracts";
import { checkSpec, SERVICE_IMAGES, STORAGE_UNAVAILABLE, type AppSpec, type Refusal } from "./app-source.ts";

export interface ComposeResult {
  specs: AppSpec[];
  refusals: Refusal[];
  warnings: string[];
}

const REFUSED_KEYS: Record<string, string> = {
  privileged: "privileged containers are never run",
  cap_add: "capabilities are set from the app's advanced settings, under step-up",
  security_opt: "security options are fixed by Dockify",
  devices: "host devices are never mapped",
  device_cgroup_rules: "host devices are never mapped",
  network_mode: "every app joins its own Dockify network",
  pid: "host namespaces are never shared",
  ipc: "host namespaces are never shared",
  uts: "host namespaces are never shared",
  userns_mode: "host namespaces are never shared",
  cgroup: "host namespaces are never shared",
  cgroup_parent: "cgroups are fixed by Dockify",
  sysctls: "sysctls are set from the app's advanced settings, under step-up",
  extra_hosts: "host entries are not supported",
  dns: "DNS is fixed by Dockify",
  tmpfs: "tmpfs mounts are not supported",
  build: "build from a git source instead; Compose build contexts are not imported",
  env_file: "env files are not uploaded; paste the variables instead",
  volumes_from: "volumes cannot be shared between apps",
  links: "use the app name on the Dockify network instead",
  external_links: "use the app name on the Dockify network instead",
  init: "the init process is fixed by Dockify",
  user: "the container user comes from the image",
};
/** Dropped with a warning. Limits are set on the app after import. */
const IGNORED_KEYS = new Set([
  "container_name", "restart", "depends_on", "networks", "labels", "healthcheck", "expose", "stop_grace_period", "logging",
  "mem_limit", "cpus", "deploy", "working_dir",
]);
const KNOWN_KEYS = new Set(["image", "command", "environment", "ports", "volumes", "entrypoint", ...IGNORED_KEYS, ...Object.keys(REFUSED_KEYS)]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** postgres:16-alpine and friends map to the managed service of that version. */
function serviceOf(image: string): { service: keyof typeof SERVICE_IMAGES; version: string | null } | null {
  const m = /^(?:docker\.io\/)?(?:library\/)?(postgres|redis|minio\/minio)(?::([\w.-]+))?$/.exec(image);
  if (!m) return null;
  const service = m[1] === "minio/minio" ? "minio" : (m[1] as "postgres" | "redis");
  const tag = m[2] ?? null;
  if (service === "minio") return { service, version: "latest" };
  const version = tag ? (/^(\d+(?:\.\d+)?)/.exec(tag)?.[1] ?? null) : null;
  return { service, version };
}

function envOf(raw: unknown, field: string, refusals: Refusal[]): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  if (raw === undefined) return out;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "string") {
        refusals.push({ field, reason: "Each environment entry is KEY=value" });
        continue;
      }
      const eq = item.indexOf("=");
      if (eq <= 0) {
        refusals.push({ field, reason: `${item} has no value; Compose would read it from the host` });
        continue;
      }
      out.push({ key: item.slice(0, eq), value: item.slice(eq + 1) });
    }
  } else if (isObj(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (value === null || value === undefined) {
        refusals.push({ field, reason: `${key} has no value; Compose would read it from the host` });
        continue;
      }
      out.push({ key, value: String(value) });
    }
  } else {
    refusals.push({ field, reason: "environment must be a list or a map" });
  }
  for (const e of out) {
    if (/\$\{?[A-Za-z_]/.test(e.value)) refusals.push({ field, reason: `${e.key} interpolates a host variable; set the value itself` });
  }
  return out;
}

function commandOf(raw: unknown, field: string, refusals: Refusal[]): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && raw.every((p) => typeof p === "string")) {
    return raw.map((p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`)).join(" ");
  }
  refusals.push({ field, reason: "command must be a string or a list of strings" });
  return null;
}

/** The container port of the first published port, and a warning when a host port was asked for. */
function portOf(raw: unknown, field: string, refusals: Refusal[], warnings: string[], name: string): number | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) {
    refusals.push({ field, reason: "ports must be a list" });
    return null;
  }
  let port: number | null = null;
  for (const p of raw) {
    let container: number | null = null;
    let host = false;
    if (typeof p === "number") container = p;
    else if (typeof p === "string") {
      const m = /^(?:(?:[\d.]+|\[[\da-f:]+\]):)?(?:(\d{1,5}):)?(\d{1,5})(?:\/(tcp|udp))?$/i.exec(p);
      if (!m) {
        refusals.push({ field, reason: `${p} is not a port Dockify understands` });
        continue;
      }
      host = m[1] !== undefined || p.split(":").length > 1;
      container = Number(m[2]);
      if (m[3]?.toLowerCase() === "udp") refusals.push({ field, reason: "UDP ports are not supported" });
    } else if (isObj(p) && typeof p.target === "number") {
      container = p.target;
      host = p.published !== undefined;
      if (p.protocol === "udp") refusals.push({ field, reason: "UDP ports are not supported" });
    } else {
      refusals.push({ field, reason: "Unreadable port entry" });
      continue;
    }
    if (host) warnings.push(`${name}: the host port is not published; reach it through a domain`);
    if (container === null || container < 1 || container > 65535) refusals.push({ field, reason: "Port out of range" });
    else if (port === null) port = container;
    else if (port !== container) warnings.push(`${name}: only port ${port} is routed; ${container} stays internal`);
  }
  return port;
}

function volumesOf(raw: unknown, field: string, refusals: Refusal[], named: Set<string>): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  if (raw === undefined) return out;
  if (!Array.isArray(raw)) {
    refusals.push({ field, reason: "volumes must be a list" });
    return out;
  }
  for (const v of raw) {
    let source: string | undefined;
    let target: string | undefined;
    let type = "volume";
    if (typeof v === "string") {
      const parts = v.split(":");
      if (parts.length === 1) {
        refusals.push({ field, reason: `${v} is an anonymous volume; give it a name` });
        continue;
      }
      [source, target] = parts;
      if (source?.startsWith(".") || source?.startsWith("/") || source?.startsWith("~")) type = "bind";
    } else if (isObj(v)) {
      type = typeof v.type === "string" ? v.type : "volume";
      source = typeof v.source === "string" ? v.source : undefined;
      target = typeof v.target === "string" ? v.target : undefined;
    }
    if (type !== "volume") {
      refusals.push({ field, reason: `${source ?? "that mount"} is a host path; only named volumes are imported` });
      continue;
    }
    if (!source || !target) {
      refusals.push({ field, reason: "Each volume needs a name and a path" });
      continue;
    }
    if (!named.has(source)) refusals.push({ field, reason: `${source} is not declared under the top-level volumes` });
    out.push({ name: source.toLowerCase(), path: target });
  }
  return out;
}

const appNameOf = (s: string): string => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");

/** Maps a parsed Compose document to app specs. Pass the result of a YAML or JSON parse. */
export function composeToSpecs(doc: unknown): ComposeResult {
  const refusals: Refusal[] = [];
  const warnings: string[] = [];
  const specs: AppSpec[] = [];
  if (!isObj(doc) || !isObj(doc.services)) return { specs, refusals: [{ field: "services", reason: "No services found" }], warnings };

  const named = new Set<string>();
  if (isObj(doc.volumes)) {
    for (const [name, def] of Object.entries(doc.volumes)) {
      if (isObj(def) && (def.driver !== undefined || def.driver_opts !== undefined || def.external === true)) {
        refusals.push({ field: `volumes.${name}`, reason: "Volume drivers, driver options and external volumes are not supported" });
      }
      named.add(name);
    }
  }
  for (const key of ["configs", "secrets"]) {
    if (doc[key] !== undefined) refusals.push({ field: key, reason: `Top-level ${key} are not supported` });
  }

  const entries = Object.entries(doc.services);
  if (entries.length > 20) refusals.push({ field: "services", reason: "Import at most 20 services at once" });

  for (const [rawName, svc] of entries) {
    const at = `services.${rawName}`;
    if (!isObj(svc)) {
      refusals.push({ field: at, reason: "Not a service definition" });
      continue;
    }
    for (const key of Object.keys(svc)) {
      const why = REFUSED_KEYS[key];
      if (why) refusals.push({ field: `${at}.${key}`, reason: why });
      else if (IGNORED_KEYS.has(key)) warnings.push(`${rawName}: ${key} is ignored`);
      else if (!KNOWN_KEYS.has(key)) refusals.push({ field: `${at}.${key}`, reason: `${key} is not supported` });
    }
    if (svc.entrypoint !== undefined) refusals.push({ field: `${at}.entrypoint`, reason: "Overriding the entrypoint is not supported; use command" });

    const name = appNameOf(rawName);
    if (!name) {
      refusals.push({ field: at, reason: "The service name has no usable letters or digits" });
      continue;
    }
    if (typeof svc.image !== "string") {
      refusals.push({ field: `${at}.image`, reason: "Each service needs an image; build from git instead" });
      continue;
    }
    const env = envOf(svc.environment, `${at}.environment`, refusals);
    const port = portOf(svc.ports, `${at}.ports`, refusals, warnings, rawName);
    const volumes = volumesOf(svc.volumes, `${at}.volumes`, refusals, named);
    const command = commandOf(svc.command, `${at}.command`, refusals);

    const service = serviceOf(svc.image);
    let spec: unknown;
    if (service?.service === "minio") {
      refusals.push({ field: `${at}.image`, reason: STORAGE_UNAVAILABLE });
      continue;
    }
    if (service) {
      if (!service.version) {
        refusals.push({ field: `${at}.image`, reason: `Pin a ${service.service} version, for example ${Object.keys(SERVICE_IMAGES[service.service]).at(-1)}` });
        continue;
      }
      if (command) refusals.push({ field: `${at}.command`, reason: "A managed service runs its own command" });
      // A managed service runs with what Dockify gives it; the file's values would never reach it.
      if (env.length) warnings.push(`${rawName}: Dockify generates its credentials and sets its configuration; its environment values are not imported`);
      if (volumes.length) warnings.push(`${rawName}: Dockify keeps its data on its own volume and backs it up; its volumes are not imported`);
      const serviceName = unreservedServiceName(name);
      if (serviceName !== name) warnings.push(`${rawName}: Dockify's own services use the name ${name}, so this one is called ${serviceName}. Connect to it by that name.`);
      spec = {
        name: serviceName,
        kind: service.service,
        source: { type: "service", service: service.service, version: service.version },
        target: "server",
      };
    } else {
      spec = {
        name,
        kind: port === null ? "bot" : "backend",
        source: { type: "image", image: svc.image, registryId: null },
        run: { startCommand: command ?? "", port },
        ...(env.length ? { env } : {}),
        ...(volumes.length ? { volumes } : {}),
        target: "server",
      };
    }
    const parsed = P.AppSpec.safeParse(spec);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) refusals.push({ field: `${at}.${issue.path.join(".")}`, reason: issue.message });
      continue;
    }
    refusals.push(...checkSpec(parsed.data, at));
    specs.push(parsed.data);
  }

  const names = new Set<string>();
  for (const s of specs) {
    if (names.has(s.name)) refusals.push({ field: "services", reason: `Two services map to the app name ${s.name}` });
    names.add(s.name);
  }
  return refusals.length ? { specs: [], refusals, warnings } : { specs, refusals, warnings };
}

const MAX_FLOW_DEPTH = 64;

/** The deepest run of open `[` and `{` in the text. */
function flowDepth(text: string): number {
  let depth = 0;
  let max = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 91 || c === 123) max = Math.max(max, ++depth);
    else if ((c === 93 || c === 125) && depth > 0) depth--;
  }
  return max;
}

/**
 * Parses Compose text, YAML or JSON (JSON is YAML). Anchors are capped so an alias bomb cannot
 * expand, duplicate keys are refused, and only the core schema is used (no custom tags).
 */
export function parseComposeText(text: string): ComposeResult {
  if (text.length > 256 * 1024) return { specs: [], refusals: [{ field: "compose", reason: "The file is larger than 256 KB" }], warnings: [] };
  // Deep flow nesting overflows the parser's stack on Linux and kills the process, so it is
  // refused before parsing. Brackets inside quotes count too: no real Compose file nests this deep.
  if (flowDepth(text) > MAX_FLOW_DEPTH) return { specs: [], refusals: [{ field: "compose", reason: `Not a valid Compose file: nested more than ${MAX_FLOW_DEPTH} levels` }], warnings: [] };
  let doc: unknown;
  try {
    doc = parseYaml(text, { schema: "core", uniqueKeys: true, maxAliasCount: 100, prettyErrors: false });
  } catch (e) {
    const reason = e instanceof Error ? (e.message.split("\n")[0] ?? "").slice(0, 200) : "Not valid YAML";
    return { specs: [], refusals: [{ field: "compose", reason: `Not a valid Compose file: ${reason}` }], warnings: [] };
  }
  return composeToSpecs(doc);
}
