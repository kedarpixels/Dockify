import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planBuild } from "@dockify/engine";
import { appAliases, appContainerInput, canonicalName, routeAlias, type RunnableApp } from "./containers.ts";
import { containerSpec } from "@dockify/engine";
import { Demuxer, parseDockerHost } from "@dockify/engine";
import { mergeScopes, rollbackEnv, runtimeEnv } from "./env.ts";
import { PermanentDeployError } from "@dockify/engine";
import { isPublicAddress, translateGitError } from "./git.ts";
import { insideCheckout } from "@dockify/engine";
import { pruneArgs } from "@dockify/engine";
import { computeRetention } from "./janitor.ts";
import { fileRouteStore } from "@dockify/engine";
import { decodeChunk, DeployLog, encodeChunk, LineSplitter, MAX_LINE, type LogLine } from "./log.ts";
import { Redactor } from "@dockify/redact";
import { renderRoute, ReservedHostError, routedBackend, routedHosts, writeRoute } from "./routes.ts";
import { closeSteps, initialSteps, parseSteps, setStep, stepDone } from "./steps.ts";
import { describeStrategy, swapStrategy } from "./strategy.ts";

describe("swap strategy", () => {
  it("stateless apps get zero downtime", () => {
    expect(swapStrategy({ kind: "backend", volumes: [] })).toEqual({ mode: "zero_downtime", reasons: [] });
  });
  it("volumes, stateful kinds and fixed ports force stop-then-start with a reason each", () => {
    const s = swapStrategy({ kind: "postgres", volumes: [{ name: "pg", mountPath: "/var/lib/postgresql/data" }], hostPorts: [5432] });
    expect(s.mode).toBe("stop_then_start");
    expect(s.reasons).toHaveLength(2);
    expect(describeStrategy(s)).toMatch(/volume pg at \/var\/lib\/postgresql\/data.*fixed host port 5432/);
    expect(swapStrategy({ kind: "redis", volumes: [] }).reasons[0]).toMatch(/redis service/);
  });
});

describe("log", () => {
  it("round-trips the chunk codec", () => {
    const lines: LogLine[] = [{ ts: "2026-10-30T00:00:00.000Z", stream: "stdout", text: "a" }, { ts: "2026-10-30T00:00:01.000Z", stream: "stderr", text: "bé" }];
    expect(decodeChunk(encodeChunk(lines))).toEqual(lines);
  });
  it("splits CR, CRLF and LF and caps a line with no newline", () => {
    const out: string[] = [];
    const s = new LineSplitter((t) => out.push(t));
    s.push("one\r\ntwo\rthr");
    s.push("ee\n");
    s.push("x".repeat(MAX_LINE + 5));
    s.end();
    expect(out.slice(0, 3)).toEqual(["one", "two", "three"]);
    expect(out[3]).toHaveLength(MAX_LINE);
    expect(out[4]).toBe("xxxxx");
  });
  it("redacts, batches and survives a failing sink", async () => {
    const written: LogLine[][] = [];
    const log = new DeployLog({ write: async (l) => void written.push(l) });
    log.redactor.conceal(["s3cr3t-value"]);
    log.add("stdout", "url postgres://u:s3cr3t-value@db/x");
    log.system("hello");
    await log.flush();
    expect(written.flat().map((l) => l.text)).toEqual(["url postgres://[REDACTED]@db/x", "==> hello"]);
    const bad = new DeployLog({ write: async () => { throw new Error("db down"); } });
    bad.add("stdout", "x");
    await expect(bad.flush()).resolves.toBeUndefined();
  });
});

describe("redactor", () => {
  it("hides literals, named secrets, tokens and PEM bodies", () => {
    const r = new Redactor();
    r.conceal(["abcdef123", "true"]);
    expect(r.line("v=abcdef123 flag=true")).toBe("v=[REDACTED] flag=true");
    expect(r.line("API_KEY=xyz")).toBe("API_KEY=[REDACTED]");
    expect(r.line("Authorization: Bearer abcdefghijkl")).toContain("[REDACTED]");
    expect(r.line("-----BEGIN RSA PRIVATE KEY-----")).toBe("[REDACTED]");
    expect(r.line("MIIEow")).toBe("[REDACTED]");
    expect(r.line("-----END RSA PRIVATE KEY-----")).toBe("[REDACTED]");
    expect(r.line("after")).toBe("after");
  });
});

describe("steps", () => {
  it("tracks a timeline and closes it on failure", () => {
    let s = initialSteps("t0");
    s = setStep(s, "clone", "running", "t1");
    s = setStep(s, "clone", "done", "t2");
    s = setStep(s, "build", "running", "t3");
    expect(stepDone(s, "clone")).toBe(true);
    const closed = closeSteps(s, "failed", "t4");
    expect(closed.find((x) => x.id === "build")).toMatchObject({ status: "failed", finishedAt: "t4" });
    expect(closed.find((x) => x.id === "health")?.status).toBe("skipped");
    expect(parseSteps([{ id: "clone", status: "done", startedAt: "a", finishedAt: "b" }, { id: "evil" }], "n")).toHaveLength(7);
  });
});

describe("env", () => {
  it("app beats environment beats project, and PORT is filled in", () => {
    const merged = mergeScopes([
      { key: "A", value: "app", isSecret: false, target: "both", scope: "app" },
      { key: "A", value: "proj", isSecret: false, target: "both", scope: "project" },
      { key: "B", value: "env", isSecret: true, target: "build", scope: "environment" },
    ]);
    expect(merged.map((v) => [v.key, v.value])).toEqual([["A", "app"], ["B", "env"]]);
    expect(runtimeEnv(merged, 3000)).toEqual({ A: "app", PORT: "3000" });
  });
  it("a rollback never resurrects a rotated secret or a removed variable", () => {
    const snapshot = [
      { key: "ADMIN_BYPASS", value: "1", isSecret: false, target: "runtime" as const },
      { key: "API_URL", value: "https://old.example", isSecret: false, target: "both" as const },
      { key: "JWT_SECRET", value: "leaked-old", isSecret: true, target: "runtime" as const },
      { key: "OLD_TOKEN", value: "gone", isSecret: true, target: "runtime" as const },
    ];
    const current = [
      { key: "API_URL", value: "https://new.example", isSecret: false, target: "both" as const },
      { key: "JWT_SECRET", value: "rotated-new", isSecret: true, target: "runtime" as const },
      { key: "NEW_FLAG", value: "x", isSecret: false, target: "runtime" as const },
    ];
    const r = rollbackEnv(snapshot, current);
    expect(Object.fromEntries(r.vars.map((v) => [v.key, v.value]))).toEqual({ API_URL: "https://old.example", JWT_SECRET: "rotated-new", NEW_FLAG: "x" });
    expect(r.secretsKeptCurrent).toEqual(["JWT_SECRET"]);
    expect(r.notRestored).toEqual(["ADMIN_BYPASS", "OLD_TOKEN"]);
    // A value that was secret then and is plain now still follows today's env.
    const flipped = rollbackEnv([{ key: "K", value: "old", isSecret: true, target: "both" }], [{ key: "K", value: "new", isSecret: false, target: "both" }]);
    expect(flipped.vars[0]!.value).toBe("new");
  });
});

describe("build plan", () => {
  it("never puts a secret on argv and keeps build args stable", () => {
    const p = planBuild({
      buildkitAddr: "tcp://buildkitd:1234",
      contextDir: "/b/repo",
      dockerfileDir: "/b/repo",
      dockerfileName: "Dockerfile",
      imageName: "dockify/app-x:12345678",
      appId: "x",
      deploymentId: "12345678",
      vars: [
        { key: "NEXT_PUBLIC_URL", value: "https://a.example", isSecret: false, target: "both" },
        { key: "DB_PASSWORD", value: "hunter22", isSecret: true, target: "both" },
        { key: "RUNTIME_ONLY", value: "r", isSecret: false, target: "runtime" },
      ],
    });
    expect(p.args.join(" ")).not.toContain("hunter22");
    expect(p.args).toContain("build-arg:NEXT_PUBLIC_URL=https://a.example");
    expect(p.args.join(" ")).not.toContain("RUNTIME_ONLY");
    expect(p.env.DOCKIFY_BUILD_SECRET_DB_PASSWORD).toBe("hunter22");
    expect(p.secretKeys).toEqual(["NEXT_PUBLIC_URL", "DB_PASSWORD"]);
    expect(p.args.join(" ")).not.toMatch(/\d{13}/);
  });
  it("never turns a build-only secret into a build-arg (image history and cache keys keep ARGs)", () => {
    const p = planBuild({
      buildkitAddr: "tcp://buildkitd:1234",
      contextDir: "/b/repo",
      dockerfileDir: "/b/repo",
      dockerfileName: "Dockerfile",
      imageName: "dockify/app-x:12345678",
      appId: "x",
      deploymentId: "12345678",
      vars: [
        { key: "NPM_TOKEN", value: "npm_s3cretvalue", isSecret: true, target: "build" },
        { key: "PLAIN_BUILD", value: "1", isSecret: false, target: "build" },
      ],
    });
    expect(p.args.join(" ")).not.toContain("npm_s3cretvalue");
    expect(p.args.join(" ")).not.toContain("build-arg:NPM_TOKEN");
    expect(p.buildArgKeys).toEqual(["PLAIN_BUILD"]);
    expect(p.args).toContain("id=NPM_TOKEN,env=DOCKIFY_BUILD_SECRET_NPM_TOKEN");
    expect(p.env.DOCKIFY_BUILD_SECRET_NPM_TOKEN).toBe("npm_s3cretvalue");
  });
});

describe("git", () => {
  it("accepts only public addresses", () => {
    for (const a of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "192.168.1.1", "172.16.0.1", "0.0.0.0", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "64:ff9b::1", "2001:db8::1", "2001::1"]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    for (const a of ["140.82.112.3", "8.8.8.8", "2606:4700::1111"]) expect(isPublicAddress(a), a).toBe(true);
    expect(isPublicAddress("github.com")).toBe(false);
  });
  it("classifies failures", () => {
    expect(translateGitError({ stderr: "fatal: couldn't find remote ref refs/heads/nope" }, "fetch", false)).toBeInstanceOf(PermanentDeployError);
    expect(translateGitError({ stderr: "Could not resolve host" }, "fetch", false)).not.toBeInstanceOf(PermanentDeployError);
    expect(translateGitError({ stderr: "Repository not found" }, "fetch", true).message).toMatch(/GitHub App token/);
  });
  it("refuses paths that leave the checkout or are symlinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dk-co-"));
    await mkdir(join(dir, "web"));
    await writeFile(join(dir, "web", "Dockerfile"), "FROM scratch\n");
    expect(await insideCheckout(dir, "web/Dockerfile")).toMatch(/Dockerfile$/);
    await expect(insideCheckout(dir, "../etc")).rejects.toBeInstanceOf(PermanentDeployError);
    await expect(insideCheckout(dir, "/etc")).rejects.toBeInstanceOf(PermanentDeployError);
    await expect(insideCheckout(dir, "missing")).rejects.toThrow(/does not exist/);
    const linked = await symlink(tmpdir(), join(dir, "out"), "junction").then(() => true, () => false);
    if (linked) await expect(insideCheckout(dir, "out")).rejects.toThrow(/symlink|outside/);
  });
});

const TUNNEL = { ingress: "cloudflare_tunnel" } as const;

describe("routes", () => {
  it("renders byte-stable files and reserves the dashboard host", () => {
    const t = { appId: "a1", hosts: ["shop.example.com"], port: 3000, backend: "dk-route-d1" };
    expect(renderRoute(t, "dash.example.com", TUNNEL)).toBe(renderRoute(t, "dash.example.com", TUNNEL));
    expect(() => renderRoute({ ...t, hosts: ["dash.example.com"] }, "dash.example.com", TUNNEL)).toThrow(ReservedHostError);
    expect(() => renderRoute({ ...t, hosts: ["bad host"] }, "", TUNNEL)).toThrow(ReservedHostError);
    expect(() => renderRoute({ ...t, backend: "evil:1/x" }, "", TUNNEL)).toThrow();
    // A name a tenant could hold is never a backend: only Dockify's dk- names, or an address.
    expect(() => renderRoute({ ...t, backend: "web" }, "", TUNNEL)).toThrow(/dk- container name/);
  });
  it("writes atomically, skips unchanged content, and moves a host between apps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dk-routes-"));
    const store = fileRouteStore(dir);
    const a = { appId: "a", hosts: ["x.example.com", "y.example.com"], port: 80, backend: "dk-route-da" };
    expect(await writeRoute(store, a, "", TUNNEL)).toBe(true);
    expect(await writeRoute(store, a, "", TUNNEL)).toBe(false);
    expect(await routedBackend(store, "a")).toBe("dk-route-da");
    expect([...(await routedHosts(store, "a"))].sort()).toEqual(["x.example.com", "y.example.com"]);
    await writeRoute(store, { appId: "b", hosts: ["y.example.com"], port: 80, backend: "10.0.0.3" }, "", TUNNEL);
    expect(await routedBackend(store, "b")).toBe("10.0.0.3");
    const fileA = await readFile(join(dir, "conf", "a.yml"), "utf8");
    expect(fileA).toContain("x.example.com");
    expect(fileA).not.toContain("y.example.com");
  });
});

describe("janitor retention", () => {
  const d = (id: string, appId: string, status: string, day: number, imageId: string | null = `sha256:${id}`) => ({ id, appId, status, imageId, createdAt: new Date(Date.UTC(2026, 0, day)) });
  it("keeps the last N ready, current and in-flight deployments and their images", () => {
    const rows = [d("r1", "a", "ready", 1), d("r2", "a", "ready", 2), d("r3", "a", "ready", 3), d("f1", "a", "failed", 4), d("q1", "a", "building", 5), d("old", "b", "ready", 1)];
    const plan = computeRetention(rows, new Set(["r1"]), 1, new Date(Date.UTC(2026, 0, 10)));
    expect([...plan.keepImages].sort()).toEqual(["sha256:old", "sha256:q1", "sha256:r1", "sha256:r3"]);
    expect(plan.deleteDeployments.sort()).toEqual(["f1", "r2"]);
  });
  it("respects the retention window", () => {
    const plan = computeRetention([d("f1", "a", "failed", 9)], new Set(), 5, new Date(Date.UTC(2026, 0, 5)));
    expect(plan.deleteDeployments).toEqual([]);
  });
  it("prunes the cache to a size, never wiping it", () => {
    expect(pruneArgs("tcp://b:1", 20 * 1024 ** 3)).toEqual(["--addr", "tcp://b:1", "prune", "--keep-storage", "20480"]);
  });
});

describe("docker client helpers", () => {
  it("parses DOCKER_HOST", () => {
    expect(parseDockerHost(undefined)).toEqual({ socketPath: "/var/run/docker.sock" });
    expect(parseDockerHost("tcp://socket-proxy:2375")).toEqual({ host: "socket-proxy", port: 2375 });
    expect(() => parseDockerHost("http://x")).toThrow();
  });
  it("demultiplexes frames split across chunks", () => {
    const frame = (k: number, s: string) => Buffer.concat([Buffer.from([k, 0, 0, 0, 0, 0, 0, s.length]), Buffer.from(s)]);
    const all = Buffer.concat([frame(1, "out"), frame(2, "err")]);
    const got: string[] = [];
    const dm = new Demuxer();
    dm.push(all.subarray(0, 5), (k, b) => got.push(`${k}:${b}`));
    dm.push(all.subarray(5), (k, b) => got.push(`${k}:${b}`));
    expect(got).toEqual(["stdout:out", "stderr:err"]);
  });
});

describe("container input", () => {
  const app: RunnableApp = {
    id: "0f0e0d0c-0000-4000-8000-000000000001", kind: "backend", environmentId: "0f0e0d0c-0000-4000-8000-000000000002", projectId: "p",
    port: 3000, startCommand: "node server.js", memoryLimitMb: 256, cpuLimit: null, pidsLimit: null, capAdd: [], sysctls: {},
    volumes: [{ id: "v", name: "dk-data", mountPath: "/data" }],
  };
  it("goes through containerSpec for the app and the release one-off", () => {
    const appSpec = containerSpec(appContainerInput(app, { name: canonicalName(app.id), imageId: `sha256:${"a".repeat(64)}`, env: { A: "1" }, deploymentId: "d", role: "app" }), 8);
    expect(appSpec.HostConfig.Mounts).toHaveLength(1);
    expect(appSpec.HostConfig.RestartPolicy.Name).toBe("unless-stopped");
    const rel = containerSpec(appContainerInput(app, { name: "dk-rel", imageId: `sha256:${"a".repeat(64)}`, env: {}, deploymentId: "d", role: "release", cmd: "npx prisma migrate deploy" }), 8);
    expect(rel.HostConfig.Mounts).toHaveLength(0);
    expect(rel.HostConfig.RestartPolicy.Name).toBe("no");
    expect(rel.Entrypoint).toEqual(["npx"]);
    expect(rel.Cmd).toEqual(["prisma", "migrate", "deploy"]);
  });

  it("the serving container answers to the app's name on its environment network; a release or a job never does", () => {
    const named = { ...app, name: "api" };
    const image = `sha256:${"a".repeat(64)}`;
    const net = `dockify-env-${app.environmentId}`;
    const serving = containerSpec(appContainerInput(named, { name: canonicalName(app.id), imageId: image, env: {}, deploymentId: "d1", role: "app" }), 8);
    expect(serving.NetworkingConfig.EndpointsConfig[net]?.Aliases).toEqual([canonicalName(app.id), routeAlias("d1"), "api"]);
    for (const role of ["release", "job"] as const) {
      const one = containerSpec(appContainerInput(named, { name: "dk-one", imageId: image, env: {}, deploymentId: "d1", role, cmd: "true" }), 8);
      expect(one.NetworkingConfig.EndpointsConfig[net]?.Aliases).toEqual([]);
    }
    // A row from before the AppName rule, with the reserved prefix, takes no alias it could answer a route with.
    expect(appAliases({ id: app.id, name: "dk-route-x" }, "d1")).toEqual([canonicalName(app.id), routeAlias("d1")]);
    expect(appAliases({ id: app.id }, "d1")).toEqual([canonicalName(app.id), routeAlias("d1")]);
  });

  it("a rollback keeps a hook key's current value, as it does a secret's", () => {
    const v = (key: string, value: string, isSecret = false) => ({ key, value, isSecret, target: "both" as const });
    const out = rollbackEnv([v("NODE_OPTIONS", "--require /old.js"), v("PLAIN", "old"), v("LD_PRELOAD", "/same.so")], [v("NODE_OPTIONS", "--max-old-space-size=512"), v("PLAIN", "new"), v("LD_PRELOAD", "/same.so")]);
    const after = Object.fromEntries(out.vars.map((x) => [x.key, x.value]));
    expect(after).toEqual({ NODE_OPTIONS: "--max-old-space-size=512", PLAIN: "old", LD_PRELOAD: "/same.so" });
    expect(out.secretsKeptCurrent).toEqual(["NODE_OPTIONS"]);
  });

  it("runs the start command in place of the image's ENTRYPOINT, and leaves the image alone without one", () => {
    const image = `sha256:${"a".repeat(64)}`;
    const withCmd = containerSpec(appContainerInput(app, { name: canonicalName(app.id), imageId: image, env: {}, deploymentId: "d", role: "app" }), 8);
    // As Docker runs it: node server.js, whatever ENTRYPOINT the image declares, with no shell.
    expect([...(withCmd.Entrypoint ?? []), ...(withCmd.Cmd ?? [])]).toEqual(["node", "server.js"]);
    const plain = containerSpec(appContainerInput({ ...app, startCommand: null }, { name: canonicalName(app.id), imageId: image, env: {}, deploymentId: "d", role: "app" }), 8);
    expect(plain.Entrypoint).toBeUndefined();
    expect(plain.Cmd).toBeUndefined();
  });
});
