/**
 * The gate against the same two lists the socket proxy's own test reads, and against every hostile body
 * section 2.4 of the design names. A create body here is what containerSpec really writes, so a change
 * to it that the gate does not know fails here first.
 */
import { containerSpec, DockerClient } from "@dockify/engine";
import { createServer, request, type Server } from "node:http";
import { connect, createServer as netServer, type AddressInfo, type Server as NetServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerCalls } from "../../../packages/engine/src/docker-calls.fixture.ts";
import { checkCreateBody, checkExecBody, checkNetworkBody, checkVolumeBody, createDockerGate, GateRefusal, ruleFor, type DockerGate } from "./docker-gate.ts";

const START_EVENTS_PATH = `/events?filters=${encodeURIComponent(JSON.stringify({ type: ["container"], event: ["start"], label: ["dockify.managed=true"] }))}`;
const { USED, AGENT_ONLY, FORBIDDEN, HEX_ID } = dockerCalls((id) => `dk-${id}`, START_EVENTS_PATH);

const good = () => containerSpec({ name: "dk-a", image: "ghcr.io/acme/web:1", network: "dockify-env-acme", aliases: ["dk-a", "dk-route-1"], port: 3000, env: { A: "1" }, volumes: [{ name: "dk-a-data", mountPath: "/data" }], labels: { "dockify.app": "a" }, healthcheck: { test: ["CMD", "true"], intervalSeconds: 5, timeoutSeconds: 2, retries: 3, startSeconds: 1 }, readOnlyRootfs: true, user: "1000" }, 4);

describe("which calls pass", () => {
  it("every call the worker makes", () => {
    for (const [method, url, headers] of USED) expect(() => ruleFor(method, url, headers), `${method} ${url}`).not.toThrow();
  });
  it("no call nothing in Dockify makes", () => {
    for (const [method, url, headers] of FORBIDDEN) expect(() => ruleFor(method, url, headers), `${method} ${url}`).toThrow(GateRefusal);
  });
  it("not what only the agent's own client sends, after a build", () => {
    for (const [method, url, headers] of AGENT_ONLY) expect(() => ruleFor(method, url, headers), `${method} ${url}`).toThrow(GateRefusal);
  });
  it("the real queries DockerClient sends", () => {
    for (const url of [
      "/v1.43/containers/dk-a/stop?t=20",
      "/v1.43/containers/dk-a?force=true&v=false",
      "/v1.43/containers/dk-a?force=true&v=true",
      "/v1.43/images/create?fromImage=ghcr.io%2Facme%2Fweb%3A1",
      `/v1.43/images/create?fromImage=postgres%3A16-alpine%40sha256%3A${"a".repeat(64)}`,
      "/v1.43/images/create?fromImage=registry.lan%3A5000%2Fa_b%2Fc-d%3A1.2&tag=x",
      `/v1.43/images/sha256%3A${"a".repeat(64)}?noprune=false`,
      "/v1.43/images/dockify%2Fapp-0f0e0d0c-0000-4000-8000-0000000000aa%3Adeadbeef?noprune=false",
      "/v1.43/containers/create?name=dk-a",
      "/v1.43/containers/create?name=dockify-rt-b1",
      "/v1.43/containers/dk-a/attach?stream=1&stdout=1&stderr=1&stdin=1",
    ]) {
      const method = url.includes("force=") || url.includes("noprune") ? "DELETE" : "POST";
      expect(() => ruleFor(method, url), url).not.toThrow();
    }
  });
  it.each([
    ["an image from a URL", "POST", "/v1.43/images/create?fromSrc=http://evil/x.tar"],
    ["an image from a URL behind a real name", "POST", "/v1.43/images/create?fromImage=x&fromSrc=http://evil/x.tar"],
    ["a create under a control name", "POST", "/v1.43/containers/create?name=dockify-api-1"],
    ["a create under the proxy's name", "POST", "/v1.43/containers/create?name=dockify-proxy"],
    ["connecting a tenant to the socket proxy's network", "POST", "/v1.43/networks/dockify_docker-api/connect"],
    ["connecting anything to the control network", "POST", "/v1.43/networks/dockify_control/connect"],
    ["a logs call with a smuggled segment", "GET", "/v1.43/containers/dk-a/logs/../json"],
    ["a forced image delete", "DELETE", "/v1.43/images/x?force=true"],
    ["an encoded dot in a container's name", "POST", "/v1.43/containers/%2e%2e/start"],
    ["an encoded dot in an image's name", "DELETE", "/v1.43/images/%2E%2E%2Fcontainers%2Fx?noprune=false"],
  ])("refuses %s", (_label, method, url) => {
    expect(() => ruleFor(method, url)).toThrow(GateRefusal);
  });
});

describe("a create body", () => {
  const mutate = (fn: (b: Record<string, any>) => void) => {
    const b = JSON.parse(JSON.stringify(good())) as Record<string, any>;
    fn(b);
    return () => checkCreateBody(b);
  };
  it("what containerSpec writes passes, with every optional part", () => {
    expect(() => checkCreateBody(good())).not.toThrow();
  });
  it.each<[string, (b: Record<string, any>) => void]>([
    ["privileged", (b) => { b.HostConfig.Privileged = true; }],
    ["a seccomp profile as JSON", (b) => { b.HostConfig.SecurityOpt.push('seccomp={"defaultAction":"SCMP_ACT_ALLOW"}'); }],
    ["apparmor off", (b) => { b.HostConfig.SecurityOpt = ["no-new-privileges:true", "apparmor=unconfined"]; }],
    ["the control network", (b) => { b.HostConfig.NetworkMode = "dockify_control"; b.NetworkingConfig.EndpointsConfig = { dockify_control: {} }; }],
    ["host networking", (b) => { b.HostConfig.NetworkMode = "host"; }],
    ["another container's network", (b) => { b.HostConfig.NetworkMode = "container:dockify-api-1"; }],
    ["a second network", (b) => { b.NetworkingConfig.EndpointsConfig.dockify_data = {}; }],
    ["a static address", (b) => { b.NetworkingConfig.EndpointsConfig["dockify-env-acme"].IPAMConfig = { IPv4Address: "172.30.3.2" }; }],
    ["the proxy's alias", (b) => { b.NetworkingConfig.EndpointsConfig["dockify-env-acme"].Aliases = ["dk-proxy"]; }],
    ["the control database's volume", (b) => { b.HostConfig.Mounts = [{ Type: "volume", Source: "dockify_dockify-db", Target: "/d", ReadOnly: false }]; }],
    ["the backups volume", (b) => { b.HostConfig.Mounts = [{ Type: "volume", Source: "dockify_dockify-backups", Target: "/d", ReadOnly: false }]; }],
    ["a bind mount", (b) => { b.HostConfig.Mounts = [{ Type: "bind", Source: "/", Target: "/host", ReadOnly: false }]; }],
    ["Binds", (b) => { b.HostConfig.Binds = ["/:/host"]; }],
    ["a volume with driver options", (b) => { b.HostConfig.Mounts = [{ Type: "volume", Source: "dk-x", Target: "/d", ReadOnly: false, VolumeOptions: { DriverConfig: { Name: "local", Options: { device: "/", o: "bind", type: "none" } } } }]; }],
    ["an unknown HostConfig key", (b) => { b.HostConfig.CgroupnsMode = "host"; }],
    ["a pid namespace", (b) => { b.HostConfig.PidMode = "host"; }],
    ["an unknown top level key", (b) => { b.Hostname = "x"; }],
    ["a device", (b) => { b.HostConfig.Devices = [{ PathOnHost: "/dev/sda" }]; }],
    ["a published port", (b) => { b.HostConfig.PortBindings = { "22/tcp": [{ HostPort: "22" }] }; }],
    ["another tmpfs", (b) => { b.HostConfig.Tmpfs = { "/run": "rw,exec" }; }],
    ["a capability off the list", (b) => { b.HostConfig.CapAdd = ["SYS_ADMIN"]; }],
    ["no init", (b) => { b.HostConfig.Init = false; }],
    ["another log driver", (b) => { b.HostConfig.LogConfig = { Type: "syslog", Config: { "max-size": "1", "max-file": "1" } }; }],
    ["no managed label", (b) => { delete b.Labels["dockify.managed"]; }],
    ["posing as a compose service", (b) => { b.Labels["com.docker.compose.service"] = "postgres"; }],
  ])("refuses %s", (_label, fn) => {
    expect(mutate(fn)).toThrow(GateRefusal);
  });
});

describe("other bodies", () => {
  it("a volume takes a tenant's name and labels, nothing else", () => {
    expect(() => checkVolumeBody({ Name: "dockify-data-x", Labels: { a: "b" } })).not.toThrow();
    expect(() => checkVolumeBody({ Name: "dk-1234-data" })).not.toThrow();
    expect(() => checkVolumeBody({ Name: "dk-x", DriverOpts: { type: "none", o: "bind", device: "/" } })).toThrow(GateRefusal);
    expect(() => checkVolumeBody({ Name: "dk-x", Driver: "local" })).toThrow(GateRefusal);
    expect(() => checkVolumeBody({ Name: "harmless" })).toThrow(GateRefusal);
    expect(() => checkVolumeBody({ Name: "dockify_dockify-db" })).toThrow(GateRefusal);
  });
  it("a network is exactly what ensureNetwork sends", () => {
    const body = { Name: "dockify-env-a", Driver: "bridge", Internal: false, Attachable: false, Labels: {}, CheckDuplicate: true, Options: { "com.docker.network.bridge.name": "dk-0123456789ab" } };
    expect(() => checkNetworkBody(body)).not.toThrow();
    expect(() => checkNetworkBody({ ...body, Driver: "host" })).toThrow(GateRefusal);
    expect(() => checkNetworkBody({ ...body, Attachable: true })).toThrow(GateRefusal);
    expect(() => checkNetworkBody({ ...body, ConfigOnly: true })).toThrow(GateRefusal);
    expect(() => checkNetworkBody({ ...body, Name: "dockify_control" })).toThrow(GateRefusal);
    expect(() => checkNetworkBody({ ...body, Options: { "com.docker.network.bridge.name": "docker0" } })).toThrow(GateRefusal);
    expect(() => checkNetworkBody({ ...body, Options: { "com.docker.network.bridge.name": "dk-0123456789ab", "com.docker.network.bridge.enable_icc": "true" } })).toThrow(GateRefusal);
  });
  it("an exec is never privileged", () => {
    const body = { AttachStdout: true, AttachStderr: true, AttachStdin: false, Tty: false, Cmd: ["pg_dump"], Env: ["A=1"], User: "postgres" };
    expect(() => checkExecBody(body)).not.toThrow();
    expect(() => checkExecBody({ ...body, Privileged: true })).toThrow(GateRefusal);
    expect(() => checkExecBody({ ...body, WorkingDir: "/" })).toThrow(GateRefusal);
    expect(() => checkExecBody({ ...body, Cmd: [] })).toThrow(GateRefusal);
  });
});

describe("the gate in front of a fake Docker", () => {
  let docker: Server;
  let upgrade: NetServer;
  let gate: DockerGate;
  let client: DockerClient;
  let front: NetServer;
  const seen: string[] = [];
  const CONTAINERS: Record<string, { Id: string; Config: { Labels: Record<string, string>; Env: string[] } }> = {
    "dk-tenant": { Id: "a".repeat(64), Config: { Labels: { "dockify.managed": "true" }, Env: ["SECRET=tenant"] } },
    "dockify-proxy": { Id: "b".repeat(64), Config: { Labels: {}, Env: ["CF_DNS=x"] } },
    cloudflared: { Id: "c".repeat(64), Config: { Labels: {}, Env: ["TUNNEL_TOKEN=abc"] } },
  };

  beforeAll(async () => {
    docker = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      const m = /^\/v1\.43\/containers\/([^/?]+)\/json/.exec(req.url ?? "");
      if (m) {
        const c = CONTAINERS[decodeURIComponent(m[1]!)];
        if (!c) {
          res.writeHead(404, { "content-type": "application/json" });
          return res.end(JSON.stringify({ message: "No such container" }));
        }
        return res.end(JSON.stringify(c));
      }
      req.resume();
      req.on("end", () => {
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>((r) => docker.listen(0, "127.0.0.1", r));
    gate = createDockerGate({ host: "127.0.0.1", port: (docker.address() as AddressInfo).port });
    // The gate on a real socket: exec's raw tunnel needs a real stream under it.
    front = netServer((s) => gate.handle(s));
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
    client = new DockerClient({ host: "127.0.0.1", port: (front.address() as AddressInfo).port }, { cpuCores: 4 });
  });
  afterAll(() => {
    gate.close();
    front.close();
    upgrade?.close();
    docker.closeAllConnections();
    docker.close();
  });

  it("keeps a tenant's env and drops another container's", async () => {
    expect((await client.inspectContainer("dk-tenant")).Config.Env).toEqual(["SECRET=tenant"]);
    const other = await client.inspectContainer("cloudflared");
    expect(other.Id).toBe("c".repeat(64));
    expect(other.Config.Env).toBeUndefined();
  });

  it("stops, kills and removes a tenant's container, and refuses Traefik and the agent", async () => {
    await expect(client.stopContainer("dk-tenant", 20)).resolves.toBeUndefined();
    await expect(client.removeContainer("dk-tenant")).resolves.toBeUndefined();
    await expect(client.stopContainer("dockify-proxy", 20)).rejects.toMatchObject({ status: 400 });
    await expect(client.removeContainer("dockify-proxy")).rejects.toMatchObject({ status: 400 });
    await expect(client.call("POST", `/containers/${"b".repeat(64)}/kill`)).rejects.toMatchObject({ status: 400 });
    expect(seen.filter((s) => s.includes("dockify-proxy") && !s.includes("/json"))).toEqual([]);
  });

  it("reads as not found when there is no such container, as a swap expects", async () => {
    await expect(client.stopContainer("dk-gone", 20)).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a create before anything reaches Docker", async () => {
    const before = seen.length;
    const body = JSON.parse(JSON.stringify(good())) as Record<string, any>;
    body.HostConfig.Privileged = true;
    await expect(client.call("POST", "/containers/create?name=dk-a", body)).rejects.toMatchObject({ status: 400 });
    expect(seen.length).toBe(before);
  });

  it("passes a real create through with its body", async () => {
    await expect(client.call("POST", "/containers/create?name=dk-a", good(), true)).resolves.toBeUndefined();
    expect(seen.at(-1)).toBe("POST /v1.43/containers/create?name=dk-a");
  });

  it("a network refusal is not mistaken for already being attached", async () => {
    await expect(client.connectNetwork("dockify-env-acme", "dockify-worker")).rejects.toMatchObject({ status: 400 });
    await expect(client.connectNetwork("dockify-env-acme", "dockify-agent")).rejects.toMatchObject({ status: 400 });
    await expect(client.disconnectNetwork("dockify-env-acme", "dockify-agent")).resolves.toBeUndefined();
    await expect(client.connectNetwork("dockify_control", "dk-tenant")).rejects.toMatchObject({ status: 400 });
  });

  it("tunnels an exec's bytes after the checks", async () => {
    const tunnel = netServer((s) => {
      let head = "";
      s.on("data", (d) => {
        head += d.toString("latin1");
        if (!head.includes("\r\n\r\n")) return;
        if (head.startsWith("POST")) {
          s.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\nhello");
          head = "GOT";
        }
      });
    });
    await new Promise<void>((r) => tunnel.listen(0, "127.0.0.1", r));
    upgrade = tunnel;
    const g = createDockerGate({ host: "127.0.0.1", port: (tunnel.address() as AddressInfo).port });
    const f = netServer((s) => g.handle(s));
    await new Promise<void>((r) => f.listen(0, "127.0.0.1", r));
    const port = (f.address() as AddressInfo).port;
    const payload = Buffer.from(JSON.stringify({ Detach: false, Tty: true }));
    const body = await new Promise<string>((resolve, reject) => {
      const q = request({ host: "127.0.0.1", port, method: "POST", path: `/v1.43/exec/${HEX_ID}/start`, headers: { "Content-Type": "application/json", "Content-Length": payload.length, Connection: "Upgrade", Upgrade: "tcp" } });
      q.on("upgrade", (_r, s, h) => {
        let t = h.toString();
        if (t) return resolve(t);
        s.on("data", (d) => {
          t += d.toString();
          resolve(t);
        });
      });
      q.on("response", () => reject(new Error("no upgrade")));
      q.on("error", reject);
      q.end(payload);
    });
    expect(body).toBe("hello");

    const refused = await new Promise<number>((resolve, reject) => {
      const bad = Buffer.from(JSON.stringify({ Detach: false, Privileged: true }));
      const q = request({ host: "127.0.0.1", port, method: "POST", path: `/v1.43/exec/${HEX_ID}/start`, headers: { "Content-Type": "application/json", "Content-Length": bad.length, Connection: "Upgrade", Upgrade: "tcp" } });
      q.on("upgrade", () => reject(new Error("upgraded")));
      q.on("response", (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      });
      q.on("error", reject);
      q.end(bad);
    });
    expect(refused).toBe(400);
    g.close();
    f.close();
  });

  it("a request smuggled behind a refused upgrade never reaches the socket proxy", async () => {
    // A proxy that keeps the connection in HTTP mode, as haproxy does for any answer but a 101.
    const reached: string[] = [];
    const proxy = netServer((s) => {
      s.on("error", () => {});
      s.on("data", (d: Buffer) => {
        for (const line of d.toString("latin1").split("\r\n")) if (/^(?:GET|POST|DELETE) /.test(line)) reached.push(line);
        const text = JSON.stringify({ message: "No such exec instance" });
        s.write(`HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: ${text.length}\r\n\r\n${text}`);
      });
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const g = createDockerGate({ host: "127.0.0.1", port: (proxy.address() as AddressInfo).port });
    const f = netServer((s) => g.handle(s));
    await new Promise<void>((r) => f.listen(0, "127.0.0.1", r));
    const body = '{"Detach":false,"Tty":false}';
    const hostile = JSON.stringify({ HostConfig: { Privileged: true } });
    const smuggled = `POST /v1.43/containers/create?name=dk-evil HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${hostile.length}\r\n\r\n${hostile}`;
    const raw = connect((f.address() as AddressInfo).port, "127.0.0.1");
    const answer = await new Promise<string>((resolve) => {
      let got = "";
      raw.on("data", (d: Buffer) => {
        got += d.toString();
        if (got.includes("No such exec")) resolve(got);
      });
      // The bytes after the body are the attack, in one write and in a later one.
      raw.write(`POST /v1.43/exec/${HEX_ID}/start HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}${smuggled}`);
    });
    expect(answer).toContain("404");
    raw.write(smuggled);
    await new Promise((r) => setTimeout(r, 200));
    expect(reached).toEqual([`POST /v1.43/exec/${HEX_ID}/start HTTP/1.1`]);
    raw.destroy();
    g.close();
    f.close();
    proxy.close();
  });
});

/** An image's own labels land on its container, and megabytes of them make its inspect too large to hold. */
describe("a container whose inspect is too large to read", () => {
  const HEAVY = "d".repeat(64);
  const OTHER = "e".repeat(64);
  const BLOAT = "x".repeat(9 * 1024 * 1024);
  const seen: string[] = [];
  let docker: Server;
  let front: NetServer;
  let gate: DockerGate;
  let client: DockerClient;
  // name: [the start of its inspect, what the managed list answers for its id]
  const answers: Record<string, [string, string]> = {
    "dk-heavy": [`{"Id":"${HEAVY}","Config":{"Labels":{"dockify.managed":"true","junk":"`, `[{"Id":"${HEAVY}","Labels":{"junk":"${BLOAT}"}}]`],
    "heavy-control": [`{"Id":"${OTHER}","Config":{"Labels":{"junk":"`, "[]\n"],
    "dk-reordered": [`{"Created":"now","Id":"${HEAVY}","Config":{"Labels":{"junk":"`, `[{"Id":"${HEAVY}"}]`],
    "dk-mismatch": [`{"Id":"${"f".repeat(64)}","Config":{"Labels":{"junk":"`, `[{"Id":"${HEAVY}"}]`],
  };

  beforeAll(async () => {
    docker = createServer((req, res) => {
      const url = req.url ?? "";
      seen.push(`${req.method} ${url.split("?")[0]}`);
      const m = /^\/v1\.43\/containers\/([^/?]+)\/json$/.exec(url);
      if (m) return void res.end(`${answers[m[1]!]![0]}${BLOAT}"}}}`);
      if (url.startsWith("/v1.43/containers/json?")) {
        const filters = JSON.parse(new URL(url, "http://x").searchParams.get("filters")!) as { id: string[]; label: string[] };
        expect(filters.label).toEqual(["dockify.managed=true"]);
        const hit = Object.values(answers).find(([head]) => head.includes(`"Id":"${filters.id[0]}"`));
        return void res.end(hit![1]);
      }
      res.writeHead(204);
      res.end();
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

  it("is still stopped and removed when it is a tenant's", async () => {
    await expect(client.stopContainer("dk-heavy", 20)).resolves.toBeUndefined();
    await expect(client.removeContainer("dk-heavy")).resolves.toBeUndefined();
    expect(seen).toContain("DELETE /v1.43/containers/dk-heavy");
  });

  it("is still refused when it is not, with nothing but reads reaching Docker", async () => {
    seen.length = 0;
    await expect(client.removeContainer("heavy-control")).rejects.toMatchObject({ status: 400 });
    expect(seen).toEqual(["GET /v1.43/containers/heavy-control/json", "GET /v1.43/containers/json"]);
  });

  it("fails closed when the answer does not start with the id, or the list names another container", async () => {
    seen.length = 0;
    await expect(client.removeContainer("dk-reordered")).rejects.toMatchObject({ status: 502 });
    await expect(client.removeContainer("dk-mismatch")).rejects.toMatchObject({ status: 502 });
    expect(seen.filter((s) => s.startsWith("DELETE"))).toEqual([]);
  });
});
