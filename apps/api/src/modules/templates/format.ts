// A template is a reviewed file shipped with the release. Its compose text goes through the same parser and refusals as a pasted file, so it has
// no way around a check. Tokens ({{secret.NAME}}, {{input.KEY}}, {{url}}, {{hostname}}, {{host.service}}, {{ref.service.field}}) expand only in
// environment values, never in an image, command or volume, and once, last: a typed value is never read back as a template.
import { randomBytes } from "node:crypto";
import { projects as P, templates as T } from "@dockify/contracts";
import type { z } from "zod";
import { checkSpec, type AppSpec, type Refusal } from "../projects/app-source.ts";
import { parseComposeText } from "../projects/compose.ts";

export type SecretRecipe = "hex16" | "hex32" | "b64url24" | "b64url32" | "b64url48";

export interface TemplateInputDef {
  key: string;
  label: string;
  hint: string;
  type: "email" | "text";
}

export interface Template {
  id: string;
  name: string;
  summary: string;
  category: "Analytics" | "Automation" | "Business" | "Collaboration" | "Content" | "Developer tools" | "Files" | "Monitoring" | "Security" | "Storage";
  /** Web icon slug (components/new-app/template-icons.ts). */
  icon: string;
  /** The app's own license: what the owner agrees to by running it. */
  license: string;
  homepage: string;
  /** The official page these settings were read from, so a reviewer can check them. */
  docs: string;
  firstRun: string;
  /** The service that gets the domain. Must have a port. */
  primary: string;
  /** Memory cap in MB per service. A service left out gets the default. */
  memoryMb: Record<string, number>;
  secrets: Record<string, SecretRecipe>;
  inputs: TemplateInputDef[];
  compose: string;
}

export const DEFAULT_TEMPLATE_MEMORY_MB = 512;

const TOKEN = /\{\{([^{}]*)\}\}/g;
type Token =
  | { type: "secret" | "input" | "host"; name: string }
  | { type: "ref"; name: string; field: P.EnvRefField }
  | { type: "url" | "hostname" };

function readToken(raw: string): Token | null {
  const parts = raw.trim().split(".");
  if (parts.length === 1 && (parts[0] === "url" || parts[0] === "hostname")) return { type: parts[0] };
  if (parts.length === 2 && (parts[0] === "secret" || parts[0] === "input" || parts[0] === "host") && parts[1]) return { type: parts[0], name: parts[1] };
  if (parts.length === 3 && parts[0] === "ref" && parts[1]) {
    const field = P.EnvRefField.safeParse(parts[2]);
    if (field.success) return { type: "ref", name: parts[1], field: field.data };
  }
  return null;
}

const tokensIn = (value: string): Token[] => [...value.matchAll(TOKEN)].map((m) => readToken(m[1]!) ?? ({ type: "secret", name: `\0${m[1]}` } as Token));

const isManaged = (s: AppSpec): boolean => s.source.type === "service";

/** Letters and digits only, safe in any URL or shell. */
export function generateSecret(recipe: SecretRecipe): string {
  switch (recipe) {
    case "hex16": return randomBytes(16).toString("hex");
    case "hex32": return randomBytes(32).toString("hex");
    case "b64url24": return randomBytes(24).toString("base64url");
    case "b64url32": return randomBytes(32).toString("base64url");
    case "b64url48": return randomBytes(48).toString("base64url");
  }
}

/** The specs of a template, or every reason it may not ship. A test holds all of the catalog to this. */
export function checkTemplate(t: Template): { specs: AppSpec[]; problems: string[] } {
  const problems: string[] = [];
  const parsed = parseComposeText(t.compose);
  for (const r of parsed.refusals) problems.push(`${r.field}: ${r.reason}`);
  // A template is written here, so nothing in it may need a "this was left out" note.
  for (const w of parsed.warnings) problems.push(`warning: ${w}`);
  const specs = parsed.specs;
  const names = new Set(specs.map((s) => s.name));
  const primary = specs.find((s) => s.name === t.primary);
  if (!primary) problems.push(`primary ${t.primary} is not a service`);
  else if (isManaged(primary) || primary.run?.port == null) problems.push(`primary ${t.primary} has no port to route`);
  for (const k of Object.keys(t.memoryMb)) if (!names.has(k)) problems.push(`memoryMb names ${k}, which is not a service`);

  const secretsUsed = new Set<string>();
  const inputsUsed = new Set<string>();
  for (const s of specs) {
    if (s.source.type === "image") {
      const tag = /:([^:/@]+)(?:@|$)/.exec(s.source.image)?.[1];
      if (!tag) problems.push(`${s.name}: pin the image by a tag`);
      else if (["latest", "stable", "main", "master", "edge", "nightly", "dev"].includes(tag)) problems.push(`${s.name}: ${tag} is a moving tag; pin a version`);
      // Digests are recorded by the first pull on each server, never written by hand.
      if (s.source.image.includes("@")) problems.push(`${s.name}: no digest in a template, the first pull records it`);
    }
    for (const field of [s.source.type === "image" ? s.source.image : "", s.run?.startCommand ?? "", ...(s.volumes ?? []).flatMap((v) => [v.name, v.path])]) {
      if (field.includes("{{")) problems.push(`${s.name}: a token may only appear in an environment value`);
    }
    for (const e of s.env ?? []) {
      const tokens = tokensIn(e.value);
      if (/\{\{|\}\}/.test(e.value.replace(TOKEN, ""))) problems.push(`${s.name}.${e.key}: stray braces`);
      for (const tok of tokens) {
        if (tok.type === "secret") {
          if (t.secrets[tok.name]) secretsUsed.add(tok.name);
          else problems.push(`${s.name}.${e.key}: unknown token or secret ${tok.name.replace("\0", "")}`);
        } else if (tok.type === "input") {
          if (t.inputs.some((i) => i.key === tok.name)) inputsUsed.add(tok.name);
          else problems.push(`${s.name}.${e.key}: unknown input ${tok.name}`);
        } else if (tok.type === "host") {
          const to = specs.find((x) => x.name === tok.name);
          if (!to || isManaged(to)) problems.push(`${s.name}.${e.key}: {{host.${tok.name}}} needs a plain image service`);
        } else if (tok.type === "ref") {
          const to = specs.find((x) => x.name === tok.name);
          if (!to || !isManaged(to)) problems.push(`${s.name}.${e.key}: {{ref.${tok.name}}} needs a managed service`);
          else if (!P.refFieldAllowed(to.kind as "postgres" | "redis", tok.field)) problems.push(`${s.name}.${e.key}: ${to.kind} has no ${tok.field}`);
          if (!new RegExp(`^\\{\\{\\s*ref\\.[^{}]*\\}\\}$`).test(e.value)) problems.push(`${s.name}.${e.key}: a link must be the whole value`);
        }
      }
    }
  }
  for (const k of Object.keys(t.secrets)) if (!secretsUsed.has(k)) problems.push(`secret ${k} is never used`);
  for (const i of t.inputs) if (!inputsUsed.has(i.key)) problems.push(`input ${i.key} is never used`);
  return { specs, problems };
}

const usesAddress = (specs: AppSpec[]): boolean => specs.some((s) => (s.env ?? []).some((e) => tokensIn(e.value).some((tok) => tok.type === "url" || tok.type === "hostname")));

const rowValue = (t: Template, value: string): { shows: string; secret: boolean } => {
  let secret = false;
  const shows = value.replace(TOKEN, (_m, raw: string) => {
    const tok = readToken(raw);
    if (!tok) return "?";
    switch (tok.type) {
      case "secret": secret = true; return "generated secret";
      case "ref": secret = true; return `link to ${tok.name}: ${tok.field}`;
      case "input": return t.inputs.find((i) => i.key === tok.name)?.label ?? tok.name;
      case "host": return `address of ${tok.name}`;
      case "url": return "https://your-domain";
      case "hostname": return "your-domain";
    }
  });
  return { shows, secret };
};

const MANAGED_LABEL: Record<string, string> = { postgres: "Postgres", redis: "Redis" };

export function describeTemplate(t: Template): z.infer<typeof T.TemplateRow> {
  const { specs } = checkTemplate(t);
  return {
    id: t.id, name: t.name, summary: t.summary, category: t.category, icon: t.icon, license: t.license, homepage: t.homepage, docs: t.docs,
    firstRun: t.firstRun,
    needsDomain: usesAddress(specs),
    inputs: t.inputs,
    apps: specs.map((s) => ({
      service: s.name,
      kind: s.kind,
      image: s.source.type === "image" ? s.source.image : "",
      managed: s.source.type === "service" ? `${MANAGED_LABEL[s.source.service] ?? s.source.service} ${s.source.version}` : null,
      command: s.run?.startCommand || null,
      port: s.run?.port ?? null,
      primary: s.name === t.primary,
      volumes: s.volumes ?? [],
      memoryMb: t.memoryMb[s.name] ?? DEFAULT_TEMPLATE_MEMORY_MB,
      env: (s.env ?? []).map((e) => ({ key: e.key, ...rowValue(t, e.value) })),
    })),
  };
}

/** Per input type: only characters that mean nothing to a shell, an env file or a URL. */
const INPUT_RULE: Record<TemplateInputDef["type"], { re: RegExp; says: string }> = {
  email: { re: /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9.-]{1,180}\.[A-Za-z]{2,24}$/, says: "Enter an email address" },
  text: { re: /^[\p{L}\p{N} ._@:+-]{1,120}$/u, says: "Use letters, numbers, spaces and . _ @ : + -" },
};

export interface ResolveInput {
  /** The name the routed app gets; the others are <base>-<service>. */
  base: string;
  hostname: string | null;
  inputs: Record<string, string>;
  /** Pre-assigned app ids by service key, so a value can name a sibling before it exists. */
  ids: Record<string, string>;
  hostOf: (id: string) => string;
  secret?: (recipe: SecretRecipe) => string;
}

export interface ResolvedApp {
  id: string;
  service: string;
  name: string;
  spec: AppSpec;
  /** Plain values: shown in the variables page. Everything else in spec.env is sealed and masked. */
  plain: Set<string>;
  refs: Array<{ key: string; serviceId: string; field: P.EnvRefField }>;
  memoryMb: number;
}

export class TemplateError extends Error {
  readonly refusals: Refusal[];
  constructor(refusals: Refusal[]) {
    super(refusals[0]?.reason ?? "Refused");
    this.name = "TemplateError";
    this.refusals = refusals;
  }
}

/** Fills the template in. Anything wrong is a refusal, and nothing was created. */
export function resolveTemplate(t: Template, input: ResolveInput): ResolvedApp[] {
  const { specs, problems } = checkTemplate(t);
  if (problems.length) throw new TemplateError([{ field: "templateId", reason: `This template failed its review: ${problems[0]}` }]);

  const refusals: Refusal[] = [];
  const known = new Set(t.inputs.map((i) => i.key));
  for (const k of Object.keys(input.inputs)) if (!known.has(k)) refusals.push({ field: `inputs.${k}`, reason: "This template does not take that" });
  for (const i of t.inputs) {
    const v = input.inputs[i.key]?.trim() ?? "";
    if (!v) refusals.push({ field: `inputs.${i.key}`, reason: `${i.label} is required` });
    else if (!INPUT_RULE[i.type].re.test(v)) refusals.push({ field: `inputs.${i.key}`, reason: INPUT_RULE[i.type].says });
  }
  if (usesAddress(specs) && !input.hostname) refusals.push({ field: "domain", reason: `${t.name} needs its address, so pick a domain` });
  const nameOf = (service: string) => (service === t.primary ? input.base : `${input.base}-${service}`);
  if (refusals.length) throw new TemplateError(refusals);

  const generate = input.secret ?? generateSecret;
  const secrets = Object.fromEntries(Object.entries(t.secrets).map(([k, r]) => [k, generate(r)]));
  const idOf = (service: string) => {
    const id = input.ids[service];
    if (!id) throw new TemplateError([{ field: "templateId", reason: `No id for ${service}` }]);
    return id;
  };

  const out: ResolvedApp[] = specs.map((s) => {
    const plain = new Set<string>();
    const refs: ResolvedApp["refs"] = [];
    const env: Array<{ key: string; value: string }> = [];
    for (const e of s.env ?? []) {
      const tokens = tokensIn(e.value);
      const first = tokens[0];
      if (first?.type === "ref") {
        refs.push({ key: e.key, serviceId: idOf(first.name), field: first.field });
        continue;
      }
      if (!tokens.some((x) => x.type === "secret")) plain.add(e.key);
      // One pass over the template's own text: a typed value is never scanned for tokens.
      const value = e.value.replace(TOKEN, (_m, raw: string) => {
        const tok = readToken(raw)!;
        switch (tok.type) {
          case "secret": return secrets[tok.name]!;
          case "input": return input.inputs[tok.name]!.trim();
          case "url": return `https://${input.hostname}`;
          case "hostname": return input.hostname!;
          case "host": return input.hostOf(idOf(tok.name));
          default: return "";
        }
      });
      env.push({ key: e.key, value });
    }
    const { env: _dropped, ...rest } = s;
    const spec = P.AppSpec.safeParse({ ...rest, name: nameOf(s.name), ...(env.length ? { env } : {}) });
    if (!spec.success) throw new TemplateError(spec.error.issues.map((i) => ({ field: i.path[0] === "name" ? "name" : `apps.${s.name}.${i.path.join(".")}`, reason: i.message })));
    // The same refusals createApps runs, with the linked keys in view too: a link is still a variable.
    const refused = checkSpec({ ...spec.data, env: [...(spec.data.env ?? []), ...refs.map((r) => ({ key: r.key, value: "x" }))] });
    if (refused.length) throw new TemplateError(refused);
    return { id: idOf(s.name), service: s.name, name: spec.data.name, spec: spec.data, plain, refs, memoryMb: t.memoryMb[s.name] ?? DEFAULT_TEMPLATE_MEMORY_MB };
  });
  return out;
}
