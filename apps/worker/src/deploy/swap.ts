/**
 * Zero downtime: park the old container (it keeps serving), start the new one, gate on readiness, flip the route.
 * Any failure up to and including the flip scraps the new container and restores the old one's name and route.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { appContainerInput, canonicalName, envNetwork, imageArguments, LABEL, parkedName, parkedNames, routeAlias, routeAliasOf, type RunnableApp } from "./containers.ts";
import { Demuxer, isConflict, isNotFound, isNotModified, type ContainerInfo, type DockerApi } from "@dockify/engine";
import { DeployCancelled, PermanentDeployError, reason } from "@dockify/engine";
import { couldNotRun, explainFailure, failureFacts, type FailureFacts } from "./failure.ts";
import type { DeployLog } from "./log.ts";
import { dialProbes, waitUntilReady, type HealthConfig, type ProbeDeps, type Readiness } from "./readiness.ts";
import { removeRoute, writeRoute } from "./routes.ts";
import { withRouteLock } from "../edge/route-lock.ts";
import { describeStrategy, swapStrategy } from "./strategy.ts";
import type { EdgeMode } from "../edge/ingress.ts";
import type { Dialer, RouteStore } from "../server/runtime.ts";

export const STOP_TIMEOUT_S = 20;
/** Lets Traefik's file watch load the new backend before the old one goes away. */
export const ROUTE_SETTLE_MS = 1_000;

export interface SwapApp extends RunnableApp {
  /** Every domain, primary first: the readiness probe sends the first as its Host header. */
  hosts: string[];
  /** The domains that get a router: those whose DNS points at this server (edge/hosts.ts). */
  routeHosts: string[];
  health: Omit<HealthConfig, "port" | "hostHeader">;
}

/**
 * Where a route can point while its container serves: the route alias, or the current address of a container
 * made before aliases existed, whose old route names dk-<app id>, which the new container takes over.
 */
function pinTarget(info: ContainerInfo, network: string): string | null {
  if (!info.State.Running) return null;
  return routeAliasOf(info, network) ?? (info.NetworkSettings.Networks[network]?.IPAddress || null);
}

export interface SwapDeps {
  docker: DockerApi;
  log: DeployLog;
  routes: RouteStore;
  mode: EdgeMode;
  dial: Dialer;
  proxyContainer: string;
  dashboardHost: string;
  probe?: Partial<ProbeDeps>;
  settleMs?: number;
  /**
   * The app's routable hosts as the database has them now. The build can take minutes, and a domain
   * added or removed meanwhile must not be undone by a route write that names the hosts it started with.
   */
  routeHosts?: () => Promise<string[]>;
}

export interface SwapResult {
  containerId: string;
  address: string | null;
  mode: "zero_downtime" | "stop_then_start";
}

export class RolledBackError extends PermanentDeployError {
  readonly rolledBack = true;
}

interface Previous {
  id: string;
  name: string;
  parked: string;
  stopped: boolean;
}

export async function swap(app: SwapApp, deploymentId: string, imageId: string, env: Record<string, string>, deps: SwapDeps, signal: AbortSignal): Promise<SwapResult> {
  const { docker, log } = deps;
  const name = canonicalName(app.id);
  const network = envNetwork(app.environmentId);
  const strategy = swapStrategy(app);
  log.system(describeStrategy(strategy));

  await docker.ensureNetwork(network, { "dockify.managed": "true", [LABEL.environment]: app.environmentId, [LABEL.project]: app.projectId });
  for (const v of app.volumes) await docker.ensureVolume(v.name, { "dockify.managed": "true", [LABEL.app]: app.id });

  // Every route write holds the app's route lock, as edge_route_sync does, and names the hosts read
  // under it. A read that fails keeps the last known hosts: the sync queued after the deploy corrects them.
  let routeHosts = app.routeHosts;
  const routeLocked = <T>(write: () => Promise<T>): Promise<T> =>
    withRouteLock(app.id, async () => {
      if (deps.routeHosts) routeHosts = await deps.routeHosts().catch(() => routeHosts);
      return write();
    });

  let previous: Previous | null = null;
  let previousInfo: ContainerInfo | null = null;
  try {
    previousInfo = await docker.inspectContainer(name);
    previous = { id: previousInfo.Id, name, parked: parkedName(app.id), stopped: false };
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }

  // What an interrupted swap left, newest first. Under the canonical name an earlier attempt of this
  // same deployment is unproven, so the parked container is the one to come back to. A canonical
  // container of another deployment stays the previous one, and the parked ones are only cleared.
  const left = parkedNames(await docker.listContainers({ [LABEL.app]: app.id }), app.id);
  if (left.length && previousInfo?.Config.Labels?.[LABEL.deployment] === deploymentId) {
    log.system("removing what an interrupted attempt of this deploy left");
    await docker.stopContainer(previousInfo.Id, 5).catch(() => {});
    await docker.removeContainer(previousInfo.Id, { volumes: true });
    previous = null;
    previousInfo = null;
  }
  const adopted = !previous ? (left.shift() ?? null) : null;
  if (adopted) {
    previousInfo = await docker.inspectContainer(adopted);
    previous = { id: previousInfo.Id, name, parked: adopted, stopped: !previousInfo.State.Running };
    log.system(`found the previous container still parked as ${adopted} after an interrupted deploy`);
  }

  const restore = async () => {
    if (!previous) return;
    if (previous.stopped) {
      await docker.startContainer(previous.id).catch((e) => {
        if (!isNotModified(e)) log.error(`could not restart the previous container: ${reason(e)}`);
      });
    }
    await docker.renameContainer(previous.parked, previous.name).catch((e) => log.error(`could not give the previous container its name back: ${reason(e)}`));
    const port = app.port;
    if (previous.stopped && port !== null) {
      // A restarted container comes back on a new address. A route to its alias follows on its
      // own; one pinned to its old address is re-keyed.
      const after = await docker.inspectContainer(previous.id).catch(() => null);
      const backend = after ? pinTarget(after, network) : null;
      if (backend) {
        await routeLocked(async () => {
          if (routeHosts.length) await writeRoute(deps.routes, { appId: app.id, hosts: routeHosts, port, backend }, deps.dashboardHost, deps.mode);
        }).catch((e) => log.error(`could not re-publish the route: ${reason(e)}`));
      }
    }
    log.system("previous container restored");
  };

  // Until the flip the route stays on the container that serves now, under a name the new one
  // never takes (see pinTarget). Unchanged for a container that already routes by its alias.
  const pin = previousInfo ? pinTarget(previousInfo, network) : null;
  const pinPort = app.port;
  if (pin && pinPort !== null) {
    await routeLocked(async () => {
      if (routeHosts.length) await writeRoute(deps.routes, { appId: app.id, hosts: routeHosts, port: pinPort, backend: pin }, deps.dashboardHost, deps.mode);
    });
  }

  if (previous) {
    // Both renames address the container by name, never by its daemon id: the socket proxy renames
    // only from one dk- name to another, so no control container can be renamed into the dk- names
    // that exec and attach trust (deploy/socket-proxy/haproxy.cfg).
    if (!adopted) await docker.renameContainer(previous.name, previous.parked);
    if (strategy.mode === "stop_then_start") {
      try {
        await docker.stopContainer(previous.id, STOP_TIMEOUT_S);
      } catch (e) {
        if (!isNotModified(e) && !isNotFound(e)) {
          await restore();
          throw e;
        }
      }
      previous.stopped = true;
      log.system(`previous container parked as ${previous.parked} and stopped`);
    } else if (!adopted) {
      log.system(`previous container parked as ${previous.parked}, still serving`);
    }
  }

  if (signal.aborted) {
    await restore();
    throw new DeployCancelled();
  }

  const input = appContainerInput(app, { name, imageId, env, deploymentId, role: "app" });
  let id: string;
  try {
    id = await docker.createContainer(name, input);
  } catch (e) {
    if (isConflict(e) && (await clearStray(docker, name, app.id, log))) {
      try {
        id = await docker.createContainer(name, input);
      } catch (e2) {
        await restore();
        throw e2;
      }
    } else {
      await restore();
      throw e;
    }
  }

  // A throwaway: nothing it wrote has served anyone, so its anonymous volumes go with it.
  const scrapNew = async () => {
    await docker.stopContainer(id, 5).catch(() => {});
    await docker.removeContainer(id, { volumes: true }).catch(() => {});
  };

  const startAndProbe = async (): Promise<Readiness> => {
    try {
      await docker.startContainer(id);
    } catch (e) {
      await scrapNew();
      await restore();
      throw new PermanentDeployError(`the new container could not start: ${reason(e)}`);
    }
    const capture = captureLogs(docker, id, log);
    try {
      const probe: ProbeDeps = {
        inspect: () => docker.inspectContainer(id),
        addressOf: (i: ContainerInfo) => i.NetworkSettings.Networks[network]?.IPAddress || null,
        ...dialProbes(deps.dial, id, network, signal),
        sleep: (ms, s) => sleep(ms, undefined, { signal: s }),
        now: () => Date.now(),
        ...deps.probe,
      };
      return await waitUntilReady({ ...app.health, port: app.port, hostHeader: app.hosts[0] ?? null }, probe, signal);
    } finally {
      capture.stop();
    }
  };
  const factsOf = (r: Readiness): Promise<FailureFacts> =>
    failureFacts(docker, id, { command: app.startCommand, info: r.info, exitCode: r.exitCode ?? null, redact: (l) => log.redactor.line(l) });

  let ready = await startAndProbe();
  let facts = ready.ok || signal.aborted ? null : await factsOf(ready);
  // A command saved before start commands replaced the entrypoint: its first word is a subcommand
  // of the image's own entrypoint. Nothing of it ran, so trying it that way is safe.
  const asArguments = facts && couldNotRun(facts) && app.startCommand ? imageArguments(app.startCommand) : null;
  if (asArguments && (await hasEntrypoint(docker, imageId))) {
    log.system(`${asArguments.cmd[0]} is not a program in this image, so the command goes to the image's own entrypoint as arguments`);
    await scrapNew();
    const { entrypoint: _replaced, ...rest } = input;
    try {
      id = await docker.createContainer(name, { ...rest, ...asArguments });
    } catch (e) {
      await restore();
      throw e;
    }
    ready = await startAndProbe();
    facts = ready.ok || signal.aborted ? null : await factsOf(ready);
  }

  if (!ready.ok) {
    await scrapNew();
    await restore();
    if (signal.aborted) throw new DeployCancelled();
    const kept = previous
      ? previous.stopped
        ? "Rolled back: the previous container was restarted and serves again."
        : "Rolled back: the previous container kept serving the whole time."
      : "There was no previous container, so nothing is running.";
    const why = facts ? explainFailure(facts) : "";
    if (why) log.error(why);
    throw new RolledBackError(`The new container ${ready.detail}. ${why ? `${why} ` : ""}${kept}`);
  }
  log.system(`new container ${ready.detail}`);

  // Point of no return: the route flip, to the alias only the new container holds. Cancel is no
  // longer honoured past here. A flip that throws has not moved the traffic, so the old one comes back.
  try {
    await routeLocked(async () => {
      if (app.port !== null && routeHosts.length && ready.address) {
        await docker.connectNetwork(network, deps.proxyContainer);
        const backend = routeAlias(deploymentId);
        await writeRoute(deps.routes, { appId: app.id, hosts: routeHosts, port: app.port, backend }, deps.dashboardHost, deps.mode);
        log.system(`route flipped to ${backend} (${ready.address}:${app.port}) for ${routeHosts.join(", ")}`);
      } else {
        await removeRoute(deps.routes, app.id);
        if (app.hosts.length) {
          log.system(app.port === null
            ? "not routing: the app has no port, and its image says none. Set the port in the app's Settings, then deploy again"
            : !routeHosts.length
              ? "not routing yet: no domain of this app points at this server; each one is routed once its DNS check passes"
              : "not routing: the container has no address");
        }
      }
    });
  } catch (e) {
    await scrapNew();
    await restore();
    throw e;
  }

  if (previous) {
    if (!previous.stopped) await sleep(deps.settleMs ?? ROUTE_SETTLE_MS);
    await docker.stopContainer(previous.id, STOP_TIMEOUT_S).catch(() => {});
    await docker.removeContainer(previous.id).catch((e) => {
      if (!isNotFound(e)) log.error(`could not remove the previous container: ${reason(e)}`);
    });
    log.system("previous container removed");
  }
  // Older ones the same way: left running, each is the app's old code, doing its work a second time.
  for (const stale of left) {
    await docker.stopContainer(stale, STOP_TIMEOUT_S).catch(() => {});
    await docker.removeContainer(stale).catch((e) => {
      if (!isNotFound(e)) log.error(`could not remove ${stale}: ${reason(e)}`);
    });
    log.system(`removed ${stale}, left by an interrupted deploy`);
  }
  return { containerId: id, address: ready.address, mode: strategy.mode };
}

export async function hasEntrypoint(docker: DockerApi, imageId: string): Promise<boolean> {
  const info = await docker.inspectImage(imageId).catch(() => null);
  return !!info?.Config?.Entrypoint?.length;
}

/** Frees the canonical name from our own leftover of an interrupted swap. Never touches others. */
async function clearStray(docker: DockerApi, name: string, appId: string, log: DeployLog): Promise<boolean> {
  try {
    const info = await docker.inspectContainer(name);
    if (info.Config.Labels?.[LABEL.app] !== appId) return false;
    log.system("removing a leftover container from an interrupted deploy");
    await docker.removeContainer(info.Id);
    return true;
  } catch (e) {
    if (isNotFound(e)) return true;
    throw e;
  }
}

function captureLogs(docker: DockerApi, id: string, log: DeployLog): { stop(): void } {
  let stream: { destroy(): void } | null = null;
  let stopped = false;
  void (async () => {
    try {
      const s = await docker.logs(id, true);
      if (stopped) return s.destroy();
      stream = s;
      const demux = new Demuxer();
      const out = log.splitter("stdout");
      const err = log.splitter("stderr");
      for await (const c of s) demux.push(c as Buffer, (k, d) => (k === "stderr" ? err : out).push(d.toString("utf8")));
      out.end();
      err.end();
    } catch {
    }
  })();
  return {
    stop() {
      stopped = true;
      stream?.destroy();
    },
  };
}
