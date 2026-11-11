/**
 * Checks every route file before it reaches the folder Traefik watches: a backend must be a tenant's reserved
 * name or, on the dashboard's server, a fixed control plane address. What lands on disk is this module's own
 * rendering with no template action in it, because Traefik runs each file through Go's text/template first.
 */
import { isIP } from "node:net";
import { foldedKeyProblem, isObject, isStrings } from "./strict-json.ts";

export class RouteRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteRefusal";
  }
}
const refuse = (message: string): never => {
  throw new RouteRefusal(message);
};

const keysIn = (o: Record<string, unknown>, allowed: readonly string[], what: string): void => {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) refuse(`${what} may not set ${k.slice(0, 80)}`);
};

const TENANT_BACKEND = /^http:\/\/(dk-[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?)\.:\d{1,5}$/;
/** The proxy's own name: a route to it would publish its metrics and dashboard ports on a tenant's host. */
const RESERVED_BACKENDS = new Set(["dk-proxy"]);
const LEGACY_BACKEND = /^http:\/\/([0-9.]+):\d{1,5}$/;
const ENTRY_POINTS = ["web", "websecure"];
const RESOLVERS = ["le", "ledns"];
const KEY = /^[A-Za-z0-9_.-]{1,256}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,128}$/;
const MAX_PRIORITY = 1_000_000;
/** The one middleware in another file a router may name: edge/routes.ts keeps it in __edge.yml. */
const SHARED_MIDDLEWARES = ["dockify-client-ip@file"];
/** Only the matchers edge/routes.ts writes, joined by what it joins them with. */
const RULE = /^(?:[()\s]|&&|\|\||(?:Host|Path|PathPrefix)\(`[^`\\{}]{1,1024}`\))+$/;
const TLS_DOMAIN = /^(?:\*\.)?[a-z0-9.-]{1,253}$/;

/** The worker's own files, whose routers answer for the dashboard and the ownership probe. */
const SYSTEM_FILES = ["__dashboard.yml", "__edge.yml", "__dashboard-next.yml", "__dashboard-old.yml"];
/** Names only those files use. A tenant's are its app's id, and a name in two files keeps only the first. */
const SYSTEM_KEY = /^(?:dashboard|dockify-)/;

/**
 * The address a swap pins while it replaces a container made before route aliases existed: only one a tenant
 * container holds right now. Docker's pools overlap the host's LAN, so no private range can stand for it.
 */
function allowedAddress(host: string, held: ReadonlySet<string> | undefined): boolean {
  if (isIP(host) !== 4) return false;
  const [a = 0, b = 0, , d = 0] = host.split(".").map(Number);
  // Dockify's control networks, loopback, link-local and metadata, and a gateway, which is the host itself.
  if ((a === 172 && b === 30) || a === 127 || (a === 169 && b === 254) || a === 0 || d === 1) return false;
  return held?.has(host) ?? false;
}

export interface RouteRules {
  upstreams: readonly string[];
  /** The addresses tenant containers hold now (tenantAddresses). Without it no address passes. */
  heldAddresses?: ReadonlySet<string>;
}

function checkBackend(url: unknown, rules: RouteRules, system: boolean): void {
  if (typeof url !== "string") return refuse("a backend must be a URL");
  if (rules.upstreams.includes(url)) return;
  // A system file answers for the dashboard and the probe, and only ever asks the control plane.
  if (system) return refuse(`a system file's backend ${url.slice(0, 120)} is not the control plane's`);
  const name = TENANT_BACKEND.exec(url)?.[1];
  if (name && !RESERVED_BACKENDS.has(name)) return;
  const legacy = LEGACY_BACKEND.exec(url);
  if (legacy && allowedAddress(legacy[1]!, rules.heldAddresses)) return;
  refuse(`backend ${url.slice(0, 120)} is not a tenant's`);
}

function checkHeaderMap(map: unknown): void {
  if (!isObject(map)) return refuse("headers must be a map");
  for (const [k, value] of Object.entries(map)) {
    if (!HEADER_NAME.test(k)) refuse("that header name is not allowed");
    if (typeof value !== "string") refuse("a header value must be text");
  }
}

function checkMiddleware(name: string, m: unknown, rules: RouteRules): void {
  if (!isObject(m)) return refuse(`middleware ${name} must be an object`);
  const kinds = Object.keys(m);
  if (kinds.length !== 1) return refuse(`middleware ${name} must do one thing`);
  const kind = kinds[0]!;
  const v = m[kind];
  if (!isObject(v)) return refuse(`middleware ${name} must be an object`);
  switch (kind) {
    case "redirectScheme":
      keysIn(v, ["scheme", "permanent"], kind);
      if (v.scheme !== "https") refuse("a scheme redirect goes to https");
      if (typeof v.permanent !== "boolean") refuse("permanent must be true or false");
      return;
    case "redirectRegex":
      keysIn(v, ["regex", "replacement", "permanent"], kind);
      if (typeof v.regex !== "string" || typeof v.replacement !== "string") refuse("a regex redirect needs a regex and a replacement");
      if (typeof v.permanent !== "boolean") refuse("permanent must be true or false");
      return;
    case "replacePath":
      keysIn(v, ["path"], kind);
      if (typeof v.path !== "string" || !v.path.startsWith("/")) refuse("replacePath needs a path");
      return;
    case "headers": {
      keysIn(v, ["customRequestHeaders", "customResponseHeaders"], kind);
      for (const map of Object.values(v)) checkHeaderMap(map);
      return;
    }
    case "forwardAuth": {
      keysIn(v, ["address", "trustForwardHeader", "authResponseHeaders"], kind);
      if (v.trustForwardHeader !== false) refuse("forwardAuth must not trust forwarded headers");
      if (!isStrings(v.authResponseHeaders) || v.authResponseHeaders.some((h) => !HEADER_NAME.test(h))) refuse("forwardAuth must name its headers");
      const address = typeof v.address === "string" ? v.address : "";
      // Only a preview's gate, on the control plane's own address, with nothing but a path added.
      if (!rules.upstreams.some((u) => address.startsWith(`${u}/`)) || address.includes("..")) refuse("forwardAuth may only ask the control plane");
      return;
    }
    default:
      return refuse(`middleware kind ${kind.slice(0, 80)} is not allowed`);
  }
}

function checkRouter(name: string, r: unknown, file: Record<string, unknown>): void {
  if (!isObject(r)) return refuse(`router ${name} must be an object`);
  keysIn(r, ["rule", "entryPoints", "service", "priority", "tls", "middlewares"], "a router");
  if (typeof r.rule !== "string" || !r.rule || r.rule.length > 64 * 1024 || !RULE.test(r.rule)) refuse(`router ${name} has a rule this server does not take`);
  if (!isStrings(r.entryPoints) || r.entryPoints.some((e) => !ENTRY_POINTS.includes(e))) refuse(`router ${name} names an unknown entry point`);
  const services = (file.services ?? {}) as Record<string, unknown>;
  if (typeof r.service !== "string" || !Object.hasOwn(services, r.service)) refuse(`router ${name} names a service this file does not have`);
  if (r.priority !== undefined && (typeof r.priority !== "number" || !Number.isSafeInteger(r.priority) || r.priority < 0 || r.priority > MAX_PRIORITY)) refuse(`router ${name} has a bad priority`);
  if (r.tls !== undefined) {
    if (!isObject(r.tls)) return refuse(`router ${name} has bad tls`);
    keysIn(r.tls, ["certResolver", "domains"], "tls");
    if (typeof r.tls.certResolver !== "string" || !RESOLVERS.includes(r.tls.certResolver)) refuse(`router ${name} names an unknown certificate resolver`);
    if (r.tls.domains !== undefined) {
      if (!Array.isArray(r.tls.domains)) return refuse("tls domains must be a list");
      for (const d of r.tls.domains as unknown[]) {
        if (!isObject(d)) return refuse("a tls domain must be an object");
        keysIn(d, ["main"], "a tls domain");
        if (typeof d.main !== "string" || !TLS_DOMAIN.test(d.main)) refuse("a tls domain must be a host name");
      }
    }
  }
  if (r.middlewares !== undefined) {
    if (!isStrings(r.middlewares)) return refuse(`router ${name} must list its middlewares`);
    const local = (file.middlewares ?? {}) as Record<string, unknown>;
    for (const m of r.middlewares) {
      if (!Object.hasOwn(local, m) && !SHARED_MIDDLEWARES.includes(m)) refuse(`router ${name} names a middleware this file does not have`);
    }
  }
}

/** Traefik refuses a whole file for an empty map, an empty list or a null, and every route with it. */
function checkNothingEmpty(v: unknown): void {
  if (v === null) return refuse("a route file may hold no null");
  if (Array.isArray(v)) {
    if (!v.length) return refuse("a route file may hold no empty list");
    v.forEach(checkNothingEmpty);
  } else if (typeof v === "object") {
    const values = Object.values(v as object);
    if (!values.length) return refuse("a route file may hold no empty map");
    values.forEach(checkNothingEmpty);
  }
}

/** Reads byte for byte as edge/routes.ts rendered it, which that module relies on: an unchanged file is never rewritten. */
export function validateRouteFile(text: string, rules: RouteRules, fileName = "route.yml"): string {
  const system = fileName.startsWith("__");
  if (system && !SYSTEM_FILES.includes(fileName)) refuse(`${fileName.slice(0, 80)} is not one of the system files`);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return refuse("a route file must be JSON");
  }
  const problem = foldedKeyProblem(doc);
  if (problem) refuse(`a route file is not allowed: ${problem}`);
  if (!isObject(doc)) return refuse("a route file must be an object");
  keysIn(doc, ["http"], "a route file");
  const http = doc.http;
  if (!isObject(http)) return refuse("a route file must have http");
  keysIn(http, ["routers", "services", "middlewares"], "http");
  checkNothingEmpty(doc);
  for (const key of Object.keys(http)) {
    const section = http[key];
    if (!isObject(section)) return refuse(`http.${key} must not be empty`);
    for (const name of Object.keys(section)) {
      if (!KEY.test(name)) refuse(`${name.slice(0, 80)} is not a key this file may use`);
      if (!system && SYSTEM_KEY.test(name)) refuse(`${name} is a name only a system file may use`);
    }
  }
  for (const [name, s] of Object.entries((http.services ?? {}) as Record<string, unknown>)) {
    if (!isObject(s)) return refuse(`service ${name} must be an object`);
    keysIn(s, ["loadBalancer"], "a service");
    const lb = s.loadBalancer;
    if (!isObject(lb)) return refuse(`service ${name} needs a loadBalancer`);
    keysIn(lb, ["servers", "passHostHeader"], "a loadBalancer");
    if (lb.passHostHeader !== undefined && typeof lb.passHostHeader !== "boolean") refuse(`service ${name} has a bad passHostHeader`);
    if (!Array.isArray(lb.servers) || !lb.servers.length) return refuse(`service ${name} needs a server`);
    for (const srv of lb.servers) {
      if (!isObject(srv)) return refuse("a server must be an object");
      keysIn(srv, ["url"], "a server");
      checkBackend(srv.url, rules, system);
    }
  }
  for (const [name, m] of Object.entries((http.middlewares ?? {}) as Record<string, unknown>)) checkMiddleware(name, m, rules);
  for (const [name, r] of Object.entries((http.routers ?? {}) as Record<string, unknown>)) checkRouter(name, r, http);
  const out = `${JSON.stringify(doc, null, 2)}\n`;
  // On what is written, not what was sent: an escaped { would come out of JSON.stringify as a brace.
  if (out.includes("{{")) refuse("a route file may hold no template");
  return out;
}

const namesIn = (text: string): Array<[string, string]> => {
  try {
    const http = (JSON.parse(text) as { http?: Record<string, unknown> }).http ?? {};
    return ["routers", "services", "middlewares"].flatMap((section) => Object.keys((http[section] ?? {}) as object).map((n): [string, string] => [section, n.toLowerCase()]));
  } catch {
    return [];
  }
};

/**
 * Traefik keeps only the first of two routers of one name in a folder, so a name in two files takes one of
 * them off the air, the dashboard's as readily as anyone's.
 */
export function refuseCollidingNames(existing: Record<string, string>, writes: Record<string, string>, removes: readonly string[]): void {
  const owner = new Map<string, string>();
  const after = { ...existing, ...writes };
  for (const gone of removes) if (!Object.hasOwn(writes, gone)) delete after[gone];
  // The files being written last, so a refusal names the one that caused it.
  const names = [...Object.keys(after).filter((n) => !Object.hasOwn(writes, n)), ...Object.keys(writes)];
  for (const file of names) {
    for (const [section, name] of namesIn(after[file]!)) {
      const key = `${section} ${name}`;
      const other = owner.get(key);
      if (other && other !== file) refuse(`${section} ${name.slice(0, 80)} in ${file.slice(0, 80)} is already in ${other.slice(0, 80)}`);
      owner.set(key, file);
    }
  }
}

export function tenantAddresses(containers: ReadonlyArray<{ NetworkSettings?: { Networks?: Record<string, unknown> | null } | null }>): Set<string> {
  const out = new Set<string>();
  for (const c of containers) {
    for (const [network, v] of Object.entries(c.NetworkSettings?.Networks ?? {})) {
      const ip = (v as { IPAddress?: unknown } | null)?.IPAddress;
      if (/^dockify-(?:env-|pv-|helpers$)/.test(network) && typeof ip === "string" && ip) out.add(ip);
    }
  }
  return out;
}
