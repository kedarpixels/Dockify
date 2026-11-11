/** Claim loops over the jobs table, per server and global. The update lane is never claimed here: the updater owns it. */
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { jobs as J } from "@dockify/contracts";
import { createDb, defaultServerId, enqueue, tcpProbe, waitUntilReachable, type JobLane } from "@dockify/db";
import { guardProcess, jsonLogger } from "./boot.ts";
import { isNotFound } from "@dockify/engine";
import { DASHBOARD_JOB_KEY } from "./edge/dashboard.ts";
import { resyncRoutes } from "./edge/jobs.ts";
import { ensureSystemRoutes } from "./edge/routes.ts";
import { startPrimaryLink, type PrimaryLink } from "./link/primary.ts";
import { createRemoteRuntime, readAgentInfo } from "./link/remote.ts";
import type { ServerRuntime } from "./server/runtime.ts";
import { DeferJobError, isPermanentError } from "./errors.ts";
import { sweepCheckouts } from "./deploy/git.ts";
import { AliveFile, checkWorkFolder } from "./health.ts";
import { claim, complete, defer, fail, holdLease, release } from "./queue.ts";
import { createRemoteVault, jobContext, readApiUrl, readInternalToken } from "./vault.ts";
import { buildHandlers, startChannel, startGlobalTimers, startServerTimers, workerShared, type Wired, type WorkerShared } from "./wiring.ts";

export { PermanentJobError } from "./errors.ts";
export type { JobHandler } from "./wiring.ts";

const LEASE_MS = 60_000;
const IDLE_MS = 2_000;
/**
 * One claim loop per lane, so a long build holds up neither a backup nor a repository read. Maintenance has
 * a per-server loop and a global one, so a long prune does not hold up mail or DNS checks.
 */
const SERVER_LANES: JobLane[] = ["deploy", "data", "maintenance"];
const GLOBAL_LANES: JobLane[] = ["maintenance", "detect"];

const logger = jsonLogger();
guardProcess(logger);
const log = (msg: string, extra?: object): void => logger.warn(msg, extra);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const db = createDb();
// The compose healthcheck reads this file's age. From the first line of the event loop's life, so a
// worker still waiting for its database reads as starting, not as dead.
const alive = new AliveFile();
void alive.touch();
setInterval(() => void alive.touch(), 15_000).unref();
const stop = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => stop.abort());

let shared: WorkerShared;
try {
  // No master key here: every secret is opened by the api, per job, audited.
  const internalToken = readInternalToken();
  const vault = createRemoteVault({ apiUrl: readApiUrl(), token: internalToken });
  shared = workerShared({ db, vault, internalToken, logger, alive });
} catch (e) {
  logger.error(`worker cannot start: ${message(e)}`);
  process.exit(1);
}
const workerId = `${hostname()}:${process.pid}`;

/** The database was gone at the moment a result had to be written: the lease lapses and the job comes back. */
const unrecorded = (jobId: string) => (e: unknown) => log("could not record a job's result", { jobId, error: message(e) });

async function runLane(handlers: Wired["handlers"], lane: JobLane, serverId: string | null, server: PrimaryLink | null): Promise<void> {
  while (!stop.signal.aborted) {
    // A server with no link claims nothing: its jobs wait, with no attempt spent.
    if (server && !server.link.up) {
      await sleep(IDLE_MS, undefined, { signal: stop.signal }).catch(() => {});
      continue;
    }
    const job = await claim(db, lane, LEASE_MS, workerId, serverId).catch(() => null);
    if (!job) {
      await sleep(IDLE_MS, undefined, { signal: stop.signal }).catch(() => {});
      continue;
    }
    const handler = handlers[job.kind];
    if (!handler) {
      await fail(db, job, `No handler for job kind ${job.kind} in this worker version`, true).catch(unrecorded(job.id));
      continue;
    }
    const lease = holdLease(db, job.id, workerId, LEASE_MS, log);
    try {
      // The job rides along with every secrets call, so the api can check it is live and audit it.
      await jobContext.run({ jobId: job.id, purpose: job.kind }, () => handler(job, AbortSignal.any([stop.signal, lease.signal])));
      if (!lease.signal.aborted) await complete(db, job.id);
    } catch (e) {
      // A lost lease writes nothing: the row is no longer this worker's. A shutdown mid-job gives the
      // claim back instead of spending the attempt.
      if (lease.signal.aborted) log("a job stopped after losing its lease", { jobId: job.id });
      else if (stop.signal.aborted) await release(db, job.id).catch(() => {});
      else if (e instanceof DeferJobError) await defer(db, job.id, e.message, e.delayMs).catch(unrecorded(job.id));
      else await fail(db, job, e instanceof Error ? e.message : String(e), isPermanentError(e)).catch(unrecorded(job.id));
    } finally {
      lease.stop();
    }
  }
}

/** Every loop of one server. The cron lane has as many loops as runs one server may have going at once. */
const serverLoops = (handlers: Wired["handlers"], serverId: string, server: PrimaryLink): Array<Promise<void>> => [
  ...SERVER_LANES.map((lane) => runLane(handlers, lane, serverId, server)),
  ...Array.from({ length: J.JOB_MAX_CONCURRENT_RUNS }, () => runLane(handlers, "cron", serverId, server)),
];

async function start(): Promise<{ runtime: ServerRuntime; wired: Wired; primary: PrimaryLink } | null> {
  // After a reboot the database comes up in any order with the rest; wait quietly.
  const url = process.env.DATABASE_URL;
  const dbUp = await waitUntilReachable("the database", async () => {
    if (url) await tcpProbe(url)();
    await db.$queryRaw`SELECT 1`;
  }, { log: logger, signal: stop.signal });
  if (!dbUp) return null;
  // The migrate service made this row. A worker that came up before it finished waits with the rest.
  let primaryId: string | null = null;
  await waitUntilReachable("the primary server row", async () => {
    primaryId = await defaultServerId(db);
  }, { log: logger, signal: stop.signal });
  if (!primaryId) return null;

  // The dashboard's routers and the shared middleware are written before anything else can fail. Traefik
  // keeps serving the files it has until then.
  const primary = await startPrimaryLink({ db, serverId: primaryId, env: process.env, health: shared.health, log });
  let cores = 0;
  const agentUp = await waitUntilReachable("this server's agent", async () => {
    await primary.link.whenUp(stop.signal);
    cores = (await readAgentInfo(primary.link)).cores;
  }, { log: logger, signal: stop.signal });
  if (!agentUp) {
    await primary.stop();
    return null;
  }
  const runtime = createRemoteRuntime({ link: primary.link, mode: shared.edge.mode, cpuCores: cores, maxContextBytes: shared.deployConfig.maxRepoBytes });
  const wired = buildHandlers(runtime, shared);
  try {
    await ensureSystemRoutes(runtime.routes, runtime.mode, shared.edge.dashboardHost);
  } catch (e) {
    logger.error(`could not write the system routes: ${message(e)}`);
  }

  // Docker. A read every socket proxy allowlist has allowed, older ones included: found or not found, the
  // daemon answered. Anything else (no proxy yet, a refusal) is waited out.
  const deployNetwork = process.env.DOCKIFY_DEPLOY_NETWORK?.trim() || "dockify-deploy";
  const dockerUp = await waitUntilReachable("Docker", () => runtime.docker.call("GET", `/networks/${encodeURIComponent(deployNetwork)}`).catch((e: unknown) => {
    if (!isNotFound(e)) throw e;
  }), { log: logger, signal: stop.signal });
  if (!dockerUp) {
    await primary.stop();
    return null;
  }

  // Every route is resynced before any job runs: a reboot gave the containers new addresses.
  try {
    const r = await resyncRoutes(wired.edgeDeps, log);
    logger.info("routes resynced", r);
  } catch (e) {
    logger.error(`could not resync the routes: ${message(e)}`);
  }
  // Fresh DNS verdicts, through the usual job, so a domain whose record changed while the worker
  // was down gets or loses its router soon.
  await enqueue(db, { kind: "dns_check", lane: "maintenance", payload: {}, dedupeKey: "dns_check:all" }).catch(() => {});
  // The addresses the dashboard left and a domain being set up: their routes, soon after a change of
  // address has recreated this worker.
  await enqueue(db, { kind: "dashboard_domain", lane: "maintenance", payload: {}, dedupeKey: DASHBOARD_JOB_KEY }).catch(() => {});

  // A work folder problem is reported with the heartbeat and refuses only the jobs that stage files there
  // (health.ts), so the worker starts either way.
  const swept = await sweepCheckouts(shared.deployConfig.buildRoot);
  if (swept) log("removed checkouts a crash left behind", { checkouts: swept });
  await checkWorkFolder({ health: shared.health, dir: wired.data.tmpDir, log: logger });
  return { runtime, wired, primary };
}

let started: Awaited<ReturnType<typeof start>>;
try {
  started = await start();
} catch (e) {
  logger.error(`worker cannot start: ${message(e)}`);
  process.exit(1);
}
if (started) {
  const { runtime, wired, primary } = started;
  const live = { ...shared, ...wired };
  const timers = [await startGlobalTimers(shared, log), startServerTimers(runtime, live, log), startChannel(runtime, live, log)];
  await Promise.all([...serverLoops(wired.handlers, runtime.serverId, primary), ...GLOBAL_LANES.map((lane) => runLane(wired.handlers, lane, null, null))]);
  for (const t of timers) await t.stop();
  await primary.stop();
}
await db.$disconnect();
