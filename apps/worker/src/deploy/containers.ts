/** Names, labels and the input shape every app container and one-off shares. */
import type { ContainerInput, VolumeMount } from "@dockify/engine";
import type { ContainerInfo } from "@dockify/engine";
import { RESERVED_NAME_PREFIX } from "@dockify/contracts";

export const LABEL = {
  app: "dockify.app",
  deployment: "dockify.deployment",
  environment: "dockify.environment",
  project: "dockify.project",
  role: "dockify.role",
} as const;

/** Traefik's container, joined to each environment network so it can reach backends by name. */
export const PROXY_CONTAINER = "dockify-proxy";
/** The agent's container: it joins a tenant network for as long as a dial needs it, and never keeps one alive. */
export const AGENT_CONTAINER = "dockify-agent";

export const canonicalName = (appId: string) => `dk-${appId}`;
export const parkedName = (appId: string, now = Date.now()) => `dk-${appId}-prev-${now.toString(36)}`;
/** The names among these containers that an app's swaps parked, newest first. */
export function parkedNames(containers: ReadonlyArray<{ Names: string[] }>, appId: string): string[] {
  const prefix = parkedName(appId, 0).slice(0, -1);
  const stamp = (n: string) => parseInt(n.slice(prefix.length), 36);
  return containers.flatMap((c) => c.Names.map((n) => n.replace(/^\//, "")).filter((n) => n.startsWith(prefix))).sort((a, b) => stamp(b) - stamp(a));
}
export const releaseName = (appId: string, deploymentId: string) => `dk-${appId}-release-${deploymentId.slice(0, 8)}`;
export const jobRunName = (appId: string, runId: string) => `dk-${appId}-job-${runId.slice(0, 8)}`;
export const envNetwork = (environmentId: string) => `dockify-env-${environmentId}`;

/**
 * The DNS alias only one deployment's container holds on its environment network, and what the
 * app's route points at (edge/routes.ts). Docker's DNS answers it with the container's current
 * address, so a reboot that hands out new addresses never sends the route to another container,
 * and a swap moves traffic by rewriting the route from one alias to the next. The dk- prefix is
 * reserved for Dockify (contracts RESERVED_NAME_PREFIX), and the alias is longer than any app
 * name, so no tenant service can answer for it.
 */
export const ROUTE_ALIAS_PREFIX = "dk-route-";
export const routeAlias = (deploymentId: string) => `${ROUTE_ALIAS_PREFIX}${deploymentId}`;

/** The route alias a container holds on `network`, or null for one made before route aliases existed. */
export function routeAliasOf(info: Pick<ContainerInfo, "NetworkSettings">, network: string): string | null {
  const ep = info.NetworkSettings.Networks[network];
  return [...(ep?.Aliases ?? []), ...(ep?.DNSNames ?? [])].find((a) => a.startsWith(ROUTE_ALIAS_PREFIX)) ?? null;
}

export interface RunnableApp {
  id: string;
  /**
   * The app's name (contracts AppName), never its display name: what the running app answers to on
   * its environment network, so its siblings reach it as name:port, the way they reach a database.
   * Releases and jobs never take it. Left out, the container answers only to its dk- names.
   */
  name?: string;
  kind: string;
  environmentId: string;
  projectId: string;
  port: number | null;
  startCommand: string | null;
  memoryLimitMb: number | null;
  cpuLimit: number | null;
  pidsLimit: number | null;
  capAdd: string[];
  sysctls: Record<string, string>;
  volumes: Array<{ id: string; name: string; mountPath: string }>;
}

export function mounts(app: RunnableApp): VolumeMount[] {
  // Volume.name is the Docker volume name: unique on the instance and stable across deploys.
  return app.volumes.map((v) => ({ name: v.name, mountPath: v.mountPath }));
}

export function labelsFor(app: RunnableApp, deploymentId: string, role: "app" | "release" | "job"): Record<string, string> {
  return {
    [LABEL.app]: app.id,
    [LABEL.deployment]: deploymentId,
    [LABEL.environment]: app.environmentId,
    [LABEL.project]: app.projectId,
    [LABEL.role]: role,
  };
}

/**
 * Characters only a shell gives a meaning to, and a leading NAME=value. Anything else can run without
 * one; an = further on is part of a word ("--port=3000").
 */
const SHELL_SYNTAX = /[|&;<>()$`\\"'*?[\]#~{}!\n]|^\s*[A-Za-z_]\w*=/;
/** Words a shell itself understands, which exist as no program in most images. */
const SHELL_WORDS = new Set(["cd", "exec", "export", "source", ".", ":", "set", "unset", "eval", "ulimit", "umask", "trap", "wait", "if", "for", "while", "case"]);

/** The words of a command that needs no shell, or null when it does (or is blank). */
export function plainWords(command: string): string[] | null {
  const words = command.trim().split(/\s+/).filter(Boolean);
  if (!words.length || SHELL_SYNTAX.test(command) || SHELL_WORDS.has(words[0]!)) return null;
  return words;
}

/**
 * How a start command or a release command runs:
 *   a plain command   as an argv in place of the image's ENTRYPOINT, so it needs no shell in the
 *                     image and a scratch or distroless image can use it
 *   leading flags     as arguments to the image's own ENTRYPOINT ("--name v2" on traefik/whoami),
 *                     since a flag can name no program
 *   shell syntax      through sh -c, the one case that needs a shell in the image
 * The hint in apps/web (START_COMMAND_HINT) says the same. See imageArguments for commands saved
 * before this rule, whose first word is a subcommand of the image's entrypoint.
 */
export function commandInput(command: string): Pick<ContainerInput, "entrypoint" | "cmd"> {
  const words = plainWords(command);
  if (!words) return { entrypoint: ["sh", "-c"], cmd: [command] };
  if (words[0]!.startsWith("-")) return { cmd: words };
  return { entrypoint: [words[0]!], cmd: words.slice(1) };
}

/**
 * The same command as arguments to the image's own ENTRYPOINT, for an image whose entrypoint
 * takes subcommands ("server /data"). Tried only after the
 * first word turned out to be no program in the image, on an image that has an ENTRYPOINT. Null
 * when the command does not qualify.
 */
export function imageArguments(command: string): { cmd: string[] } | null {
  const words = plainWords(command);
  return words && !words[0]!.startsWith("-") ? { cmd: words } : null;
}

/**
 * The names the running app answers to on its environment network: its canonical name, the route
 * alias of this deployment, and its own name. A name with the reserved dk- prefix is never taken (no
 * app can have one, contracts AppName), so the name can never stand in for a route target or a
 * Dockify container. Previews never come through here (preview.ts), so a preview only reaches a
 * production app by name when it shares the production network, which the project owner allows.
 */
export function appAliases(app: Pick<RunnableApp, "id" | "name">, deploymentId: string): string[] {
  const own = app.name && !app.name.startsWith(RESERVED_NAME_PREFIX) ? [app.name] : [];
  return [canonicalName(app.id), routeAlias(deploymentId), ...own];
}

/** The containerSpec input for the app or its release one-off. One place, so both get the same caps. */
export function appContainerInput(app: RunnableApp, o: { name: string; imageId: string; env: Record<string, string>; deploymentId: string; role: "app" | "release" | "job"; cmd?: string | null }): ContainerInput {
  const command = o.cmd ?? (o.role === "app" ? app.startCommand : null);
  return {
    name: o.name,
    image: o.imageId,
    network: envNetwork(app.environmentId),
    // Only the serving container: a release or a job answering to the app's name would take a share of its traffic.
    aliases: o.role === "app" ? appAliases(app, o.deploymentId) : [],
    env: o.env,
    ...(command ? commandInput(command) : {}),
    port: o.role === "app" ? app.port : null,
    memoryMb: app.memoryLimitMb,
    cpuCores: app.cpuLimit,
    pidsLimit: app.pidsLimit,
    capAdd: app.capAdd,
    sysctls: app.sysctls,
    volumes: o.role === "app" ? mounts(app) : [],
    labels: labelsFor(app, o.deploymentId, o.role),
    restart: o.role === "app" ? "unless-stopped" : "no",
  };
}
