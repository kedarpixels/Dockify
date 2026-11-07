/**
 * The agent's calls over a real HTTP/2 session, with stand-ins only for what needs the box: what a caller
 * on the link can make it read, write or crash on. Links are real ones where this machine allows it.
 */
import { link as L } from "@dockify/contracts";
import { fileRouteStore, findDockerfile, insideCheckout } from "@dockify/engine";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentApi, repositoryFolder } from "./api.ts";

const tarEntry = (name: string, type: string, link = "", body: Buffer = Buffer.alloc(0)): Buffer => {
  const h = Buffer.alloc(512);
  h.write(name, 0);
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.write(type, 156);
  h.write(link, 157);
  h.write("ustar\0", 257);
  h.write("00", 263);
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([h, body, pad]);
};
const END = Buffer.alloc(1024);

const firstLine = (over: object = {}) => JSON.stringify({ repoDir: "repo", rootDir: "", dockerfilePath: "Dockerfile", appId: "a", deploymentId: "d", vars: [], timeoutMs: 60_000, maxBytes: 1_000_000, ...over });
const canSymlink = async (dir: string): Promise<boolean> => {
  try {
    await symlink(join(dir, "nowhere"), join(dir, `probe-${Date.now()}`));
    return true;
  } catch {
    return false;
  }
};

describe("the agent's api", () => {
  let dir: string;
  let buildRoot: string;
  let links = false;
  let server: http2.Http2Server;
  let client: http2.ClientHttp2Session;
  let built: Array<{ checkoutDir: string; checkoutRoot: string; listing: string[]; rootListing: string[] }> = [];
  const written: Array<{ writes?: Record<string, string>; removes?: string[] }> = [];
  const onDisk: Record<string, string> = {};
  let held: string[] = [];

  const answer = (path: string, method: string, body?: string | Buffer, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> =>
    new Promise((resolve, reject) => {
      const st = client.request({ ":method": method, ":path": path, ...headers }, { endStream: body === undefined });
      let status = 0;
      let text = "";
      st.on("response", (h) => {
        status = Number(h[":status"]);
      });
      st.setEncoding("utf8");
      st.on("data", (c: string) => (text += c));
      st.on("close", () => resolve({ status, text }));
      st.on("error", reject);
      if (body !== undefined) st.end(body);
    });
  const buildWith = (first: string, tar: Buffer) => answer("/v1/build", "POST", Buffer.concat([Buffer.from(`${first}\n`), tar]));
  const lastLine = (text: string): L.BuildLine => JSON.parse(text.trim().split("\n").at(-1)!) as L.BuildLine;

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "agent-api-")));
    buildRoot = join(dir, "builds");
    await mkdir(buildRoot);
    links = await canSymlink(dir);
    const api = createAgentApi({
      gate: { handle() {}, close() {} },
      dial: async () => {
        throw new Error("unused");
      },
      routes: {
        read: async (name) => onDisk[name] ?? null,
        snapshot: async () => ({ ...onDisk }),
        apply: async (change) => {
          written.push(change);
          Object.assign(onDisk, change.writes ?? {});
          for (const name of change.removes ?? []) delete onDisk[name];
        },
      },
      routeRules: { upstreams: ["http://172.30.1.10:3001"] },
      heldAddresses: async () => new Set(held),
      diskPath: ".",
      buildRoot,
      maxContextBytes: 4096,
      build: { docker: {} as never, buildkitAddr: "unix:///none" },
      facts: { version: "1", hostname: "h", publicIpv4: null, publicIpv6: null, dockerVersion: null, os: null, ingress: "direct_tls" },
      buildImage: async (_s, b) => {
        built.push({ checkoutDir: b.checkoutDir, checkoutRoot: b.checkoutRoot!, listing: await readdir(b.checkoutDir), rootListing: await readdir(b.checkoutRoot!) });
        return { imageId: `sha256:${"a".repeat(64)}`, imageRef: "x" };
      },
    });
    server = http2.createServer();
    server.on("stream", (st, h) => api(st, h));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    client = http2.connect(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    client.on("error", () => {});
  });
  afterAll(async () => {
    client.destroy();
    server.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  describe("a :path that is not one", () => {
    it.each(["//[", "//"])("%s answers, and the agent lives", async (p) => {
      const got = await answer(p, "GET");
      expect(got.status).toBeGreaterThanOrEqual(400);
      expect((await answer("/v1/info", "GET")).status).toBe(200);
    });
  });

  describe("a build's folders", () => {
    const repo = () => Buffer.concat([tarEntry("repo/", "5"), tarEntry("repo/Dockerfile", "0", "", Buffer.from("FROM scratch\n")), END]);

    it("a real repository builds, its context in a folder of its own", async () => {
      built = [];
      const got = await buildWith(firstLine(), repo());
      expect(lastLine(got.text)).toMatchObject({ t: "end" });
      expect(built).toHaveLength(1);
      expect(built[0]!.listing).toEqual(["Dockerfile"]);
      // The steps' folders go in the root, which holds nothing the caller sent but the context's own folder.
      expect(built[0]!.rootListing).toEqual(["ctx"]);
      expect(built[0]!.checkoutDir).toBe(join(built[0]!.checkoutRoot, "ctx", "repo"));
    });

    it("the names a step writes land in the context, never where it writes", async () => {
      built = [];
      const tar = Buffer.concat([tarEntry("repo/Dockerfile", "0", "", Buffer.from("x")), tarEntry("plan/railpack-plan.json", "0", "", Buffer.from("planted")), tarEntry("plan-out/x", "0", "", Buffer.from("planted")), END]);
      await buildWith(firstLine(), tar);
      expect(built[0]!.rootListing).toEqual(["ctx"]);
    });

    it("a repoDir that is a link is refused before any build", async (ctx) => {
      if (!links) return ctx.skip();
      built = [];
      const got = await buildWith(firstLine({ dockerfilePath: "agent.key" }), Buffer.concat([tarEntry("repo", "2", "/var/lib/dockify/agent"), END]));
      expect(lastLine(got.text)).toMatchObject({ t: "error" });
      expect(built).toEqual([]);
    });

    it("a link under the root does not catch a step's write", async (ctx) => {
      if (!links) return ctx.skip();
      built = [];
      const tar = Buffer.concat([tarEntry("repo/Dockerfile", "0", "", Buffer.from("x")), tarEntry("plan", "2", join(dir, "elsewhere")), tarEntry("plan-out", "2", join(dir, "elsewhere")), END]);
      await buildWith(firstLine(), tar);
      expect(built[0]!.rootListing).toEqual(["ctx"]);
    });

    it.each(["/etc", "../x", "a/../b", "a\\b", "a//b", "./a"])("repoDir %s is refused", async (repoDir) => {
      built = [];
      const got = await buildWith(firstLine({ repoDir }), repo());
      expect(lastLine(got.text)).toMatchObject({ t: "error" });
      expect(built).toEqual([]);
    });

    it("this server's own ceiling holds, whatever the first line asks for", async () => {
      built = [];
      const got = await buildWith(firstLine({ maxBytes: 1_000_000 }), Buffer.concat([tarEntry("repo/big", "0", "", Buffer.alloc(8192)), END]));
      expect(lastLine(got.text)).toMatchObject({ t: "error" });
      expect(built).toEqual([]);
    });

    it("no build leaves anything behind", async () => {
      expect(await readdir(buildRoot)).toEqual([]);
    });
  });

  describe("repositoryFolder", () => {
    it("takes a real folder, and the context itself", async () => {
      const ctx = join(dir, "c1");
      await mkdir(join(ctx, "a", "b"), { recursive: true });
      expect(await repositoryFolder(ctx, "a/b")).toBe(join(ctx, "a", "b"));
      expect(await repositoryFolder(ctx, "")).toBe(ctx);
    });
    it("refuses a junction or link at any part of the path, and a file", async () => {
      const ctx = join(dir, "c2");
      const target = join(dir, "agentdir");
      await mkdir(ctx, { recursive: true });
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "agent.key"), "SECRET");
      await symlink(target, join(ctx, "repo"), "junction");
      await expect(repositoryFolder(ctx, "repo")).rejects.toThrow(/link/);
      await mkdir(join(ctx, "real"));
      await symlink(target, join(ctx, "real", "inner"), "junction");
      await expect(repositoryFolder(ctx, "real/inner")).rejects.toThrow(/link/);
      await writeFile(join(ctx, "file"), "x");
      await expect(repositoryFolder(ctx, "file")).rejects.toThrow(/link/);
      await expect(repositoryFolder(ctx, "missing")).rejects.toThrow(/link/);
      expect((await lstat(join(target, "agent.key"))).isFile()).toBe(true);
    });
  });

  describe("a route change", () => {
    const route = (url: string, router = "r") => JSON.stringify({ http: { routers: { [router]: { rule: "Host(`a.example.com`)", entryPoints: ["web"], service: router } }, services: { [router]: { loadBalancer: { servers: [{ url }] } } } } });
    const post = (writes: object, removes?: string[]) => answer("/v1/routes", "POST", JSON.stringify({ writes, ...(removes ? { removes } : {}) }));

    it("writes the validator's text, not the caller's", async () => {
      const raw = route("http://dk-a.:1");
      expect((await post({ "one.yml": raw })).status).toBe(200);
      expect(onDisk["one.yml"]).toBe(`${JSON.stringify(JSON.parse(raw), null, 2)}\n`);
      await post({}, ["one.yml"]);
    });

    it("refuses a template, so nothing is written", async () => {
      const before = written.length;
      const got = await post({ "one.yml": route("http://dk-a.:1").replace("Host(`a.example.com`)", "Host(`a`){{ b64dec `eA==` }}") });
      expect(got.status).toBe(400);
      expect(written.length).toBe(before);
    });

    it("refuses a name another file holds", async () => {
      expect((await post({ "one.yml": route("http://dk-a.:1", "same") })).status).toBe(200);
      expect((await post({ "two.yml": route("http://dk-b.:1", "same") })).status).toBe(400);
      expect(onDisk["two.yml"]).toBeUndefined();
      // Moved in one change, as a rename would be.
      expect((await post({ "two.yml": route("http://dk-b.:1", "same") }, ["one.yml"])).status).toBe(200);
      await post({}, ["two.yml"]);
    });

    it("takes an address only while a tenant's container holds it, and asks Docker only then", async () => {
      held = [];
      expect((await post({ "one.yml": route("http://172.18.0.5:3000") })).status).toBe(400);
      held = ["172.18.0.5"];
      expect((await post({ "one.yml": route("http://172.18.0.5:3000") })).status).toBe(200);
      held = [];
      await post({}, ["one.yml"]);
    });

    it("refuses a route to the proxy's metrics", async () => {
      expect((await post({ "one.yml": route("http://dk-proxy.:8082") })).status).toBe(400);
    });

    it("a remove alone needs no read of the folder", async () => {
      expect((await post({}, ["gone.yml"])).status).toBe(200);
    });
  });
});

describe("what crosses the link, by its schemas", () => {
  const build = { repoDir: "repo", rootDir: "", dockerfilePath: "x", appId: "a", deploymentId: "d", vars: [], timeoutMs: 1, maxBytes: 1 };
  it.each(["x,dest=/y", "x y", "../x", "x\nz", "-x"])("the id %j cannot add an option to buildctl", (appId) => {
    expect(L.BuildRequest.safeParse({ ...build, appId }).success).toBe(false);
    expect(L.BuildRequest.safeParse({ ...build, deploymentId: appId }).success).toBe(false);
    expect(L.BuildRequest.safeParse({ ...build, cacheScope: appId }).success).toBe(false);
  });
  it.each(["A,src=/etc/passwd", "A=B", "1A"])("the variable %s cannot name a secret's source", (key) => {
    expect(L.BuildRequest.safeParse({ ...build, vars: [{ key, value: "v", isSecret: false, target: "build" }] }).success).toBe(false);
  });
  it.each<[string, object]>([
    ["a control container", { container: "dockify-worker", network: "dockify-env-a", port: 1 }],
    ["a control network", { container: "dk-a", network: "dockify_control", port: 1 }],
    ["no such port", { container: "dk-a", network: "dockify-env-a", port: 70000 }],
    ["a raw address", { host: "169.254.169.254", port: 80 }],
    ["another port on the proxy", { proxy: 2375 }],
    ["an extra key", { container: "dk-a", network: "dockify-env-a", port: 1, host: "x" }],
  ])("a dial refuses %s", (_label, d) => {
    expect(L.DialRequest.safeParse(d).success).toBe(false);
  });
  it.each(["../x.yml", "a/b.yml", "..yml", ".hidden.yml", "x.yaml", "x.toml", "x.yml\n", "x\u0000.yml"])("a route file cannot be named %j", (name) => {
    expect(L.RouteChangeBody.safeParse({ writes: { [name]: "{}" } }).success).toBe(false);
  });
  it.each(["../../x.yml", "..%2fx.yml", "../secrets/link_key"])("the store will not read %s", async (name) => {
    await expect(fileRouteStore(".").read(name)).rejects.toThrow();
  });
});

describe("insideCheckout, from a folder that is no link", () => {
  it("still confines what a build reads to it", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "agent-inside-")));
    const ctx = join(base, "ctx");
    const secret = join(base, "agentdir");
    await mkdir(join(ctx, "repo"), { recursive: true });
    await mkdir(secret);
    await writeFile(join(secret, "agent.key"), "SECRET");
    await symlink(secret, join(ctx, "repo", "inner"), "junction");
    const repo = await repositoryFolder(ctx, "repo");
    await expect(insideCheckout(repo, "inner/agent.key")).rejects.toThrow(/outside the repository/);
    await expect(insideCheckout(repo, "inner")).rejects.toThrow(/symlink|outside/);
    await expect(findDockerfile(repo, "", "inner/agent.key")).rejects.toThrow(/outside the repository/);
    await rm(base, { recursive: true, force: true });
  });
});

describe("the schemas' ceilings", () => {
  const body = { repoDir: "repo", rootDir: "", dockerfilePath: "x", appId: "a", deploymentId: "d", vars: [], timeoutMs: 1 };
  it("maxBytes has one", () => {
    expect(L.BuildRequest.safeParse({ ...body, maxBytes: 1e15 }).success).toBe(false);
    expect(L.BuildRequest.safeParse({ ...body, maxBytes: 2 * 1024 ** 3 }).success).toBe(true);
    expect(L.BuildRequest.safeParse({ ...body, maxBytes: 50 * 1024 ** 3 }).success).toBe(true);
    expect(L.PlanRequest.safeParse({ repoDir: "repo", rootDir: "", vars: [], overrides: { installCommand: "", buildCommand: "", startCommand: "" }, timeoutMs: 1, maxBytes: 1e15 }).success).toBe(false);
  });
  it("the link's stream limit is the design's", () => {
    expect(L.LINK_LIMITS.h2MaxConcurrentStreams).toBe(256);
    expect(L.LINK_LIMITS.logFollowsMax).toBeLessThan(L.LINK_LIMITS.h2MaxConcurrentStreams);
  });
});
