/**
 * The worker's observability module. main.ts wires it with two calls:
 *
 *   const stopObserve = startObserve(runtime, { db, vault });  // one server: sampler, status, alerts, logs
 *   const stopCare = startObserveMaintenance({ db });          // rollups and retention, once per worker
 *   Object.assign(handlers, observeJobHandlers({ db, vault })); // the alert_notify job
 *
 * Every loop is single-flight (a slow pass skips the overlapping tick) and stop() waits out the
 * pass in flight. A failed pass is logged and the next tick tries again.
 */
import { stderrLog } from "../errors.ts";
import type { Db, JobKind, SecretVault } from "@dockify/db";
import { AGENT_CONTAINER } from "../deploy/containers.ts";
import type { Mailer } from "@dockify/email";
import type { WebhookTargets } from "../integrations/webhooks.ts";
import type { ClaimedJob } from "../queue.ts";
import type { ServerRuntime } from "../server/runtime.ts";
import { ALERT_NOTIFY_KIND, createAlertRunner, proxyPing } from "./alert-runner.ts";
import { reconcileAppStatus } from "./app-status.ts";
import { probeReachability, proxyProbe, type ReachProbe, type ReachState } from "./reach.ts";
import { recordControlPlane } from "./control-plane.ts";
import { deliverAlert } from "./channels.ts";
import { loadObserveConfig, type ObserveConfig } from "./config.ts";
import { createDockerReader, type DockerReader } from "./docker.ts";
import { createLogCollector, enforceLogCaps, logRetentionDays, pruneLogs, type SecretsFor } from "./logs.ts";
import { metricsMaintenance } from "./rollup.ts";
import { createSampler } from "./sampler.ts";
import { recordUptimeMinute } from "./uptime.ts";


export interface ObserveDeps {
  db: Db;
  vault: SecretVault;
  config?: ObserveConfig;
  docker?: DockerReader;
  /** The app's resolved secret values, for literal log redaction. Defaults to none. */
  secretsFor?: SecretsFor;
  /** The SMTP sender for alert email; the worker passes its one sender. */
  mail?: Mailer;
  /** The status page reachability probe; tests pass a fake. */
  reachProbe?: ReachProbe;
  log?: (msg: string, extra?: object) => void;
}


function loop(name: string, everyMs: number, fn: () => Promise<unknown>, log: ObserveDeps["log"] & {}): () => Promise<void> {
  let running = false;
  let current: Promise<void> = Promise.resolve();
  const pass = (): void => {
    if (running) return;
    running = true;
    current = fn()
      .then(() => undefined)
      .catch((e: unknown) => log(`${name} pass failed`, { error: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        running = false;
      });
  };
  pass();
  const timer = setInterval(pass, everyMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await current;
  };
}

export function startObserve(runtime: Pick<ServerRuntime, "serverId" | "docker" | "host" | "dial" | "mode">, deps: ObserveDeps): () => Promise<void> {
  const cfg = deps.config ?? loadObserveConfig();
  const log = deps.log ?? stderrLog;
  const { serverId } = runtime;
  const docker = deps.docker ?? createDockerReader(runtime.docker.target);
  const sampler = createSampler(deps.db, { serverId, docker, host: runtime.host }, log);
  // An install that sets no address for this probe has never had it run, and reads as no data.
  const ping = proxyPing(runtime.dial);
  const alerts = createAlertRunner(deps.db, { serverId, proxyUp: ping }, sampler.state, cfg);
  const logs = createLogCollector(deps.db, docker, deps.secretsFor ?? (async () => []), log);
  const probe = deps.reachProbe ?? proxyProbe({ dial: runtime.dial, tls: runtime.mode.ingress === "direct_tls" });
  const reach: ReachState = new Map();

  const stops = [
    loop("metrics", cfg.sampleMs, async () => {
      await sampler.tick();
      // App.status is what this tick saw. A listing older than two ticks is not trusted.
      await reconcileAppStatus(deps.db, serverId, sampler.state, { maxAgeMs: 2 * cfg.sampleMs })
        .catch((e: unknown) => log("app status pass failed", { error: e instanceof Error ? e.message : String(e) }));
      await logs.sync(sampler.state);
    }, log),
    loop("alerts", cfg.alertMs, () => alerts.tick(), log),
    // Status page apps through the proxy, as a visitor reaches them.
    loop("reachability", cfg.reach.everyMs, () => probeReachability(deps.db, serverId, probe, reach), log),
    // The control plane's own containers, for the server page's service list.
    loop("control plane", 60_000, () => recordControlPlane(deps.db, docker, AGENT_CONTAINER), log),
    loop("uptime", 60_000, () => recordUptimeMinute(deps.db, serverId, sampler.state, Date.now(), reach), log),
  ];
  return async () => {
    await Promise.all(stops.map((s) => s()));
    await logs.close();
  };
}

/** The passes over the database alone: they belong to no server, so one worker runs them once. */
export function startObserveMaintenance(deps: Pick<ObserveDeps, "db" | "config" | "log">): () => Promise<void> {
  const cfg = deps.config ?? loadObserveConfig();
  const log = deps.log ?? stderrLog;
  const stops = [
    loop("metrics rollup", 5 * 60_000, () => metricsMaintenance(deps.db, cfg), log),
    // The owner's Log retention setting, read each pass (logRetentionDays); the caps still apply.
    loop("log retention", 10 * 60_000, async () => {
      await pruneLogs(deps.db, await logRetentionDays(deps.db, cfg.logRetentionDays));
      await enforceLogCaps(deps.db, cfg.logCaps);
    }, log),
    // The size cap is checked more often than age: a flood fills a disk in minutes, not days.
    loop("log size cap", 60_000, () => enforceLogCaps(deps.db, cfg.logCaps), log),
    // AlertEvent is kept 90 days (the model comment); open events are never pruned.
    loop("alert retention", 3_600_000, () => deps.db.alertEvent.deleteMany({
      where: { state: "resolved", resolvedAt: { lt: new Date(Date.now() - 90 * 86_400_000) } },
    }), log),
  ];
  return async () => {
    await Promise.all(stops.map((s) => s()));
  };
}

export type ObserveJobHandler = (job: ClaimedJob, signal: AbortSignal) => Promise<void>;

/** Job handlers this module owns, keyed by kind. */
export function observeJobHandlers(deps: { db: Db; vault: SecretVault; publicUrl?: string | null; internalToken?: string | undefined; targets?: WebhookTargets; mail?: Mailer }): Partial<Record<JobKind, ObserveJobHandler>> {
  const publicUrl = deps.publicUrl ?? process.env.DOCKIFY_PUBLIC_URL ?? null;
  return {
    [ALERT_NOTIFY_KIND]: async (job: ClaimedJob) => {
      await deliverAlert({ db: deps.db, vault: deps.vault, publicUrl, internalToken: deps.internalToken, targets: deps.targets, mail: deps.mail }, job.payload);
    },
  };
}
