/**
 * Every kind of container the worker makes, built by the code that really builds it, against the agent's
 * gate. A field added to any of these that the gate does not know fails here, not in a customer's deploy.
 */
import { containerSpec, DockerClient } from "@dockify/engine";
import { createServer as httpServer, type Server } from "node:http";
import { createServer as netServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkCreateBody, createDockerGate, ruleFor, type DockerGate } from "../../../agent/src/docker-gate.ts";
import { refuseCollidingNames, validateRouteFile } from "../../../agent/src/routes.ts";
import { EngineDataPort } from "../data/engine-port.ts";
import { API_UPSTREAM, WEB_UPSTREAM, type EdgeMode } from "../edge/ingress.ts";
import { DASHBOARD_FILE, DASHBOARD_NEXT_FILE, DASHBOARD_OLD_FILE, EDGE_FILE, renderAsleepRouteFile, renderDashboardNext, renderDashboardOld, renderDashboardRoute, renderEdgeFile, renderRouteFile, routeFileName } from "../edge/routes.ts";
import { START_EVENTS_PATH } from "../edge/starts.ts";
import { createDockerReader } from "../observe/docker.ts";
import { EngineTerminalPort } from "../terminal/engine.ts";
import { appContainerInput, jobRunName, parkedName, releaseName, type RunnableApp } from "../deploy/containers.ts";
import { previewReleaseInput } from "../deploy/preview.ts";
import { restoreTestContainer, restoreTestVolume } from "../data/leftovers.ts";
import { HELPER_NETWORK, serviceSpec, volumeNameFor } from "../data/services.ts";

const APP = "0f0e0d0c-0000-4000-8000-0000000000aa";
const ENV = "0f0e0d0c-0000-4000-8000-0000000000bb";
const app: RunnableApp = {
  id: APP, kind: "backend", environmentId: ENV, projectId: "p", port: 3000, startCommand: "node server.js", memoryLimitMb: null, cpuLimit: null, pidsLimit: null,
  capAdd: ["NET_ADMIN"], sysctls: { "net.ipv4.ip_unprivileged_port_start": "0" }, volumes: [{ id: "v", name: "dk-0f0e0d0c-data", mountPath: "/data" }],
};
const createUrl = (name: string) => `/v1.43/containers/create?name=${encodeURIComponent(name)}`;

describe("the bodies the worker really sends pass the gate", () => {
  it.each([
    ["an app", `dk-${APP}`, () => appContainerInput(app, { name: `dk-${APP}`, imageId: `sha256:${"a".repeat(64)}`, env: { A: "1" }, deploymentId: "d", role: "app" })],
    ["a release command", releaseName(APP, "deadbeef-0000"), () => appContainerInput(app, { name: releaseName(APP, "deadbeef-0000"), imageId: `sha256:${"a".repeat(64)}`, env: { A: "1" }, deploymentId: "d", role: "release", cmd: "npm run migrate" })],
    ["a scheduled job", jobRunName(APP, "run-1"), () => appContainerInput(app, { name: jobRunName(APP, "run-1"), imageId: `sha256:${"a".repeat(64)}`, env: {}, deploymentId: "d", role: "job", cmd: "npm run job" })],
  ])("%s", (_label, name, input) => {
    const body = containerSpec({ ...input(), name }, 4);
    expect(() => ruleFor("POST", createUrl(name))).not.toThrow();
    expect(() => checkCreateBody(JSON.parse(JSON.stringify(body)))).not.toThrow();
  });

  it("a parked name stays inside the rename rule", () => {
    expect(() => ruleFor("POST", `/v1.43/containers/dk-${APP}/rename?name=${parkedName(APP)}`)).not.toThrow();
  });

  it("a managed database on its volume, with a healthcheck, and a helper on the helper network", () => {
    const svc = { id: APP, kind: "postgres", name: "db", environmentId: ENV, projectId: "p", version: null, image: null, memoryLimitMb: null, cpuLimit: null, pidsLimit: null } as never;
    const creds = { user: "u", password: "p", database: "d" } as never;
    const main = serviceSpec(svc, creds, { image: `sha256:${"a".repeat(64)}`, volume: volumeNameFor(APP) } as never, 4);
    expect(() => checkCreateBody(JSON.parse(JSON.stringify(main)))).not.toThrow();
    const helper = containerSpec({ name: restoreTestContainer("b"), image: `sha256:${"a".repeat(64)}`, network: HELPER_NETWORK, cmd: ["sleep", "300"], restart: "no", memoryMb: 64, pidsLimit: 32, readOnlyRootfs: true, volumes: [{ name: restoreTestVolume("b"), mountPath: "/check", readOnly: true }, { name: "a".repeat(64), mountPath: "/from", readOnly: true }] }, 4);
    expect(() => checkCreateBody(JSON.parse(JSON.stringify(helper)))).not.toThrow();
    expect(() => ruleFor("POST", createUrl(restoreTestContainer("b")))).not.toThrow();
  });

  it("a preview's release command, on the forks' network", () => {
    const body = containerSpec({ ...previewReleaseInput({ pdId: "pd", appId: APP, envId: "e", projectId: "p", prNumber: 1, hostname: "pr-1.example.com", fromFork: true, isolatedDb: false, network: "dockify-pv-forks", limits: { cpu: 1, memoryMb: 256, pids: 256 } } as never, { name: `dk-${APP}-release-1`, command: "x", imageId: `sha256:${"a".repeat(64)}`, env: {}, deploymentId: "d" }) }, 4);
    expect(() => checkCreateBody(JSON.parse(JSON.stringify(body)))).not.toThrow();
  });
});

/**
 * Every call the worker's own code makes, on the wire, through the real gate. A gate that is too strict
 * breaks every deploy, and it would break it here first. The far side answers as Docker does.
 */
describe("every call the worker's clients really make gets through the gate", () => {
  const ID = "a".repeat(64);
  const IMAGE = `sha256:${"c".repeat(64)}`;
  const TAG = `dockify/app-${APP}:deadbeef`;
  let docker: Server;
  let gate: DockerGate;
  let front: NetServer;
  let client: DockerClient;
  const seen: Array<{ line: string; type: string | undefined; body: string }> = [];

  beforeAll(async () => {
    docker = httpServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c: string) => (body += c));
      req.on("end", () => {
        const url = req.url ?? "";
        if (!/\/containers\/[^/]+\/json/.test(url)) seen.push({ line: `${req.method} ${url}`, type: req.headers["content-type"], body });
        res.setHeader("content-type", "application/json");
        if (/\/containers\/[^/]+\/json/.test(url)) return void res.end(JSON.stringify({ Id: ID, Name: "/dk-a", State: { Running: true }, Config: { Labels: { "dockify.managed": "true" } }, NetworkSettings: { Networks: {} } }));
        if (/\/networks\/[^/?]+$/.test(url) && req.method === "GET") return void (url.includes("missing") ? (res.statusCode = 404, res.end('{"message":"no"}')) : res.end('{"Name":"x"}'));
        if (url.includes("/containers/create") || /\/exec$/.test(url)) return void res.end(JSON.stringify({ Id: ID }));
        if (/\/wait/.test(url)) return void res.end('{"StatusCode":0}');
        if (/\/exec\/[^/]+\/json/.test(url)) return void res.end('{"Running":false,"ExitCode":0}');
        if (/\/images\/[^/]+\/json/.test(url)) return void res.end(JSON.stringify({ Id: IMAGE, RepoTags: [], RepoDigests: [], Size: 1, Created: "" }));
        if (req.method === "DELETE" || /\/(?:start|stop|kill|rename|connect|disconnect|resize)(?:\?|$)/.test(url)) {
          res.statusCode = 204;
          return void res.end();
        }
        if (url.includes("/system/df")) return void res.end("{}");
        if (url.includes("/volumes/create")) return void res.end("{}");
        if (url.includes("/images/create")) return void res.end('{"status":"ok"}\n');
        res.end("[]");
      });
    });
    docker.on("upgrade", (req, sock: Socket, head) => {
      seen.push({ line: `UPGRADE ${req.method} ${req.url}`, type: req.headers["content-type"], body: head.toString("utf8") });
      sock.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
      sock.on("error", () => {});
      setTimeout(() => sock.end(), 20);
    });
    await new Promise<void>((r) => docker.listen(0, "127.0.0.1", r));
    gate = createDockerGate({ host: "127.0.0.1", port: (docker.address() as AddressInfo).port });
    front = netServer((s) => gate.handle(s));
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
    client = new DockerClient({ host: "127.0.0.1", port: (front.address() as AddressInfo).port }, { cpuCores: 4 });
  });
  afterAll(() => {
    gate.close();
    front.close();
    docker.closeAllConnections();
    docker.close();
  });

  const abort = () => AbortSignal.timeout(5_000);
  const net = "dockify-env-acme";
  it.each<[string, () => Promise<unknown>]>([
    ["inspect", () => client.inspectContainer("dk-a")],
    ["inspect by id", () => client.inspectContainer(ID)],
    ["list", () => client.listContainers({ "dockify.managed": "true" })],
    ["create", () => client.createContainer(`dk-${APP}`, appContainerInput(app, { name: `dk-${APP}`, imageId: IMAGE, env: { A: "1" }, deploymentId: "d", role: "app" }))],
    ["create, read-only with a tmpfs", () => client.createContainer("dk-a", { name: "dk-a", image: IMAGE, network: net, readOnlyRootfs: true, restart: "on-failure", healthcheck: { test: ["CMD", "true"], intervalSeconds: 5, timeoutSeconds: 2, retries: 3, startSeconds: 1 } })],
    ["start", () => client.startContainer("dk-a")],
    ["stop", () => client.stopContainer("dk-a", 20)],
    ["remove", () => client.removeContainer("dk-a")],
    ["remove with volumes", () => client.removeContainer("dk-a", { volumes: true })],
    ["rename", () => client.renameContainer(`dk-${APP}`, parkedName(APP))],
    ["wait", () => client.waitContainer("dk-a", abort())],
    ["logs", () => client.logs("dk-a", false)],
    ["inspect an image", () => client.inspectImage("ghcr.io/acme/web:1")],
    ["list images", () => client.listImages({ "dockify.managed": "true" }, true)],
    ["remove an image by id", () => client.removeImage(IMAGE)],
    ["remove an image by a build's tag", () => client.removeImage(TAG)],
    ["disk usage", () => client.diskUsage(["image", "volume"])],
    ["pull", () => client.pullImage("ghcr.io/acme/web:1", null, () => {}, abort())],
    ["pull with a registry's credential", () => client.pullImage("ghcr.io/acme/web:1", "c2VjcmV0", () => {}, abort())],
    ["network exists", () => client.ensureNetwork(net, {})],
    ["network made", () => client.ensureNetwork("dockify-env-missing", { "dockify.environment": "e" }, { internal: true })],
    ["connect", () => client.connectNetwork(net, "dk-a")],
    ["connect the proxy", () => client.connectNetwork(net, "dockify-proxy")],
    ["disconnect the agent, in a sweep", () => client.disconnectNetwork(net, "dockify-agent")],
    ["sweep's list of environment networks", () => client.listEnvNetworks()],
    ["sweep's list of preview networks", () => client.listPreviewNetworks()],
    ["remove a network", () => client.removeNetwork(`dockify-env-${APP}`)],
    ["volume", () => client.ensureVolume("dk-a-data", { "dockify.managed": "true" })],
    ["remove a volume", () => client.removeVolume("dk-a-data")],
    ["remove an anonymous volume", () => client.removeVolume(ID)],
    ["start events", async () => (await client.raw("GET", START_EVENTS_PATH)).resume()],
    ["the data module's exec, attached", async () => {
      const h = await new EngineDataPort(client).exec("dk-a", { cmd: ["pg_dump"], env: { PGPASSWORD: "x" }, user: "postgres" });
      await h.done;
    }],
    ["the data module's attach", async () => {
      const h = await new EngineDataPort(client).attach("dockify-rt-b1", { stdin: true });
      await h.done;
    }],
    ["the data module's kill", () => client.call("POST", "/containers/dk-a/kill", undefined, true)],
    ["the terminal's exec, with a size", () => new EngineTerminalPort(client).createExec("dk-a", { AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true, Cmd: ["/bin/sh"], Env: ["TERM=xterm"], ConsoleSize: [40, 120] })],
    ["the terminal's detached start", () => new EngineTerminalPort(client).startDetached(ID)],
    ["the terminal's attached start", () => new EngineTerminalPort(client).attachExec(ID)],
    ["the terminal's resize", () => new EngineTerminalPort(client).resizeExec(ID, 120, 40)],
    ["the observer's list", () => createDockerReader(client.target).listManaged()],
    ["the observer's filtered list", () => createDockerReader(client.target).listFiltered({ name: ["dockify-"] })],
    ["the observer's inspect", () => createDockerReader(client.target).inspect(ID)],
    ["the observer's one-shot stats", () => createDockerReader(client.target).stats(ID)],
    ["the observer's log follow", async () => (await createDockerReader(client.target).followLogs(ID, 1_700_000_000, abort())).resume()],
  ])("%s", async (_label, call) => {
    await expect(call()).resolves.not.toThrow();
  });

  it("a body reaches Docker as JSON, a call without one as nothing", async () => {
    seen.length = 0;
    await client.connectNetwork(net, "dk-a");
    expect(seen.at(-1)).toEqual({ line: `POST /v1.43/networks/${net}/connect`, type: "application/json", body: '{"Container":"dk-a"}' });
    await client.startContainer("dk-a");
    expect(seen.at(-1)).toEqual({ line: "POST /v1.43/containers/dk-a/start", type: undefined, body: "" });
  });

  it("the tunnels carry their canonical bodies", async () => {
    seen.length = 0;
    await new EngineTerminalPort(client).attachExec(ID);
    expect(seen.at(-1)).toMatchObject({ line: `UPGRADE POST /v1.43/exec/${ID}/start`, type: "application/json" });
  });
});

/** The other half of a too-strict gate: a route file the worker renders must come back from the agent unchanged. */
describe("every route file the worker renders passes the agent's check, byte for byte", () => {
  const rules = { upstreams: [API_UPSTREAM, WEB_UPSTREAM], heldAddresses: new Set(["172.18.0.5"]) };
  const DIRECT: EdgeMode = { ingress: "direct_tls", certResolver: "le" };
  const TUNNEL: EdgeMode = { ingress: "cloudflare_tunnel" };
  const hosts = ["a.example.com", "b.example.com"];
  const reserved = new Set<string>();
  const files = (mode: EdgeMode): Record<string, string> => ({
    [routeFileName(APP)]: renderRouteFile({ id: APP, port: 3000, hosts }, "dk-route-1", mode, reserved)!,
    [routeFileName("pinned")]: renderRouteFile({ id: "pinned", port: 3000, hosts: ["c.example.com"] }, "172.18.0.5", mode, reserved)!,
    [routeFileName("pv-1")]: renderRouteFile({ id: "pv-1", port: 3000, hosts: ["pv.example.com"], gateId: "pv-1" }, "dk-pv-1", mode, reserved)!,
    [routeFileName("pv-2")]: renderRouteFile({ id: "pv-2", port: 3000, hosts: ["x.pv.example.com"], gateId: "pv-2", wildcard: { domain: "pv.example.com", certResolver: "ledns" } }, "dk-pv-2", mode, reserved)!,
    [routeFileName("pv-3")]: renderAsleepRouteFile({ id: "pv-3", port: 3000, hosts: ["asleep.example.com"] }, mode, reserved)!,
    [DASHBOARD_NEXT_FILE]: renderDashboardNext("next.example.com", mode),
    [DASHBOARD_OLD_FILE]: renderDashboardOld(["old.example.com", "older.example.com"], "dash.example.com", mode)!,
    ...(mode.ingress === "direct_tls" ? { [EDGE_FILE]: renderEdgeFile(), [DASHBOARD_FILE]: renderDashboardRoute("dash.example.com", mode.certResolver) } : {}),
  });

  it.each([["direct", DIRECT], ["tunnel", TUNNEL]] as const)("in %s mode", (_label, mode) => {
    const all = files(mode);
    for (const [name, text] of Object.entries(all)) expect(validateRouteFile(text, rules, name), name).toBe(text);
    // All of them in one folder: no two may hold one name.
    expect(() => refuseCollidingNames(all, {}, [])).not.toThrow();
  });
});
