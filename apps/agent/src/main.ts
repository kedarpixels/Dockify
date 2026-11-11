/**
 * The agent, one per server: it dials the control plane and answers narrow calls through docker-gate.ts. It
 * holds no database password, master key or internal token, and reaches Docker only through the socket proxy.
 */
import { createDialer, DockerClient, fileRouteStore, parseDockerHost } from "@dockify/engine";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { link as L, runningVersion } from "@dockify/contracts";
import { createAgentApi, sweepBuildRoot } from "./api.ts";
import { createDockerGate } from "./docker-gate.ts";
import { pinOf, runLink } from "./link.ts";
import { tenantAddresses } from "./routes.ts";

const env = process.env;
const log = (msg: string, extra?: object): void => {
  process.stderr.write(`${JSON.stringify({ level: "warn", time: new Date().toISOString(), msg, ...extra })}\n`);
};
const need = (name: string): string => {
  const v = env[name]?.trim();
  if (!v) {
    log(`the agent cannot start: ${name} is not set`);
    process.exit(1);
  }
  return v;
};
const opt = (name: string): string | null => env[name]?.trim() || null;

/** How the compose healthcheck knows the event loop runs. */
const ALIVE_FILE = "/tmp/dockify-agent-alive";
const SELF = opt("DOCKIFY_AGENT_CONTAINER") ?? "dockify-agent";
/** Dates are never checked on the link. A hundred years only keeps tools that look at them quiet. */
const CERT_DAYS = "36500";

/** A private key made here, on first start, and never sent anywhere. */
async function ensureKey(dir: string): Promise<{ key: Buffer; cert: Buffer }> {
  const keyPath = join(dir, "agent.key");
  const certPath = join(dir, "agent.crt");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    await rm(keyPath, { force: true });
    await rm(certPath, { force: true });
    await new Promise<void>((resolve, reject) =>
      execFile("openssl", ["req", "-x509", "-newkey", "ed25519", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", CERT_DAYS, "-subj", "/CN=dockify-agent"], { timeout: 60_000 }, (e) => (e ? reject(e) : resolve())),
    );
    await chmod(keyPath, 0o600);
  }
  return { key: await readFile(keyPath), cert: await readFile(certPath) };
}

/** Leaves the tenant networks it joined for a dial before it last stopped. */
async function leaveLeftovers(docker: DockerClient): Promise<void> {
  const self = await docker.inspectContainer(SELF).catch(() => null);
  for (const network of Object.keys(self?.NetworkSettings.Networks ?? {})) {
    if (/^dockify-(?:env-|pv-|helpers)/.test(network)) await docker.disconnectNetwork(network, SELF).catch(() => {});
  }
}

const keyDir = need("DOCKIFY_AGENT_KEY_DIR");
const buildRoot = need("DOCKIFY_BUILD_ROOT");
const workerCert = await readFile(need("DOCKIFY_LINK_CERT_FILE"));
const joinTokenFile = opt("DOCKIFY_JOIN_TOKEN_FILE");

const { key, cert } = await ensureKey(keyDir);
log("agent identity", { pin: pinOf(cert) });

const docker = new DockerClient(parseDockerHost(need("DOCKER_HOST")), { cpuCores: null });
const proxyPort = /^tcp:\/\/([0-9.]+):(\d+)$/.exec(need("DOCKER_HOST"));
if (!proxyPort) {
  log("the agent cannot start: DOCKER_HOST must be tcp://address:port, the socket proxy");
  process.exit(1);
}
await sweepBuildRoot(buildRoot);
await leaveLeftovers(docker);

const gate = createDockerGate({ host: proxyPort[1]!, port: Number(proxyPort[2]) });
const ingress = opt("DOCKIFY_INGRESS") === "direct_tls" ? "direct_tls" : "cloudflare_tunnel";
const onStream = createAgentApi({
  gate,
  dial: createDialer({ docker, selfContainer: SELF, onlyManaged: true }),
  routes: fileRouteStore(need("DOCKIFY_PROXY_DIR")),
  routeRules: { upstreams: (opt("DOCKIFY_EDGE_UPSTREAMS") ?? "").split(",").map((s) => s.trim()).filter(Boolean) },
  heldAddresses: async () => tenantAddresses(await docker.listContainers({ "dockify.managed": "true" })),
  diskPath: opt("DOCKIFY_METRICS_DISK_PATH") ?? "/",
  buildRoot,
  maxContextBytes: Number(opt("DOCKIFY_MAX_REPO_BYTES")) || L.LINK_LIMITS.contextBytesDefault,
  build: { docker, buildkitAddr: opt("BUILDKIT_HOST") ?? "unix:///run/buildkit/buildkitd.sock" },
  facts: {
    version: runningVersion(),
    hostname: opt("DOCKIFY_HOST_NAME") ?? "",
    publicIpv4: opt("DOCKIFY_SERVER_IPV4"),
    publicIpv6: opt("DOCKIFY_SERVER_IPV6"),
    dockerVersion: opt("DOCKIFY_DOCKER_VERSION"),
    os: opt("DOCKIFY_HOST_OS"),
    ingress,
  },
});

let tokenSpent = false;
const link = runLink({
  url: need("DOCKIFY_LINK_URL"),
  key,
  cert,
  workerPin: pinOf(workerCert),
  // Offered once per process. Nothing about it is kept on disk: a factory reset forgets this key, and
  // then the next connection, which the worker never speaks HTTP/2 on, offers the token again.
  joinToken: async () => {
    if (!joinTokenFile || tokenSpent) return null;
    return (await readFile(joinTokenFile, "utf8")).trim() || null;
  },
  onJoined: async () => {
    tokenSpent = true;
  },
  onUnknown: () => {
    tokenSpent = false;
  },
  onStream,
  log,
});

await writeFile(ALIVE_FILE, "");
const beat = setInterval(() => void utimes(ALIVE_FILE, new Date(), new Date()).catch(() => writeFile(ALIVE_FILE, "").catch(() => {})), 15_000);
beat.unref();

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void link.stop().then(() => {
      gate.close();
      process.exit(0);
    });
  });
}
