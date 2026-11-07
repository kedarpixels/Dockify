/**
 * Regressions from a security review: fork code on
 * the base network, the JSON frontend directive, label spoofing, the probe deadline, CPU and disk
 * limits, the worker's liveness file, and the metric insert race.
 */
import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { defaultCpuCores } from "@dockify/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { assertSafeSpec, containerSpec, TENANT_CPU_SHARES } from "@dockify/engine";
import { checkSyntaxDirective } from "@dockify/engine";
import { appContainerInput, type RunnableApp } from "./deploy/containers.ts";
import { assertRoomToBuild, DiskReserve, diskVerdict, type DiskFs } from "./deploy/disk-guard.ts";
import type { DockerApi } from "@dockify/engine";
import { PermanentDeployError } from "@dockify/engine";
import { previewReleaseInput, type PreviewContext } from "./deploy/preview.ts";
import { runReleaseCommand } from "./deploy/release-command.ts";
import { nodeProbeFetch } from "./edge/probe.ts";
import { aliveNow, AliveFile, WorkerHealth } from "./health.ts";
import { readControlPlane } from "./observe/control-plane.ts";
import type { DockerReader } from "./observe/docker.ts";
import { insertSamples } from "./observe/sampler.ts";
import { resetPasswordSql } from "./data/managed.ts";
import { Redactor } from "@dockify/redact";

const compose = () => readFile(new URL("../../../deploy/docker-compose.yml", import.meta.url), "utf8");
const serviceBlock = (text: string, name: string) => {
  const m = new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}\\S|^\\S)`, "m").exec(text);
  expect(m, `compose has ${name}`).not.toBeNull();
  return (m?.[1] ?? "").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
};

const app: RunnableApp = {
  id: "a1", kind: "backend", environmentId: "e1", projectId: "p1", port: 3000, startCommand: null,
  memoryLimitMb: 256, cpuLimit: null, pidsLimit: null, capAdd: ["NET_ADMIN"], sysctls: { "net.ipv4.ip_forward": "1" }, volumes: [{ id: "v", name: "dk-vol", mountPath: "/data" }],
};
const forkCtx: PreviewContext = {
  pdId: "pd1", envId: "env1", projectId: "p1", prNumber: 7, hostname: "pr-7.preview.example.com", fromFork: true, isolatedDb: true, isolation: "fork",
  network: "dockify-pv-forks", limits: { cpu: 0.5, memoryMb: 128, pids: 64 },
};

describe("control-plane addresses never go through a name a tenant network can answer", () => {
  it("the agent reaches Docker, and everyone the database, by fixed addresses", async () => {
    const text = await compose();
    const agent = serviceBlock(text, "agent");
    expect(agent).toMatch(/DOCKER_HOST: tcp:\/\/172\.30\.4\.2:2375/);
    expect(text).toMatch(/DOCKIFY_DB_HOST: 172\.30\.3\.2/);
    expect(agent).not.toMatch(/socket-proxy:2375|dockify-proxy:8082/);
  });

  it("the worker holds nothing that leads onto the host", async () => {
    const worker = serviceBlock(await compose(), "worker");
    for (const gone of [/DOCKER_HOST/, /BUILDKIT_HOST/, /DOCKIFY_PROXY_DIR/, /DOCKIFY_ROUTES_DIR/, /DOCKIFY_WORKER_CONTAINER/, /DOCKIFY_PROXY_METRICS_URL/, /DOCKIFY_PROBE_PROXY_URL/, /docker-api:/, /\bdeploy: \{\}/, /\.\/proxy:/, /\.\/buildkit:/, /docker\.sock/]) {
      expect(worker, String(gone)).not.toMatch(gone);
    }
  });

  it("the agent holds nothing of the control plane's, and no way past its own limits", async () => {
    const agent = serviceBlock(await compose(), "agent");
    for (const gone of [/postgres_password/, /master_key/, /internal_token/, /DATABASE_URL/, /DOCKIFY_DB_/, /docker\.sock/, /link_key/, /\bcontrol:/, /\bdata:/, /\begress:/, /privileged/, /cap_add/]) {
      expect(agent, String(gone)).not.toMatch(gone);
    }
    expect(agent).toMatch(/<<: \*control/);
    expect(agent).toMatch(/mem_limit: 512m/);
    expect(agent).toMatch(/link: \{ ipv4_address: 172\.30\.5\.30 \}/);
  });

  it("the link network is private, and neither end's address can be taken", async () => {
    const text = await compose();
    expect(serviceBlock(text, "worker")).toMatch(/link: \{ ipv4_address: 172\.30\.5\.20 \}/);
    const nets = text.slice(text.indexOf("\nnetworks:\n"));
    expect(nets).toMatch(/link:\n\s+internal: true\n\s+ipam:\n\s+config: \[\{ subnet: 172\.30\.5\.0\/24, ip_range: 172\.30\.5\.128\/25 \}\]/);
    for (const other of ["api", "web", "postgres", "updater", "proxy-direct", "cloudflared", "buildkit"]) expect(serviceBlock(text, other), other).not.toMatch(/\blink:/);
  });

  it("postgres and the socket proxy hold those addresses, and dynamic members stay out of the range they sit in", async () => {
    const text = await compose();
    expect(serviceBlock(text, "postgres")).toMatch(/data: \{ ipv4_address: 172\.30\.3\.2 \}/);
    expect(serviceBlock(text, "socket-proxy")).toMatch(/docker-api: \{ ipv4_address: 172\.30\.4\.2 \}/);
    const nets = text.slice(text.indexOf("\nnetworks:\n"));
    expect(nets).toMatch(/subnet: 172\.30\.3\.0\/24, ip_range: 172\.30\.3\.128\/25/);
    expect(nets).toMatch(/subnet: 172\.30\.4\.0\/24, ip_range: 172\.30\.4\.128\/25/);
  });

  it("the database's clients are all on the data network", async () => {
    const text = await compose();
    for (const s of ["migrate", "api", "worker", "updater"]) expect(serviceBlock(text, s), s).toMatch(/\bdata\b/);
    expect(serviceBlock(text, "web")).not.toMatch(/\bdata\b/);
  });
});

describe("a custom BuildKit frontend, however it is asked for", () => {
  const evil = "docker.io/attacker/frontend:1";
  it("refuses the JSON directive", () => {
    for (const df of [
      `{"syntax":"${evil}"}`,
      `﻿{"syntax":"${evil}"}\n`,
      `#!/usr/bin/env dockerfile\n{"syntax":"${evil}"}`,
      `{\n  "x": "y",\n  "syntax": "${evil}"\n}\n`,
      `{"s\\u0079ntax":"${evil}"}`,
      `{"SYNTAX":"${evil}"}`,
    ]) expect(() => checkSyntaxDirective(df), df).toThrow(PermanentDeployError);
  });

  it("allows the official frontend in JSON, and a file that only looks like JSON", () => {
    expect(() => checkSyntaxDirective(`{"syntax":"docker/dockerfile:1"}`)).not.toThrow();
    for (const df of ["{not json", "[1,2]", "FROM node:22\n", `{"other":"x"}`]) expect(() => checkSyntaxDirective(df), df).not.toThrow();
  });

  it("sets the gate on the daemon, from the signed compose file", async () => {
    const text = await compose();
    const svc = serviceBlock(text, "buildkit");
    expect(svc).toMatch(/"--config", "\/etc\/buildkit\/buildkitd\.toml"/);
    expect(svc).toMatch(/source: buildkitd/);
    expect(text).toMatch(/\[frontend\."gateway\.v0"\]\s+enabled = true\s+allowedRepositories = \["docker\.io\/docker\/dockerfile", "ghcr\.io\/railwayapp\/railpack-frontend"\]/);
  });
});

describe("fork code gets the preview's isolation in every container", () => {
  it("runs a preview's release command on the preview's network, with no capability and preview limits", () => {
    const input = previewReleaseInput(forkCtx, { name: "dk-a1-release-12345678", imageId: "sha256:" + "a".repeat(64), env: { A: "1" }, deploymentId: "12345678-0000", command: "npx prisma migrate deploy" });
    const spec = containerSpec(input, 8);
    expect(spec.HostConfig.NetworkMode).toBe("dockify-pv-forks");
    expect(Object.keys(spec.NetworkingConfig.EndpointsConfig)).toEqual(["dockify-pv-forks"]);
    expect(spec.HostConfig.CapAdd).not.toContain("NET_ADMIN");
    expect(spec.HostConfig.Sysctls).toBeUndefined();
    expect(spec.HostConfig.Memory).toBe(128 * 1024 * 1024);
    expect(spec.HostConfig.NanoCpus).toBe(0.5e9);
    expect(spec.HostConfig.PidsLimit).toBe(64);
    expect(spec.HostConfig.Mounts).toEqual([]);
    expect(spec.HostConfig.RestartPolicy.Name).toBe("no");
    expect(spec.Labels).toMatchObject({ "dockify.preview": "env1", "dockify.preview.app": "pd1", "dockify.role": "preview-release", "dockify.app": "" });
  });

  it("the release step creates what it is given, and the app's own builder is not used for a preview", async () => {
    const created: Array<{ network: string; capAdd: readonly string[] | undefined }> = [];
    const docker = {
      removeContainer: async () => {},
      createContainer: async (_n: string, i: { network: string; capAdd?: readonly string[] }) => { created.push({ network: i.network, capAdd: i.capAdd }); return "c1"; },
      startContainer: async () => {},
      waitContainer: async () => 0,
      logs: async () => (async function* () {})(),
    } as unknown as DockerApi;
    const log = { system: () => {}, error: () => {}, splitter: () => ({ push: () => {}, end: () => {} }), redactor: { line: (l: string) => l } };
    await runReleaseCommand(docker, app, {
      command: "migrate", imageId: "sha256:" + "a".repeat(64), env: {}, deploymentId: "12345678-0000", timeoutMs: 1000,
      input: (name, command) => previewReleaseInput(forkCtx, { name, command, imageId: "sha256:" + "a".repeat(64), env: {}, deploymentId: "12345678-0000" }),
    }, log as never, new AbortController().signal);
    expect(created).toEqual([{ network: "dockify-pv-forks", capAdd: [] }]);
  });
});

describe("an image's labels never reach the container's", () => {
  it("blanks Compose's and Dockify's keys unless the body sets them", () => {
    const { Labels } = containerSpec({ name: "dk-a", image: "alpine:3", network: "dockify-env-a", labels: { "dockify.app": "a1" } }, 8);
    for (const k of ["com.docker.compose.project", "com.docker.compose.service", "com.docker.compose.oneoff", "com.docker.compose.container-number", "dockify.preview", "dockify.preview.app", "dockify.role", "dockify.deployment", "dockify.environment", "dockify.project"]) {
      expect(Labels[k], k).toBe("");
    }
    expect(Labels["dockify.app"]).toBe("a1");
    expect(Labels["dockify.managed"]).toBe("true");
  });

  it("the final body check refuses a create that would let the image's Compose labels through", () => {
    const spec = containerSpec({ name: "dk-a", image: "alpine:3", network: "dockify-env-a" }, 8);
    expect(() => assertSafeSpec(spec)).not.toThrow();
    const { "com.docker.compose.project": _gone, ...rest } = spec.Labels;
    expect(() => assertSafeSpec({ ...spec, Labels: rest })).toThrow(/com\.docker\.compose\.project/);
    expect(() => assertSafeSpec({ ...spec, Labels: { ...spec.Labels, "com.docker.compose.service": "postgres" } })).toThrow(/com\.docker\.compose\.service/);
  });

  it("the Server page never lists a tenant container as a control service", async () => {
    const row = (id: string, labels: Record<string, string>) => ({ Id: id, State: "running", Labels: labels });
    const list = [
      row("real", { "com.docker.compose.project": "dockify", "com.docker.compose.service": "postgres" }),
      row("fake", { "com.docker.compose.project": "dockify", "com.docker.compose.service": "postgres", "dockify.managed": "true" }),
    ];
    const docker = {
      listFiltered: async (f: Record<string, string[]>) => (f.name ? [row("w", { "com.docker.compose.project": "dockify" })] : list),
      inspect: async () => ({ State: { Status: "running", StartedAt: "" } }),
    } as unknown as DockerReader;
    expect(await readControlPlane(docker, "dockify-worker")).toHaveLength(1);
  });
});

describe("the domain probe has a deadline for the whole exchange", () => {
  let server: Server | null = null;
  afterEach(() => { server?.closeAllConnections(); server?.close(); server = null; });

  it("gives up on a server that drips its headers, well before the idle timeout could fire", async () => {
    server = createServer();
    server.on("connection", (s) => {
      s.write("HTTP/1.1 200 OK\r\nX-Drip: ");
      const t = setInterval(() => { if (!s.destroyed) s.write("a"); }, 20);
      s.on("close", () => clearInterval(t));
      s.on("error", () => clearInterval(t));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const started = Date.now();
    await expect(nodeProbeFetch(new URL(`http://127.0.0.1:${port}/x`), 300)).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("also stops a body that drips after the headers", async () => {
    server = createServer((_q, res) => {
      res.writeHead(200);
      const t = setInterval(() => res.write("a"), 20);
      res.on("close", () => clearInterval(t));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const started = Date.now();
    const out = await nodeProbeFetch(new URL(`http://127.0.0.1:${port}/x`), 300).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out).toBeDefined();
  });
});

describe("a tenant container always has a CPU limit", () => {
  it("defaultCpuCores leaves a core free, and never asks for less than one", () => {
    expect(defaultCpuCores(1)).toBe(1);
    expect(defaultCpuCores(2)).toBe(1);
    expect(defaultCpuCores(8)).toBe(7);
    expect(defaultCpuCores(0)).toBe(1);
    expect(defaultCpuCores(200)).toBe(64);
  });

  it("an app with no limit of its own gets the default, and its own limit wins", () => {
    const base = { name: "dk-a", image: "alpine:3", network: "dockify-env-a" };
    expect(containerSpec(base, 8).HostConfig.NanoCpus).toBe(defaultCpuCores(8) * 1e9);
    expect(containerSpec({ ...base, cpuCores: 0.25 }, 8).HostConfig.NanoCpus).toBe(0.25e9);
    // Its own limit needs no count. With neither, it is refused: a guess would read the wrong machine.
    expect(containerSpec({ ...base, cpuCores: 0.25 }).HostConfig.NanoCpus).toBe(0.25e9);
    expect(() => containerSpec(base)).toThrow(/core count is not known/);
    expect(() => containerSpec(base, null)).toThrow(/core count is not known/);
  });

  it("tenants weigh less than the control plane when the CPU is contended, and memory is untouched", () => {
    const spec = containerSpec(appContainerInput(app, { name: "dk-a1", imageId: "sha256:" + "a".repeat(64), env: {}, deploymentId: "d", role: "app" }), 8);
    expect(spec.HostConfig.CpuShares).toBe(TENANT_CPU_SHARES);
    expect(TENANT_CPU_SHARES).toBeLessThan(1024);
    expect(spec.HostConfig.Memory).toBe(256 * 1024 * 1024);
    expect(spec.HostConfig.NanoCpus).toBeGreaterThan(0);
  });

  it("the final body check needs a CPU limit", () => {
    const spec = containerSpec({ name: "dk-a", image: "alpine:3", network: "dockify-env-a" }, 8);
    const { NanoCpus: _n, ...hc } = spec.HostConfig;
    expect(() => assertSafeSpec({ ...spec, HostConfig: hc })).toThrow(/cpu limit/i);
  });
});

describe("the disk guard", () => {
  const GiB = 1024 ** 3;
  it("reads a disk as low under 5 percent or 3 GiB, whichever is larger", () => {
    expect(diskVerdict({ freeBytes: 30 * GiB, totalBytes: 100 * GiB }).low).toBe(false);
    expect(diskVerdict({ freeBytes: 4 * GiB, totalBytes: 100 * GiB }).low).toBe(true);
    expect(diskVerdict({ freeBytes: 2.5 * GiB, totalBytes: 20 * GiB }).low).toBe(true);
    expect(diskVerdict({ freeBytes: 3.5 * GiB, totalBytes: 20 * GiB }).low).toBe(false);
  });

  it("refuses a new build near full, permanently and saying why", async () => {
    await expect(assertRoomToBuild(async () => ({ freeBytes: 1 * GiB, totalBytes: 50 * GiB }))).rejects.toThrow(PermanentDeployError);
    await expect(assertRoomToBuild(async () => ({ freeBytes: 1 * GiB, totalBytes: 50 * GiB }))).rejects.toThrow(/1\.0 GiB free/);
    await expect(assertRoomToBuild(async () => ({ freeBytes: 20 * GiB, totalBytes: 50 * GiB }))).resolves.toBeUndefined();
  });

  it("a disk it cannot read never stops a build", async () => {
    await expect(assertRoomToBuild(async () => { throw new Error("EIO"); })).resolves.toBeUndefined();
  });

  function fakeFs(usage: { freeBytes: number; totalBytes: number }) {
    const made: Array<[string, number]> = [];
    const gone: string[] = [];
    let present = false;
    const fs: DiskFs = {
      usage: async () => usage,
      exists: async () => present,
      create: async (p, bytes) => { made.push([p, bytes]); present = true; usage.freeBytes -= bytes; },
      remove: async (p) => { gone.push(p); present = false; },
    };
    return { fs, made, gone };
  }

  it("keeps a reserve for the control plane, gives it up near full, and reports the issue", async () => {
    const usage = { freeBytes: 40 * GiB, totalBytes: 100 * GiB };
    const { fs, made, gone } = fakeFs(usage);
    const health = new WorkerHealth();
    const reserve = new DiskReserve({ path: "/w/.reserve", fs, health, log: () => {} });

    await reserve.tick();
    expect(made).toEqual([["/w/.reserve", GiB]]);
    expect(health.list()).toEqual([]);

    usage.freeBytes = 0.5 * GiB;
    await reserve.tick();
    expect(gone).toEqual(["/w/.reserve"]);
    expect(health.list().map((i) => i.key)).toEqual(["disk_low"]);

    // Not made again until there is room for it above the floor.
    usage.freeBytes = 3.5 * GiB;
    await reserve.tick();
    expect(made).toHaveLength(1);

    usage.freeBytes = 50 * GiB;
    await reserve.tick();
    expect(made).toHaveLength(2);
    expect(health.list()).toEqual([]);
  });

  it("a small disk reserves less", async () => {
    const { fs, made } = fakeFs({ freeBytes: 15 * GiB, totalBytes: 20 * GiB });
    await new DiskReserve({ path: "/w/.reserve", fs, health: new WorkerHealth(), log: () => {} }).tick();
    expect(made[0]?.[1]).toBe(Math.floor(20 * GiB * 0.02));
  });

  it("every Dockify service and tenant container has a log size cap", async () => {
    const text = await compose();
    for (const s of ["postgres", "socket-proxy", "buildkit", "web", "proxy", "proxy-direct", "cloudflared"]) expect(serviceBlock(text, s), s).toMatch(/logging: \*logging/);
    expect(text).toMatch(/options: \{ max-size: "10m", max-file: "3" \}/);
    const spec = containerSpec({ name: "dk-a", image: "alpine:3", network: "dockify-env-a" }, 8);
    expect(spec.HostConfig.LogConfig.Config).toEqual({ "max-size": "10m", "max-file": "3" });
  });
});

describe("the worker's liveness", () => {
  it("is alive while booting, and afterwards only while its heartbeat lands", () => {
    expect(aliveNow({ booted: false, lastBeatMs: null, nowMs: 1_000_000 })).toBe(true);
    expect(aliveNow({ booted: true, lastBeatMs: 1_000_000, nowMs: 1_060_000 })).toBe(true);
    expect(aliveNow({ booted: true, lastBeatMs: 1_000_000, nowMs: 1_000_000 + 121_000 })).toBe(false);
    expect(aliveNow({ booted: true, lastBeatMs: null, nowMs: 1_000_000 })).toBe(true);
  });

  it("touches the file while alive and leaves it to go stale when not", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dk-alive-"));
    try {
      const file = path.join(dir, "alive");
      const alive = new AliveFile(file);
      await alive.touch(1_000_000);
      const first = (await stat(file)).mtimeMs;
      const old = new Date(Date.now() - 600_000);
      await utimes(file, old, old);
      alive.booted();
      alive.beat(1_000_000);
      await alive.touch(1_000_000 + 121_000);
      expect((await stat(file)).mtimeMs).toBeLessThan(first);
      await alive.touch(1_000_010);
      expect((await stat(file)).mtimeMs).toBeGreaterThan(old.getTime());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("compose gives the worker a real healthcheck on that file", async () => {
    const worker = serviceBlock(await compose(), "worker");
    expect(worker).toMatch(/healthcheck:/);
    expect(worker).toMatch(/\/tmp\/dockify-worker-alive/);
  });
});

describe("a metric sample for an app that was just deleted", () => {
  const row = (appId: string) => ({ appId, at: new Date(0) }) as never;
  const fk = Object.assign(new Error("Foreign key constraint violated"), { code: "P2003" });

  it("drops that row and keeps the others", async () => {
    const written: string[][] = [];
    const db = {
      metricSample: {
        createMany: async ({ data }: { data: Array<{ appId: string }> }) => {
          if (data.some((d) => d.appId === "gone")) throw fk;
          written.push(data.map((d) => d.appId));
          return { count: data.length };
        },
      },
      app: { findMany: async () => [{ id: "a" }, { id: "b" }] },
    } as never;
    await insertSamples(db, [row("a"), row("gone"), row("b")]);
    expect(written).toEqual([["a", "b"]]);
  });

  it("still throws anything else", async () => {
    const db = { metricSample: { createMany: async () => { throw new Error("connection lost"); } }, app: { findMany: async () => [{ id: "a" }] } } as never;
    await expect(insertSamples(db, [row("a")])).rejects.toThrow(/connection lost/);
  });

  it("keeps going while a project delete removes apps one by one, and drops the tick rather than throw", async () => {
    const kept: unknown[] = [];
    let live = ["a", "b", "c"];
    const fk = Object.assign(new Error("Foreign key constraint violated"), { code: "P2003" });
    const racing = {
      metricSample: { createMany: async ({ data }: { data: Array<{ appId: string }> }) => {
        if (data.some((r) => !live.includes(r.appId))) throw fk;
        kept.push(...data);
        live = live.slice(1);
        return { count: data.length };
      } },
      app: { findMany: async () => {
        const answer = live.map((id) => ({ id }));
        live = live.slice(1);
        return answer;
      } },
    } as never;
    await expect(insertSamples(racing, [row("a"), row("b"), row("c"), row("gone")])).resolves.toBeUndefined();
    const always = { metricSample: { createMany: async () => { throw fk; } }, app: { findMany: async () => [{ id: "a" }] } } as never;
    await expect(insertSamples(always, [row("a")])).resolves.toBeUndefined();
  });
});

describe("a failed adoption keeps the service password out of what viewers read", () => {
  const creds = { user: "app", password: "abcdefghijklmnopqrstuvwxyz012345" };
  it("the redactor hides a statement's PASSWORD literal", () => {
    const sql = resetPasswordSql(creds as never);
    const line = sql.split("\n").find((l) => l.includes("ALTER ROLE"))!;
    const out = new Redactor().line(`CONTEXT: SQL statement "${line.trim()}"`);
    expect(out).not.toContain(creds.password);
    expect(out).toMatch(/PASSWORD/);
  });
});
