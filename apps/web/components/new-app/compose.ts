import { plural } from "@/lib/format";
import { unreservedServiceName } from "@/lib/validation";
import { appSlug, ENV_KEY, imageName, IMAGE_REF, MAX_APPS, SERVICE_KIND, SERVICE_LABEL, SERVICE_VERSIONS, VOLUME_NAME, type AppSpec, type EnvPair, type ServiceKind, type VolumeMount } from "./spec";
import { parseYaml, YamlError, type Yaml } from "./yaml";

/*
 * Compose import: maps each service of a docker-compose.yml onto a proposed Dockify app. Dockify
 * never runs raw Compose, so anything that reaches past the container (host ports, privileged
 * mode, added capabilities, the host network, bind mounts, devices) is listed as a warning and
 * left out. A service that builds from source is skipped: it needs a repository app instead.
 */

export interface ProposedApp {
  /** The service's key in the file. */
  service: string;
  spec: AppSpec;
  /** One muted line: what it runs and what it keeps. */
  summary: string;
}

export interface ComposeWarning {
  service: string | null;
  text: string;
  /** Refused for safety, as opposed to simply not carried over. */
  refused: boolean;
}

export interface ComposePlan {
  apps: ProposedApp[];
  skipped: Array<{ service: string; reason: string }>;
  warnings: ComposeWarning[];
}

export type ComposeResult = { ok: true; plan: ComposePlan } | { ok: false; error: string };

type Obj = { [key: string]: Yaml };
const isObj = (v: Yaml | undefined): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: Yaml | undefined) => (v === null || v === undefined ? "" : typeof v === "object" ? "" : String(v));

/* Keys that would reach the host. Each one is refused with its reason. */
const REFUSED: Record<string, string> = {
  privileged: "Privileged mode is never allowed",
  cap_add: "Added capabilities are never allowed",
  devices: "Host devices are never mounted",
  security_opt: "Security options are not imported",
  pid: "A shared host PID namespace is never allowed",
  ipc: "A shared host IPC namespace is never allowed",
  userns_mode: "A host user namespace is never allowed",
  sysctls: "Kernel parameters are not imported",
  extra_hosts: "Extra host entries are not imported",
};

/* Keys Dockify sets itself or takes from app settings; each gets one quiet note. */
const NOT_CARRIED: Record<string, string> = {
  container_name: "container_name is ignored, Dockify names the container",
  networks: "networks are ignored, every app joins the project network",
  labels: "labels are not imported",
  healthcheck: "The health check is not imported, set it in the app’s settings",
  env_file: "env_file is not read, add those variables on the Variables tab",
  entrypoint: "entrypoint is not imported, only command is",
  deploy: "deploy settings are not imported, set limits in the app’s settings",
  tmpfs: "tmpfs mounts are not imported",
};

/* Keys that carry over as they are, or matter only inside Compose. */
const QUIET = new Set(["image", "build", "command", "environment", "ports", "expose", "volumes", "restart", "depends_on", "network_mode", "hostname", "working_dir", "user", "stop_signal", "stop_grace_period", "logging", "init", "platform", "pull_policy"]);

/** The repository an image names, without registry defaults: "docker.io/library/redis:7" is "redis". */
const repoOf = (image: string) => image.split("@")[0]!.split(/:(?=[^/]*$)/)[0]!.replace(/^docker\.io\//, "").replace(/^library\//, "");

/** Why a MinIO service is left out: Storage is not offered, the image is no longer published. */
const STORAGE_SKIPPED = "MinIO no longer publishes an image Dockify can run, so Storage is not offered. Use S3-compatible storage from your provider.";

/** Which managed service an image is, when it is one Dockify offers at a version it has. */
function managed(image: string): { service: ServiceKind; version: string } | null {
  const tag = image.split("@")[0]!.split(/:(?=[^/]*$)/)[1] ?? "";
  const repo = repoOf(image);
  const service: ServiceKind | null = repo === "postgres" ? "postgres" : repo === "redis" ? "redis" : null;
  if (!service) return null;
  const versions = SERVICE_VERSIONS[service];
  const version = versions.find((v) => tag === v || tag.startsWith(`${v}.`) || tag.startsWith(`${v}-`)) ?? (tag === "" || tag === "latest" || tag === "alpine" ? versions[0]! : null);
  return version ? { service, version } : null;
}

/** The container side of a ports entry: "8080:80", "127.0.0.1:80:80/tcp", "80", or { target }. */
function containerPort(v: Yaml): number | null {
  if (isObj(v)) return typeof v.target === "number" ? v.target : Number(text(v.target)) || null;
  const s = text(v).split("/")[0]!;
  const last = s.split(":").pop() ?? "";
  const n = Number(last.split("-")[0]);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/** "a b" from ["a", "b"], quoting the items that hold spaces. */
function commandOf(v: Yaml | undefined): string {
  if (Array.isArray(v)) return v.map((x) => (/[\s"']/.test(text(x)) ? JSON.stringify(text(x)) : text(x))).join(" ");
  return text(v).replace(/\s*\n\s*/g, " ").trim();
}

function envOf(v: Yaml | undefined, warn: (t: string) => void): EnvPair[] {
  const pairs: EnvPair[] = [];
  const add = (key: string, value: string) => {
    if (!ENV_KEY.test(key)) return warn(`${key || "A variable"} is not a valid variable name and was left out`);
    if (pairs.some((p) => p.key === key)) return;
    pairs.push({ key, value });
  };
  if (Array.isArray(v)) {
    for (const item of v) {
      const s = text(item);
      const at = s.indexOf("=");
      add(at < 0 ? s : s.slice(0, at), at < 0 ? "" : s.slice(at + 1));
    }
  } else if (isObj(v)) {
    for (const [k, val] of Object.entries(v)) add(k, text(val));
  }
  return pairs;
}

function volumesOf(service: string, v: Yaml | undefined, refuse: (t: string) => void): VolumeMount[] {
  const out: VolumeMount[] = [];
  let anonymous = 0;
  if (!Array.isArray(v)) return out;
  for (const item of v) {
    let source = "";
    let target = "";
    let type = "volume";
    if (isObj(item)) {
      type = text(item.type) || "volume";
      source = text(item.source);
      target = text(item.target);
    } else {
      const parts = text(item).split(":");
      [source, target] = parts.length === 1 ? ["", parts[0]!] : [parts[0]!, parts[1] ?? ""];
      if (/^[./~]|^[A-Za-z]:\\|\//.test(source)) type = "bind";
    }
    if (type === "bind") {
      refuse(`Bind mount ${source || "from the host"} to ${target} is never mounted`);
      continue;
    }
    if (type !== "volume" || !/^\/[\w.\-/]*$/.test(target)) {
      refuse(`The ${type} mount at ${target || "an unknown path"} is not imported`);
      continue;
    }
    // An anonymous volume gets a name, so its data survives a redeploy.
    const name = source || `${service}-data${anonymous++ ? `-${anonymous}` : ""}`;
    if (!VOLUME_NAME.test(name)) {
      refuse(`Volume ${name} has a name Dockify cannot use`);
      continue;
    }
    out.push({ name, path: target });
  }
  return out;
}

/** Parses the file and proposes one app per service it can import. */
export function planCompose(src: string): ComposeResult {
  let doc: Yaml;
  try {
    doc = parseYaml(src);
  } catch (e) {
    return { ok: false, error: e instanceof YamlError ? e.message : "The file could not be read" };
  }
  if (!isObj(doc) || !isObj(doc.services)) return { ok: false, error: "There is no services: section" };
  const entries = Object.entries(doc.services);
  if (!entries.length) return { ok: false, error: "The services: section is empty" };
  if (entries.length > MAX_APPS) return { ok: false, error: `At most ${MAX_APPS} services can be imported at once` };

  const plan: ComposePlan = { apps: [], skipped: [], warnings: [] };
  for (const key of ["networks", "configs", "secrets"]) {
    if (doc[key] !== undefined) plan.warnings.push({ service: null, text: `Top-level ${key} are not imported`, refused: false });
  }
  const taken = new Set<string>();

  for (const [service, def] of entries) {
    const warn = (t: string) => plan.warnings.push({ service, text: t, refused: false });
    const refuse = (t: string) => plan.warnings.push({ service, text: t, refused: true });
    if (!isObj(def)) {
      plan.skipped.push({ service, reason: "Not a service definition" });
      continue;
    }
    const image = text(def.image).trim().toLowerCase();
    if (!image) {
      plan.skipped.push({ service, reason: def.build !== undefined ? "Builds from source, add it as a GitHub repository app" : "Has no image" });
      continue;
    }
    if (!IMAGE_REF.test(image)) {
      plan.skipped.push({ service, reason: `${image} is not an image reference Dockify can pull` });
      continue;
    }
    if (repoOf(image) === "minio/minio") {
      plan.skipped.push({ service, reason: STORAGE_SKIPPED });
      continue;
    }
    if (def.build !== undefined) warn(`build is ignored, the app runs ${image}`);

    // The name: the service key made safe, kept unique across the file.
    let name = appSlug(service) || imageName(image) || "app";
    for (let i = 2; taken.has(name); i++) name = `${appSlug(service).slice(0, 29)}-${i}`;
    taken.add(name);

    for (const [k, reason] of Object.entries(REFUSED)) if (def[k] !== undefined && def[k] !== false && !(Array.isArray(def[k]) && !def[k].length)) refuse(reason);
    const net = text(def.network_mode);
    if (net) refuse(net === "host" ? "The host network is never used" : `network_mode ${net} is not imported`);
    if (Array.isArray(def.ports) && def.ports.length) refuse(`Host ports are never published (${def.ports.map(text).filter(Boolean).join(", ") || plural(def.ports.length, "entry", "entries")}), use a domain instead`);
    for (const [k, note] of Object.entries(NOT_CARRIED)) if (def[k] !== undefined) warn(note);
    const unknown = Object.keys(def).filter((k) => !QUIET.has(k) && !(k in REFUSED) && !(k in NOT_CARRIED));
    if (unknown.length) warn(`${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not imported`);

    const svc = managed(image);
    if (svc) {
      const label = SERVICE_LABEL[svc.service];
      if (def.environment !== undefined) warn(`Dockify manages the ${label} credentials, its variables are not imported`);
      if (def.volumes !== undefined) warn("Its data volume is managed by Dockify and backed up with the project");
      const serviceName = unreservedServiceName(name);
      if (serviceName !== name) warn(`Dockify's own services use the name ${name}, so this one is called ${serviceName}. Connect to it by that name.`);
      plan.apps.push({
        service,
        spec: { name: serviceName, kind: SERVICE_KIND[svc.service], source: { type: "service", ...svc }, target: "server" },
        summary: `Managed ${label} ${svc.version}, private to the project`,
      });
      continue;
    }

    const ports = [...(Array.isArray(def.ports) ? def.ports : []), ...(Array.isArray(def.expose) ? def.expose : [])].map(containerPort).filter((p): p is number => p !== null);
    const port = ports[0] ?? null;
    if (new Set(ports).size > 1) warn(`Listens on ${ports.join(", ")}, only ${port} is routed`);
    const env = envOf(def.environment, warn);
    const volumes = volumesOf(name, def.volumes, refuse);
    const startCommand = commandOf(def.command);

    const spec: AppSpec = { name, kind: "backend", source: { type: "image", image, registryId: null }, run: { startCommand, port }, target: "server" };
    if (env.length) spec.env = env;
    if (volumes.length) spec.volumes = volumes;
    const bits = [image, port ? `port ${port}` : null, env.length ? plural(env.length, "variable") : null, volumes.length ? plural(volumes.length, "volume") : null];
    plan.apps.push({ service, spec, summary: bits.filter(Boolean).join(", ") });
  }
  return { ok: true, plan };
}

/** A short example, for the empty editor. */
export const COMPOSE_EXAMPLE = `services:
  web:
    image: ghcr.io/acme/web:1.4
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
  db:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
`;
