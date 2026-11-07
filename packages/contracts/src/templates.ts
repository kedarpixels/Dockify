/**
 * One-click templates: reviewed files that ship with the release (apps/api/src/modules/templates).
 * The list is what will run, shown before the press, so it never holds a value worth hiding: a
 * generated secret appears as its description, and only the server ever generates one.
 */
import { z } from "zod";
import { AppKind, EnvName, Hostname, Port } from "./common.ts";

export const TemplateId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
/** The name its apps are named from: the routed app gets it, the others get <name>-<service>. */
export const TemplateAppBase = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,18}[a-z0-9])?$/, "Lowercase letters, numbers and hyphens, up to 20 characters, not starting or ending with a hyphen");

export const TemplateEnvRow = z.object({
  key: z.string(),
  /** What the variable will hold, in words for anything generated or linked. */
  shows: z.string(),
  /** Sealed and masked in the dashboard: generated, linked, or typed as sensitive. */
  secret: z.boolean(),
});
export const TemplateAppRow = z.object({
  /** Its service key in the template; the app is named from it. */
  service: z.string(),
  kind: AppKind,
  /** Empty for a managed service. */
  image: z.string(),
  /** "Postgres 17": set for a managed service, which Dockify runs and backs up. */
  managed: z.string().nullable(),
  command: z.string().nullable(),
  port: Port.nullable(),
  /** The one app that gets the domain. */
  primary: z.boolean(),
  volumes: z.array(z.object({ name: z.string(), path: z.string() })),
  memoryMb: z.number(),
  env: z.array(TemplateEnvRow),
});
export const TemplateInput = z.object({
  key: z.string(),
  label: z.string(),
  hint: z.string(),
  type: z.enum(["email", "text"]),
});
export const TemplateRow = z.object({
  id: TemplateId,
  name: z.string(),
  summary: z.string(),
  category: z.string(),
  /** A slug of the icon set the web ships (components/new-app/template-icons.ts). */
  icon: z.string(),
  license: z.string(),
  homepage: z.string(),
  docs: z.string(),
  /** What the owner meets on the first visit, said plainly: a setup page, a generated login. */
  firstRun: z.string(),
  /** Its env uses the app's address, so it cannot run without a domain. */
  needsDomain: z.boolean(),
  apps: z.array(TemplateAppRow),
  inputs: z.array(TemplateInput),
});
export const TemplateList = z.array(TemplateRow);

export const TemplateDomain = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("test") }),
  z.strictObject({ type: z.literal("custom"), hostname: Hostname }),
  z.strictObject({ type: z.literal("none") }),
]);
export const DeployTemplateBody = z.strictObject({
  templateId: TemplateId,
  environment: EnvName,
  name: TemplateAppBase,
  domain: TemplateDomain,
  inputs: z.record(z.string().max(64), z.string().max(200)).default({}),
});
export const DeployTemplateResponse = z.object({
  ids: z.array(z.string()),
  primaryId: z.string(),
  /** The address it will answer on, once deployed and its certificate is issued. */
  url: z.string().nullable(),
  /** The apps exist and deploy, but something after them did not work. */
  warning: z.string().nullable(),
});
