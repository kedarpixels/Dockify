import { isRecord } from "@/lib/validation";
import { hasReservedPrefix, RESERVED_NAME_MESSAGE } from "@/lib/validation";

/*
 * The browser's and the proxy's side of a template: the row the API lists, the draft, and the strict
 * checks both run. Pure, so they share one copy. The API checks everything again.
 */

export interface TemplateEnvRow {
  key: string;
  shows: string;
  secret: boolean;
}

export interface TemplateAppRow {
  service: string;
  kind: "frontend" | "backend" | "bot" | "postgres" | "redis" | "s3";
  image: string;
  managed: string | null;
  command: string | null;
  port: number | null;
  primary: boolean;
  volumes: Array<{ name: string; path: string }>;
  memoryMb: number;
  env: TemplateEnvRow[];
}

export interface TemplateRow {
  id: string;
  name: string;
  summary: string;
  category: string;
  icon: string;
  license: string;
  homepage: string;
  docs: string;
  firstRun: string;
  needsDomain: boolean;
  apps: TemplateAppRow[];
  inputs: Array<{ key: string; label: string; hint: string; type: "email" | "text" }>;
}

export type TemplateDomainChoice = "test" | "custom" | "none";

export interface TemplateDraft {
  picked: TemplateRow | null;
  name: string;
  domain: TemplateDomainChoice;
  hostname: string;
  inputs: Record<string, string>;
}

export const initialTemplate = (): TemplateDraft => ({ picked: null, name: "", domain: "test", hostname: "", inputs: {} });

/** A fresh draft for a card: its own name, proposed free in this environment. */
export function draftFor(row: TemplateRow, taken: ReadonlySet<string>, canTest: boolean): TemplateDraft {
  let name = row.id.slice(0, 20).replace(/-+$/, "");
  for (let i = 2; taken.has(name) && i < 100; i++) name = `${row.id.slice(0, 17).replace(/-+$/, "")}-${i}`;
  return { picked: row, name, domain: canTest ? "test" : "custom", hostname: "", inputs: {} };
}

export const TEMPLATE_BASE = /^[a-z0-9]([a-z0-9-]{0,18}[a-z0-9])?$/;
export const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL = /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9.-]{1,180}\.[A-Za-z]{2,24}$/;
const TEXT = /^[\p{L}\p{N} ._@:+-]{1,120}$/u;

/** What is wrong with the name, among the apps that already exist here. */
export function templateNameError(row: TemplateRow, name: string, taken: ReadonlySet<string>): string | undefined {
  if (!name) return "Enter a name";
  if (!TEMPLATE_BASE.test(name)) return "Use lowercase letters, numbers and hyphens, up to 20 characters, not starting or ending with a hyphen";
  if (hasReservedPrefix(name)) return RESERVED_NAME_MESSAGE;
  const clash = row.apps.map((a) => (a.primary ? name : `${name}-${a.service}`)).find((n) => taken.has(n));
  return clash ? `${clash} already exists here` : undefined;
}

export const templateHostError = (d: TemplateDraft): string | undefined =>
  d.domain !== "custom" ? undefined : !d.hostname.trim() ? "Enter a hostname" : HOSTNAME.test(d.hostname.trim().toLowerCase()) ? undefined : "A full hostname, like app.example.com";

export function templateInputError(type: "email" | "text", value: string | undefined): string | undefined {
  const v = value?.trim() ?? "";
  if (!v) return "Required";
  if (type === "email") return EMAIL.test(v) ? undefined : "Enter an email address";
  return TEXT.test(v) ? undefined : "Use letters, numbers, spaces and . _ @ : + -";
}

export interface DeployTemplateInput {
  project: string;
  environment: string;
  templateId: string;
  name: string;
  domain: { type: "test" } | { type: "custom"; hostname: string } | { type: "none" };
  inputs: Record<string, string>;
}

export interface DeployTemplateResult {
  ids: string[];
  primaryId: string;
  url: string | null;
  warning: string | null;
}

/** The body the proxy forwards, rebuilt from checked fields only, or the reason it refuses. */
export function readDeployTemplate(body: unknown): DeployTemplateInput | string {
  if (!isRecord(body)) return "That request is not valid";
  const { project, environment, templateId, name, domain, inputs } = body;
  if (typeof project !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(project)) return "Unknown project";
  if (typeof environment !== "string" || !/^[\w-]{1,32}$/.test(environment)) return "Unknown environment";
  if (typeof templateId !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(templateId)) return "Unknown template";
  if (typeof name !== "string" || !TEMPLATE_BASE.test(name)) return "The name is not valid";
  if (!isRecord(domain)) return "The domain is not valid";
  let d: DeployTemplateInput["domain"];
  if (domain.type === "test" || domain.type === "none") d = { type: domain.type };
  else if (domain.type === "custom" && typeof domain.hostname === "string" && HOSTNAME.test(domain.hostname)) d = { type: "custom", hostname: domain.hostname };
  else return "The domain is not valid";
  if (!isRecord(inputs)) return "The fields are not valid";
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inputs)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k) || typeof v !== "string" || v.length > 200) return "The fields are not valid";
    out[k] = v;
  }
  return { project, environment, templateId, name, domain: d, inputs: out };
}
