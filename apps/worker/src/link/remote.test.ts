/**
 * The worker's ServerRuntime against a real agent, on real sockets: the same modules a deploy uses,
 * with only Docker and BuildKit faked on the far side. Whatever the worker can write as a route must
 * pass the agent's check, so this renders every kind of file the worker makes.
 */
import { fileRouteStore, PermanentDeployError, type BuildInput, type BuildVar } from "@dockify/engine";
import { X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { connect as netConnect, createServer as netServer, type AddressInfo, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { Redactor } from "@dockify/redact";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDialer } from "@dockify/engine";
import { createAgentApi } from "../../../agent/src/api.ts";
import { createDockerGate } from "../../../agent/src/docker-gate.ts";
import { runLink, type LinkHandle } from "../../../agent/src/link.ts";
import { LINK_KEYS } from "../../../../packages/engine/src/link-keys.fixture.ts";
import { ensureSystemRoutes, writeAsleepRoute, writeDashboardFiles, writeRoute } from "../edge/routes.ts";
import { API_UPSTREAM, WEB_UPSTREAM, type EdgeMode } from "../edge/ingress.ts";
import type { ServerRuntime } from "../server/runtime.ts";
import { requestOver } from "../server/http-over.ts";
import { connectPg } from "../data/pg-session.ts";
import { connectRedis } from "../data/resp.ts";
import { createLinkListener, type LinkListener } from "./listener.ts";
import { createRemoteRuntime, readAgentInfo } from "./remote.ts";
import { ServerLink } from "./session.ts";

const pin = (cert: string) => new X509Certificate(cert).fingerprint256;
const SERVER = "11111111-1111-4111-8111-111111111111";
const DIRECT: EdgeMode = { ingress: "direct_tls", certResolver: "le" };
const TUNNEL: EdgeMode = { ingress: "cloudflare_tunnel" };
const reserved = new Set<string>();
/** The address a swap pins a route to, for a container made before route aliases. A tenant holds it here. */
const HELD_ADDRESS = "172.18.0.5";

describe("a server runtime over the link", () => {
  let dir: string;
  let docker: Server;
  let echo: NetServer;
  let listener: LinkListener;
  let handle: LinkHandle;
  let runtime: ServerRuntime;
  let link: ServerLink;
  let gateClose: () => void;
  const builds: Array<{ input: BuildInput; files: string[]; dockerfile: string | null }> = [];
  let joined: string[] = [];
  let dialPort = 0;
  let left: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "dk-remote-"));
    docker = createServer((req, res) => {
      req.resume();
      res.setHeader("content-type", "application/json");
      const m = /\/containers\/([^/?]+)\/json/.exec(req.url ?? "");
      if (m) return void res.end(JSON.stringify({ Id: "a".repeat(64), Name: "/dk-a", Config: { Labels: { "dockify.managed": "true", "dockify.app": "x" } }, State: { Running: true }, NetworkSettings: { Networks: { "dockify-env-a": { IPAddress: "127.0.0.1" } } } }));
      res.end("[]");
    });
    await new Promise<void>((r) => docker.listen(0, "127.0.0.1", r));
    // What stands in for a tenant: answers HTTP, and echoes for a plain connect.
    echo = netServer((s) => {
      s.on("error", () => {});
      s.once("data", (d: Buffer) => {
        if (d.toString().startsWith("GET")) {
          const host = /host: ([^\r\n]+)/i.exec(d.toString())?.[1] ?? "";
          const body = `hello from ${host}`;
          s.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
        } else s.write(Buffer.concat([Buffer.from("echo:"), d]));
      });
    });
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    const echoPort = (echo.address() as AddressInfo).port;

    const gate = createDockerGate({ host: "127.0.0.1", port: (docker.address() as AddressInfo).port });
    gateClose = () => gate.close();
    const fakeDocker = {
      inspectContainer: async (_id: string) => ({ NetworkSettings: { Networks: { "dockify-env-a": { IPAddress: "127.0.0.1" } } } }) as never,
      connectNetwork: async (n: string) => void joined.push(n),
      disconnectNetwork: async (n: string) => void left.push(n),
    };
    const onStream = createAgentApi({
      gate,
      // Every target lands on the stand-in: this test is about the stream, not the name.
      dial: createDialer({ docker: fakeDocker, selfContainer: "dockify-agent", connect: () => netConnect({ host: "127.0.0.1", port: dialPort || echoPort }), leaveAfterMs: 0 }),
      routes: fileRouteStore(join(dir, "proxy")),
      routeRules: { upstreams: [API_UPSTREAM, WEB_UPSTREAM] },
      heldAddresses: async () => new Set([HELD_ADDRESS]),
      diskPath: dir,
      buildRoot: join(dir, "agent-builds"),
      build: { docker: { loadImage: async () => {}, inspectImage: async () => { throw new Error("unused"); } }, buildkitAddr: "unix:///fake" },
      facts: { version: "1.2.3", hostname: "box", publicIpv4: "203.0.113.5", publicIpv6: null, dockerVersion: "28.3", os: "Ubuntu 24.04", ingress: "direct_tls" },
      buildctl: async (args) => JSON.stringify(args),
      buildImage: async (_server, input, log) => {
        const walk = async (d: string, base = ""): Promise<string[]> => (await readdir(d, { withFileTypes: true })).flatMap((e) => [`${base}${e.name}${e.isDirectory() ? "/" : ""}`]);
        const dockerfile = await readFile(join(input.checkoutDir, input.rootDir, "Dockerfile"), "utf8").catch(() => null);
        builds.push({ input, files: await walk(input.checkoutDir), dockerfile });
        log.redactor.conceal(input.vars.filter((v) => v.isSecret).map((v) => v.value));
        log.system("building");
        const stored = log.add("stderr", `step one, secret is ${input.vars[0]?.value ?? ""}`);
        if (input.appId === "fails") throw new PermanentDeployError(`Build failed at Dockerfile line 3: ${stored}`);
        if (input.appId === "flaky") throw new Error("BuildKit went away");
        return { imageId: `sha256:${"b".repeat(64)}`, imageRef: "dockify/app:1", port: 3000 };
      },
      runPlanStep: async (_addr, input, onLine) => {
        onLine("reading");
        return { planJson: "{}", framework: "Next", provider: "node", installCommand: "i", buildCommand: "b", startCommand: await readFile(join(input.checkoutDir, "start.txt"), "utf8"), staticSite: false, warnings: [], contextDir: "/secret/ctx", planDir: "/secret/plan" };
      },
    });
    link = new ServerLink(SERVER);
    listener = createLinkListener({
      ...LINK_KEYS.cp,
      serverByPin: async (p) => (p === pin(LINK_KEYS.agent.cert) ? { id: SERVER, state: "active" } : null),
      enroll: async () => false,
      existing: () => link.peek(),
      onSession: (s) => link.attach(s),
      log: () => {},
    });
    await listener.listen(0, "127.0.0.1");
    handle = runLink({
      url: `ws://127.0.0.1:${(listener.server.address() as AddressInfo).port}/link`,
      ...LINK_KEYS.agent,
      workerPin: pin(LINK_KEYS.cp.cert),
      joinToken: async () => null,
      onJoined: async () => {},
      onStream,
      log: () => {},
    });
    await link.whenUp();
    const info = await readAgentInfo(link);
    runtime = createRemoteRuntime({ link, mode: DIRECT, cpuCores: info.cores });
  }, 30_000);

  afterAll(async () => {
    await handle.stop();
    gateClose();
    await listener.close();
    docker.closeAllConnections();
    docker.close();
    echo.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("reads the server's facts with a schema", async () => {
    const info = await readAgentInfo(link);
    expect(info).toMatchObject({ version: "1.2.3", hostname: "box", publicIpv4: "203.0.113.5", ingress: "direct_tls" });
  });

  it("reads the host", async () => {
    const h = await runtime.host();
    expect(h.memTotalBytes).toBeGreaterThan(0);
    expect(h.disk === null || h.disk.totalBytes > 0).toBe(true);
  });

  describe("routes", () => {
    const app = { id: "0f0e0d0c-0000-4000-8000-0000000000aa", port: 3000, hosts: ["a.example.com"] };
    it.each([["direct", DIRECT], ["tunnel", TUNNEL]] as const)("every file the worker writes, in %s mode, passes the agent's check", async (_label, mode) => {
      expect(await writeRoute(runtime.routes, app, "dk-route-1", mode, reserved)).toBe("written");
      // The agent writes its own text of a file, and it must read as this side rendered it, or Traefik reloads on every pass.
      expect(await writeRoute(runtime.routes, app, "dk-route-1", mode, reserved)).toBe("unchanged");
      await writeRoute(runtime.routes, { ...app, id: "pv-1", hosts: ["pv.example.com"], gateId: "pv-1" }, "dk-pv-1", mode, reserved);
      await writeRoute(runtime.routes, { ...app, id: "pv-2", hosts: ["x.pv.example.com"], gateId: "pv-2", wildcard: { domain: "pv.example.com", certResolver: "ledns" } }, "dk-pv-2", mode, reserved);
      await writeAsleepRoute(runtime.routes, { ...app, id: "pv-3", hosts: ["asleep.example.com"] }, mode, reserved);
      await writeRoute(runtime.routes, { ...app, id: "legacy", hosts: ["old.example.com"] }, HELD_ADDRESS, mode, reserved);
      await ensureSystemRoutes(runtime.routes, mode, "dash.example.com");
      await writeDashboardFiles(runtime.routes, mode, { current: "dash.example.com", next: "next.example.com", previous: ["old-dash.example.com"] });
      const files = await runtime.routes.snapshot();
      expect(Object.keys(files).length).toBeGreaterThanOrEqual(6);
      expect(await runtime.routes.read(`${app.id}.yml`)).toContain("dk-route-1");
      for (const name of Object.keys(files)) await runtime.routes.apply({ removes: [name] });
    });

    it("the agent refuses a file aimed at the socket proxy, with a clear permanent error", async () => {
      await expect(runtime.routes.apply({ writes: { "x.yml": JSON.stringify({ http: { services: { s: { loadBalancer: { servers: [{ url: "http://172.30.4.2:2375" }] } } } } }) } })).rejects.toMatchObject({ name: "AgentRefusal", permanent: true });
      await expect(runtime.routes.apply({ writes: { "../../evil.yml": "{}" } })).rejects.toMatchObject({ name: "AgentRefusal" });
      expect(await runtime.routes.read("x.yml")).toBeNull();
    });
  });

  describe("dial", () => {
    it("reaches a container with a plain connection, joining its network and leaving", async () => {
      joined = [];
      left = [];
      const s = await runtime.dial({ container: "dk-a", network: "dockify-env-a", port: 3000 });
      const got = new Promise<string>((resolve) => s.once("data", (d: Buffer) => resolve(d.toString())));
      s.write("hi");
      expect(await got).toBe("echo:hi");
      expect(joined).toEqual(["dockify-env-a"]);
      s.destroy();
      await expect.poll(() => left).toEqual(["dockify-env-a"]);
    });

    it("carries an HTTP request with its Host header, the way readiness probes", async () => {
      const s = await runtime.dial({ container: "dk-a", network: "dockify-env-a", port: 3000 });
      const body = await new Promise<string>((resolve, reject) => {
        const q = requestOver(s, { path: "/health", method: "GET", headers: { Host: "a.example.com" }, timeoutMs: 5_000 }, (res) => {
          let t = "";
          res.setEncoding("utf8");
          res.on("data", (d) => (t += d));
          res.on("end", () => resolve(t));
        });
        q.on("error", reject);
        q.end();
      });
      expect(body).toBe("hello from a.example.com");
    });

    it("refuses a raw address, a port the proxy does not have and a control network", async () => {
      await expect(runtime.dial({ container: "172.30.3.2", network: "dockify-env-a", port: 5432 })).rejects.toMatchObject({ name: "AgentRefusal" });
      await expect(runtime.dial({ proxy: 2375 as never })).rejects.toMatchObject({ name: "AgentRefusal" });
      await expect(runtime.dial({ container: "dk-a", network: "dockify_data", port: 5432 })).rejects.toMatchObject({ name: "AgentRefusal" });
    });

    it("a TLS client runs on a dialled stream", async () => {
      // No server cert here; a plain echo fails the handshake, and it must fail as a handshake, not hang.
      const s = await runtime.dial({ proxy: 443 });
      const outcome = await new Promise<string>((resolve) => {
        const t = tlsConnect({ socket: s, servername: "a.example.com", rejectUnauthorized: false });
        t.once("secureConnect", () => resolve("connected"));
        t.once("error", () => resolve("failed"));
      });
      expect(outcome).toBe("failed");
    });
  });

  describe("builds", () => {
    let root: string;
    const logs: Array<[string, string]> = [];
    const log = (redactor = new Redactor()) => ({
      redactor,
      system: (t: string) => void logs.push(["system", t]),
      add: (s: "stdout" | "stderr", t: string) => {
        const line = redactor.line(t);
        logs.push([s, line]);
        return line;
      },
    });
    const input = (over: Partial<BuildInput> = {}): BuildInput => ({
      checkoutRoot: root,
      checkoutDir: join(root, "repo"),
      rootDir: "web",
      dockerfilePath: "",
      appId: "app",
      deploymentId: "dep",
      vars: [{ key: "TOKEN", value: "s3cret-value", isSecret: true, target: "both" } satisfies BuildVar],
      timeoutMs: 60_000,
      ...over,
    });
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "dk-ctx-"));
      await mkdir(join(root, "repo", "web"), { recursive: true });
      await mkdir(join(root, "repo", ".git"), { recursive: true });
      await writeFile(join(root, "repo", ".git", "HEAD"), "ref\n");
      await writeFile(join(root, "repo", "web", "Dockerfile"), "FROM scratch\n");
      await writeFile(join(root, "repo", "start.txt"), "npm start");
    });
    afterAll(() => rm(root, { recursive: true, force: true }));

    it("streams the context, runs the build on the far side, and brings back log lines and the result", async () => {
      const out = await runtime.builder.build(input(), log(), AbortSignal.timeout(30_000));
      expect(out).toEqual({ imageId: `sha256:${"b".repeat(64)}`, imageRef: "dockify/app:1", port: 3000 });
      const b = builds.at(-1)!;
      expect(b.dockerfile).toBe("FROM scratch\n");
      expect(b.files).toContain(".git/");
      expect(b.input.vars[0]!.value).toBe("s3cret-value");
      expect(logs).toContainEqual(["system", "building"]);
      expect(logs.flat().join(" ")).not.toContain("s3cret-value");
      // Nothing left behind on the server once the build ends.
      await expect.poll(async () => (await readdir(join(dir, "agent-builds")).catch(() => [])).length).toBe(0);
    });

    it("a resolved variable's other fields stay on this side, or the agent's schema would refuse every build", async () => {
      const vars = [{ key: "TOKEN", value: "s3cret-value", isSecret: true, target: "both", scope: "project" }] as unknown as BuildVar[];
      await expect(runtime.builder.build(input({ vars }), log(), AbortSignal.timeout(30_000))).resolves.toMatchObject({ imageRef: "dockify/app:1" });
      expect(Object.keys(builds.at(-1)!.input.vars[0]!).sort()).toEqual(["isSecret", "key", "target", "value"]);
    });

    it("the agent refuses an id that would add an option to buildctl, before any of it is unpacked", async () => {
      const out = await runtime.builder.build(input({ appId: "x,dest=/var/lib/dockify/agent/agent.key" }), log(), AbortSignal.timeout(30_000)).catch((e: unknown) => e as Error);
      expect(out).toBeInstanceOf(Error);
      expect(builds.at(-1)!.input.appId).not.toContain(",");
    });

    it("a permanent failure stays permanent and redacted, and anything else stays retryable", async () => {
      const perm = await runtime.builder.build(input({ appId: "fails" }), log(), AbortSignal.timeout(30_000)).catch((e: unknown) => e as Error);
      expect(perm).toBeInstanceOf(PermanentDeployError);
      expect((perm as Error).message).toContain("Dockerfile line 3");
      expect((perm as Error).message).not.toContain("s3cret-value");
      const flaky = await runtime.builder.build(input({ appId: "flaky" }), log(), AbortSignal.timeout(30_000)).catch((e: unknown) => e as Error);
      expect(flaky).not.toBeInstanceOf(PermanentDeployError);
      expect((flaky as Error).message).toContain("BuildKit went away");
    });

    it("Railpack's read comes back without the server's folders", async () => {
      const out = await runtime.builder.plan({ checkoutRoot: root, checkoutDir: join(root, "repo"), rootDir: "", vars: [], overrides: { installCommand: "", buildCommand: "", startCommand: "" }, timeoutMs: 30_000 }, (l) => l, AbortSignal.timeout(30_000));
      expect(out.startCommand).toBe("npm start");
      expect(JSON.stringify(out)).not.toContain("/secret/");
    });

    it("a stopped build stops", async () => {
      const ac = new AbortController();
      const p = runtime.builder.build(input(), log(), ac.signal);
      ac.abort();
      await expect(p).rejects.toThrow();
    });

    it("the cache calls answer with buildctl's output, on fixed arguments", async () => {
      expect(await runtime.builder.cacheUsage(5_000)).toContain("du");
      expect(await runtime.builder.pruneCache(5_000)).toContain("prune");
      expect(await runtime.builder.trimCache(1024 ** 3)).toContain("--keep-storage");
    });
  });

  describe("the data browser's clients on a dialled stream", () => {
    const url = process.env.DATABASE_URL_TEST;
    it.skipIf(!url)("node-postgres talks to a real Postgres across the link", async () => {
      const u = new URL(url!);
      dialPort = Number(u.port);
      const session = await connectPg(await runtime.dial({ proxy: 80 }), { user: u.username, password: u.password, database: u.pathname.slice(1) });
      const out = await session.query("SELECT 41 + 1 AS answer");
      expect(out.rows[0]![0]).toBe("42");
      await session.close();
      dialPort = 0;
    });

    it("the Redis client runs on a dialled stream", async () => {
      const redis = netServer((c) => {
        c.on("error", () => {});
        c.on("data", () => c.write("+OK\r\n"));
      });
      await new Promise<void>((res) => redis.listen(0, "127.0.0.1", res));
      dialPort = (redis.address() as AddressInfo).port;
      const client = await connectRedis({ connect: () => runtime.dial({ proxy: 80 }), password: "p" });
      expect(await client.command(["PING"])).toBe("OK");
      client.close();
      dialPort = 0;
      redis.close();
    });
  });
});
