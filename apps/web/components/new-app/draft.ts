import { fullName, type Picked } from "@/components/git/import-parts";
import { parseRepo } from "@/components/git/parse";
import { envName } from "@/components/ui/env-tag";
import type { ComposeResult } from "./compose";
import { BRANCH_MESSAGE, BRANCH_NAME, hasReservedPrefix, isReservedServiceName, RESERVED_NAME_MESSAGE, RESERVED_SERVICE_MESSAGE, unreservedServiceName } from "@/lib/validation";
import type { AppKind } from "@/lib/types";
import {
  APP_NAME,
  FRONTEND_FRAMEWORKS,
  IMAGE_REF,
  imageName,
  isCommand,
  isRepoPath,
  LINKABLE_KINDS,
  listNames,
  readPort,
  SERVICE_KIND,
  SERVICE_LABEL,
  SERVICE_VERSIONS,
  appSlug,
  type AppSpec,
  type Builder,
  type DeployTarget,
  type DetectResult,
  type LinkConflict,
  type RunKind,
  type ServiceKind,
  type SourceType,
} from "./spec";

/*
 * The flow's drafts, one per source plus the shared details, and the pure rules that check them
 * and turn them into the AppSpec list the API takes. Fields hold what the operator typed (ports
 * as text), so a half typed value never jumps.
 */

export type Detect = { state: "idle" } | { state: "loading" } | { state: "done"; result: DetectResult } | { state: "error"; error: string };

export interface BuildDraft {
  builder: Builder;
  framework: string | null;
  /** Blank lets Railpack decide what it detected, at each deploy. */
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  dockerfilePath: string;
  port: string;
}

export interface GitDraft {
  byUrl: boolean;
  /** The URL typed in the import by URL view, kept so Back and the footer key both see it. */
  url: string;
  /** Continue was pressed on the URL view, so its error shows. */
  urlTried: boolean;
  account: string | null;
  picked: Picked | null;
  branch: string;
  rootDir: string;
  build: BuildDraft;
  /** Set once the operator changes a build field, so a late detection never overwrites them. */
  edited: boolean;
  detect: Detect;
}

export interface ImageDraft {
  image: string;
  /** null is a public image, no credentials. */
  registryId: string | null;
  /** The operator picked the registry, so the host match stops choosing it. */
  registryPicked: boolean;
  startCommand: string;
  port: string;
}

export interface ServiceDraft {
  service: ServiceKind;
  version: string;
}

export interface ComposeDraft {
  text: string;
  /** Services left out by the operator. Everything the plan proposes starts included. */
  excluded: string[];
  /** Kind overrides for image apps, by service key. */
  kinds: Record<string, RunKind>;
}

export interface DetailsDraft {
  name: string;
  /** The operator typed the name, so the source stops proposing one. */
  named: boolean;
  environment: string;
  kind: RunKind | null;
  target: DeployTarget;
  /**
   * A service only: the app ids checked under "Link to apps", across environments, so switching
   * back keeps a check. Only the ones in the chosen environment are sent.
   */
  links: string[];
}

/** Auto: the repository's Dockerfile when it has one, else Railpack, until the read of the repository says which. */
const BLANK_BUILD: BuildDraft = { builder: "auto", framework: null, installCommand: "", buildCommand: "", startCommand: "", dockerfilePath: "", port: "" };

export const initialGit = (): GitDraft => ({ byUrl: false, url: "", urlTried: false, account: null, picked: null, branch: "", rootDir: "", build: BLANK_BUILD, edited: false, detect: { state: "idle" } });

/** A new pick: the build, its detection and the folder start over for the new repository. */
export const repoPicked = (d: GitDraft, picked: Picked, branch: string): GitDraft => ({ ...d, build: BLANK_BUILD, edited: false, detect: { state: "idle" }, rootDir: "", picked, branch });

/** Continue on the URL view: the typed URL becomes the pick once it reads, else its error shows. */
export function pickUrl(d: GitDraft): GitDraft {
  const parsed = parseRepo(d.url);
  return parsed ? repoPicked({ ...d, urlTried: false }, { kind: "url", parsed }, "main") : { ...d, urlTried: true };
}
export const initialImage = (): ImageDraft => ({ image: "", registryId: null, registryPicked: false, startCommand: "", port: "" });
export const initialService = (): ServiceDraft => ({ service: "postgres", version: SERVICE_VERSIONS.postgres[0]! });
export const initialCompose = (): ComposeDraft => ({ text: "", excluded: [], kinds: {} });

export const repoUrlOf = (p: Picked) => (p.kind === "git" ? `https://github.com/${p.repo.fullName}` : p.parsed.url);

// -------------- Step 2 checks --------------

export type Errors = Partial<Record<"branch" | "rootDir" | "dockerfilePath" | "installCommand" | "buildCommand" | "startCommand" | "port" | "image" | "compose" | "name" | "target", string>>;

export function gitErrors(d: GitDraft): Errors {
  const e: Errors = {};
  if (!d.branch.trim()) e.branch = "Enter the branch to deploy";
  else if (!BRANCH_NAME.test(d.branch)) e.branch = BRANCH_MESSAGE;
  if (!isRepoPath(d.rootDir, { allowEmpty: true })) e.rootDir = "A folder inside the repository, like apps/web";
  if (d.build.builder === "dockerfile" && !isRepoPath(d.build.dockerfilePath, { allowEmpty: false })) e.dockerfilePath = "A path inside the root directory, like Dockerfile";
  if (!isCommand(d.build.installCommand)) e.installCommand = "One line, up to 1,000 characters";
  if (!isCommand(d.build.buildCommand)) e.buildCommand = "One line, up to 1,000 characters";
  if (!isCommand(d.build.startCommand)) e.startCommand = "One line, up to 1,000 characters";
  if (!readPort(d.build.port).ok) e.port = "A port from 1 to 65535";
  return e;
}

export function imageErrors(d: ImageDraft): Errors {
  const e: Errors = {};
  const ref = d.image.trim();
  if (!ref) e.image = "Enter an image reference";
  else if (!IMAGE_REF.test(ref)) e.image = "Use a reference like ghcr.io/owner/app:1.0, in lowercase";
  if (!isCommand(d.startCommand)) e.startCommand = "One line, up to 1,000 characters";
  if (!readPort(d.port).ok) e.port = "A port from 1 to 65535";
  return e;
}

export function composeErrors(d: ComposeDraft, plan: ComposeResult | null): Errors {
  if (!d.text.trim()) return { compose: "Paste a docker-compose.yml" };
  if (!plan) return {};
  if (!plan.ok) return { compose: plan.error };
  if (!plan.plan.apps.some((a) => !d.excluded.includes(a.service))) return { compose: "Pick at least one service to import" };
  return {};
}

// -------------- Names and kinds --------------

/**
 * What the source proposes as the app's name, before the operator types one: the first one free in
 * the environment, so a second Postgres arrives as "postgres-2" instead of on an error.
 */
export function proposedName(source: SourceType | null, git: GitDraft, image: ImageDraft, service: ServiceDraft, taken: ReadonlySet<string>): string {
  if (source === "git" && git.picked) return firstFree(appSlug(git.rootDir.split("/").filter(Boolean).pop() ?? "") || appSlug(git.picked.kind === "git" ? git.picked.repo.name : git.picked.parsed.repo), taken);
  if (source === "image") return firstFree(imageName(image.image.trim()), taken);
  if (source === "service") return firstFree(unreservedServiceName(service.service), taken);
  return "";
}

/** `base`, or the first of base-2, base-3 ... not taken, cut to the 32 characters a name may have. */
function firstFree(base: string, taken: ReadonlySet<string>): string {
  if (!base || !taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const suffix = `-${i}`;
    const name = `${base.slice(0, 32 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(name)) return name;
  }
  return base;
}

/** The kind a repository app starts as: a frontend when its framework serves a site. */
export function proposedKind(source: SourceType | null, git: GitDraft): RunKind {
  return source === "git" && git.build.framework && FRONTEND_FRAMEWORKS.has(git.build.framework) ? "frontend" : "backend";
}

/** The composed apps the operator kept, with their kind overrides. */
export function composeSpecs(d: ComposeDraft, plan: ComposeResult | null): AppSpec[] {
  if (!plan?.ok) return [];
  return plan.plan.apps
    .filter((a) => !d.excluded.includes(a.service))
    .map((a) => (a.spec.source.type === "image" && d.kinds[a.service] ? { ...a.spec, kind: d.kinds[a.service]! } : a.spec));
}

/** `environment` is null in a project with one environment, which names none. */
export function nameError(name: string, taken: ReadonlySet<string>, environment: string | null, isService = false): string | undefined {
  if (!name) return "Enter a name";
  if (!APP_NAME.test(name)) return "Use lowercase letters, numbers and hyphens, up to 32 characters, not starting or ending with a hyphen";
  if (hasReservedPrefix(name)) return RESERVED_NAME_MESSAGE;
  if (isService && isReservedServiceName(name)) return RESERVED_SERVICE_MESSAGE;
  if (taken.has(name)) return `${name} already exists in ${environment ? envName(environment) : "this project"}`;
  return undefined;
}

// -------------- The request --------------

/** The one app a single source creates. Assumes its step 2 checks passed. */
export function singleSpec(source: Exclude<SourceType, "compose">, d: DetailsDraft, git: GitDraft, image: ImageDraft, service: ServiceDraft): AppSpec {
  if (source === "service") {
    return { name: d.name, kind: SERVICE_KIND[service.service], source: { type: "service", ...service }, target: "server" };
  }
  const kind = d.kind ?? "backend";
  if (source === "image") {
    const port = readPort(image.port);
    return {
      name: d.name,
      kind,
      source: { type: "image", image: image.image.trim(), registryId: image.registryId },
      run: { startCommand: image.startCommand.trim(), port: port.ok ? port.port : null },
      target: "server",
    };
  }
  const p = git.picked!;
  const port = readPort(git.build.port);
  return {
    name: d.name,
    kind,
    source: { type: "git", repoUrl: repoUrlOf(p), branch: git.branch.trim(), ...(p.kind === "git" ? { git: { installationId: p.installation.id, repoId: p.repo.id } } : {}) },
    build: {
      builder: git.build.builder,
      framework: git.build.framework,
      rootDir: git.rootDir.trim().replace(/\/+$/, ""),
      installCommand: git.build.builder === "dockerfile" ? "" : git.build.installCommand.trim(),
      buildCommand: git.build.builder === "dockerfile" ? "" : git.build.buildCommand.trim(),
      startCommand: git.build.startCommand.trim(),
      dockerfilePath: git.build.builder === "dockerfile" ? git.build.dockerfilePath.trim() : "",
      port: port.ok ? port.port : null,
    },
    target: kind === "frontend" ? d.target : "server",
  };
}

/** One line naming the source, for the summary on step 3 and the toast. */
export function sourceLine(source: SourceType, git: GitDraft, image: ImageDraft, service: ServiceDraft, count: number): string {
  if (source === "git" && git.picked) return `${fullName(git.picked)}, ${git.branch || "no branch"}${git.rootDir ? `, ${git.rootDir}` : ""}`;
  if (source === "image") return image.image.trim();
  if (source === "service") return `${SERVICE_LABEL[service.service]} ${service.version}`;
  return `${count.toLocaleString("en-US")} ${count === 1 ? "service" : "services"} from docker-compose.yml`;
}

// -------------- Linking a new service --------------

/** The apps a new service can be linked to: the ones that run code in its environment. */
export const linkable = <A extends { kind: AppKind; environment: string }>(apps: readonly A[], environment: string): A[] =>
  apps.filter((a) => a.environment === environment && LINKABLE_KINDS.has(a.kind));

/**
 * What a conflict means and what "Replace and create" does about it, for the callout. An app's own
 * variable is replaced; a shared one stays for the other apps and the picked app gets its own.
 */
export function conflictLine(c: LinkConflict, service: string, environment: string | null): string {
  const own = c.apps.filter((a) => !a.shared).map((a) => a.name);
  const shared = c.apps.filter((a) => a.shared).map((a) => a.name);
  const parts: string[] = [];
  if (own.length) {
    parts.push(`${listNames(own)} already ${own.length === 1 ? "has" : "have"} ${c.key}. Replacing links ${own.length === 1 ? "it" : "them"} to ${service} instead.`);
  }
  if (shared.length) {
    parts.push(
      `${listNames(shared)} ${shared.length === 1 ? "gets" : "get"} ${c.key} from the ${environment ? `variables shared in ${envName(environment)}` : "shared variables"}. Replacing gives ${shared.length === 1 ? "it its" : "each its"} own, linked to ${service}; the other apps keep the shared one.`,
    );
  }
  return `${parts.join(" ")} Uncheck an app to leave it as it is.`;
}
