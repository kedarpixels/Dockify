import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { containerSpec, type ContainerInput } from "@dockify/engine";
import { appContainerInput, commandInput, imageArguments, plainWords, type RunnableApp } from "./containers.ts";
import { DockerError, type ContainerInfo, type DockerApi } from "@dockify/engine";
import { couldNotRun, explainFailure, lastOutput } from "./failure.ts";
import { DeployLog } from "./log.ts";
import { runReleaseCommand } from "./release-command.ts";
import { RolledBackError, swap, type SwapApp } from "./swap.ts";
import { fileRouteStore } from "@dockify/engine";

const IMG = `sha256:${"b".repeat(64)}`;
const APP = "0f0e0d0c-0000-4000-8000-0000000000aa";
const ENV = "0f0e0d0c-0000-4000-8000-0000000000bb";
const TINI = "[FATAL tini (7)] exec sh failed: No such file or directory";

const frame = (text: string, kind = 2) => {
  const body = Buffer.from(text);
  const h = Buffer.alloc(8);
  h[0] = kind;
  h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body]);
};

describe("how a command runs", () => {
  const argv = (c: string) => {
    const s = commandInput(c);
    return { entrypoint: s.entrypoint, cmd: s.cmd };
  };

  it("runs a plain command directly, with no shell", () => {
    expect(argv("node server.js --port 3000")).toEqual({ entrypoint: ["node"], cmd: ["server.js", "--port", "3000"] });
    expect(argv("/usr/bin/app")).toEqual({ entrypoint: ["/usr/bin/app"], cmd: [] });
    expect(argv("  npx   prisma migrate deploy ")).toEqual({ entrypoint: ["npx"], cmd: ["prisma", "migrate", "deploy"] });
  });

  it("does not take an = inside a word for shell syntax", () => {
    expect(argv("node server.js --port=3000")).toEqual({ entrypoint: ["node"], cmd: ["server.js", "--port=3000"] });
    expect(argv("--name=v2")).toEqual({ entrypoint: undefined, cmd: ["--name=v2"] });
  });

  it("gives flags to the image's own entrypoint: what whoami's saved --name v2-build always meant", () => {
    expect(argv("--name v2-build")).toEqual({ entrypoint: undefined, cmd: ["--name", "v2-build"] });
    expect(argv("-c /etc/app.conf")).toEqual({ entrypoint: undefined, cmd: ["-c", "/etc/app.conf"] });
  });

  it.each([
    "echo a && sleep 1", "a || b", "a; b", "a | b", "a > /tmp/x", "a < /tmp/x", "echo $HOME", "echo `date`", "echo $(date)",
    'echo "a b"', "echo 'a b'", "ls *.js", "ls ?.js", "a &", "(a)", "ls [ab]", "echo ~", "FOO=bar node x", "echo {a,b}", "a # note", "! a", "a \\b",
  ])("uses a shell for shell syntax: %s", (c) => {
    expect(argv(c)).toEqual({ entrypoint: ["sh", "-c"], cmd: [c] });
  });

  it.each(["exec node server.js", "cd /app", "export A", ". ./env", "source x", "set -e"])("uses a shell for a word only a shell knows: %s", (c) => {
    expect(argv(c).entrypoint).toEqual(["sh", "-c"]);
  });

  it("goes through containerSpec for the app and its release one-off", () => {
    const app: RunnableApp = { id: APP, kind: "backend", environmentId: ENV, projectId: "p", port: 3000, startCommand: "node server.js", memoryLimitMb: null, cpuLimit: null, pidsLimit: null, capAdd: [], sysctls: {}, volumes: [] };
    const a = containerSpec(appContainerInput(app, { name: "dk-a", imageId: IMG, env: {}, deploymentId: "d", role: "app" }), 4);
    expect(a.Entrypoint).toEqual(["node"]);
    expect(a.Cmd).toEqual(["server.js"]);
    const flags = containerSpec(appContainerInput({ ...app, startCommand: "--name v2" }, { name: "dk-a", imageId: IMG, env: {}, deploymentId: "d", role: "app" }), 4);
    expect(flags.Entrypoint).toBeUndefined();
    expect(flags.Cmd).toEqual(["--name", "v2"]);
    const blank = containerSpec(appContainerInput({ ...app, startCommand: null }, { name: "dk-a", imageId: IMG, env: {}, deploymentId: "d", role: "app" }), 4);
    expect(blank.Entrypoint).toBeUndefined();
    expect(blank.Cmd).toBeUndefined();
  });

  it("offers a plain subcommand as image arguments, and nothing else", () => {
    expect(imageArguments("server /data")).toEqual({ cmd: ["server", "/data"] });
    expect(imageArguments("--name x")).toBeNull();
    expect(imageArguments("a && b")).toBeNull();
    expect(plainWords("   ")).toBeNull();
  });
});

describe("the reason a container did not start", () => {
  it("reads init's own line and the runtime's message as could-not-run, and a program's own 127 as not", () => {
    expect(couldNotRun({ exitCode: 127, stateError: null, output: [TINI] })).toBe(true);
    expect(couldNotRun({ exitCode: 126, stateError: null, output: ["[FATAL tini (7)] exec /x failed: Permission denied"] })).toBe(true);
    expect(couldNotRun({ exitCode: 1, stateError: 'exec: "sh": executable file not found in $PATH', output: [] })).toBe(true);
    expect(couldNotRun({ exitCode: 127, stateError: null, output: ["my-script: line 3: foo: command not found"] })).toBe(false);
    expect(couldNotRun({ exitCode: 1, stateError: null, output: ["Error: listen EADDRINUSE"] })).toBe(false);
  });

  it("says a shell command needs a shell the image lacks", () => {
    const why = explainFailure({ command: "echo hi && sleep 9", exitCode: 127, stateError: null, output: [TINI] });
    expect(why).toMatch(/no shell/);
    expect(why).toContain(TINI);
  });

  it("names a program that is not in the image, and quotes real output otherwise", () => {
    expect(explainFailure({ command: "nod server.js", exitCode: 127, stateError: null, output: ["[FATAL tini (7)] exec nod failed: No such file or directory"] })).toMatch(/^nod is not a program/);
    expect(explainFailure({ command: null, exitCode: 1, stateError: null, output: ["Error: boom"] })).toBe("Its last output: Error: boom");
    expect(explainFailure({ command: null, exitCode: 3, stateError: null, output: [] })).toBe("It exited with code 3 and wrote nothing.");
    expect(explainFailure({ command: null, exitCode: null, stateError: null, output: [] })).toBe("");
  });

  it("keeps the last lines, redacted, and survives a container whose logs cannot be read", async () => {
    const docker = { logs: async () => Readable.from([frame("one\ntwo\nsecret-value\n")]) } as unknown as DockerApi;
    expect(await lastOutput(docker, "c", (l) => l.replace("secret-value", "***"))).toEqual(["one", "two", "***"]);
    const broken = { logs: async () => { throw new DockerError(500, "no"); } } as unknown as DockerApi;
    expect(await lastOutput(broken, "c")).toEqual([]);
  });
});

/** A daemon where each created container behaves as `behave` says, by the spec it was given. */
function daemon(behave: (input: ContainerInput) => { exit: number; output: string } | null, entrypoint: string[] | null) {
  const created: ContainerInput[] = [];
  const removed: Array<{ id: string; volumes: boolean }> = [];
  const containers = new Map<string, { name: string; input?: ContainerInput; running: boolean }>();
  let next = 1;
  const find = (ref: string) => {
    for (const [id, c] of containers) if (id === ref || c.name === ref) return { id, c };
    throw new DockerError(404, "no such container");
  };
  const docker = {
    async inspectContainer(ref: string): Promise<ContainerInfo> {
      const { id, c } = find(ref);
      const outcome = c.input ? behave(c.input) : null;
      return {
        Id: id, Name: `/${c.name}`, Image: "sha256:x", RestartCount: 0,
        State: { Status: outcome ? "exited" : "running", Running: !outcome, Restarting: false, ExitCode: outcome?.exit ?? 0 },
        Config: { Labels: null },
        NetworkSettings: { Networks: { [`dockify-env-${ENV}`]: { IPAddress: "10.0.0.9" } } },
      };
    },
    async listContainers() { return []; },
    async createContainer(name: string, input: ContainerInput) {
      if ([...containers.values()].some((c) => c.name === name)) throw new DockerError(409, "name in use");
      const id = `c${next++}`;
      containers.set(id, { name, input, running: false });
      created.push(input);
      return id;
    },
    async startContainer() {},
    async stopContainer() {},
    async removeContainer(id: string, o?: { volumes?: boolean }) {
      containers.delete(find(id).id);
      removed.push({ id, volumes: !!o?.volumes });
    },
    async renameContainer() {},
    async waitContainer(id: string) { return behave(find(id).c.input!)?.exit ?? 0; },
    async logs(id: string) {
      const out = behave(find(id).c.input!);
      return Readable.from(out?.output ? [frame(`${out.output}\n`)] : []);
    },
    async inspectImage() { return { Id: IMG, RepoTags: null, RepoDigests: null, Size: 1, Created: "", Config: { Entrypoint: entrypoint } }; },
    async listImages() { return []; },
    async removeImage() {},
    async pullImage() {},
    async loadImage() {},
    async ensureNetwork() {},
    async connectNetwork() {},
    async disconnectNetwork() {},
    async ensureVolume() {},
  } as unknown as DockerApi;
  return { docker, created, removed };
}

const swapApp = (startCommand: string | null): SwapApp => ({
  id: APP, kind: "backend", environmentId: ENV, projectId: "p", port: 3000, startCommand, memoryLimitMb: null, cpuLimit: null, pidsLimit: null, capAdd: [], sysctls: {}, volumes: [],
  hosts: [], routeHosts: [], health: { path: null, expectedStatus: 200, timeoutSeconds: 1, graceSeconds: 0, intervalSeconds: 1, windowSeconds: 0 },
});

async function runSwap(app: SwapApp, d: ReturnType<typeof daemon>) {
  const proxyDir = await mkdtemp(join(tmpdir(), "dk-fail-"));
  const lines: string[] = [];
  const log = new DeployLog({ write: async (l) => void lines.push(...l.map((x) => x.text)) });
  const deps = { docker: d.docker, log, routes: fileRouteStore(proxyDir), mode: { ingress: "cloudflare_tunnel" } as const, dial: async () => { throw new Error("not dialled here"); }, proxyContainer: "proxy", dashboardHost: "dash.example.com", settleMs: 0, probe: { tcp: async () => true, sleep: async () => {} } };
  const out = await swap(app, "d1", IMG, {}, deps, new AbortController().signal).then(() => null, (e: unknown) => e as Error);
  await log.flush();
  return { out, lines };
}

describe("a failed start in the swap", () => {
  it("puts the real reason in the error and the log, and removes the failed container with its volumes", async () => {
    const d = daemon(() => ({ exit: 127, output: TINI }), null);
    const { out, lines } = await runSwap(swapApp("echo hi && sleep 9"), d);
    expect(out).toBeInstanceOf(RolledBackError);
    expect(out!.message).toMatch(/no shell/);
    expect(out!.message).toContain("exit code 127");
    expect(out!.message).toContain(TINI);
    expect(lines.join("\n")).toMatch(/no shell/);
    expect(d.created).toHaveLength(1);
    expect(d.removed.at(-1)?.volumes).toBe(true);
  });

  it("a command saved before this rule still works: a subcommand goes to the image's entrypoint", async () => {
    const d = daemon((i) => (i.entrypoint ? { exit: 127, output: "[FATAL tini (7)] exec server failed: No such file or directory" } : null), ["/usr/bin/minio"]);
    const { out, lines } = await runSwap(swapApp("server /data"), d);
    expect(out).toBeNull();
    expect(d.created.map((i) => [i.entrypoint, i.cmd])).toEqual([[["server"], ["/data"]], [undefined, ["server", "/data"]]]);
    expect(lines.join("\n")).toContain("server is not a program in this image");
  });

  it("does not retry on an image with no entrypoint, or a command that ran and failed", async () => {
    const none = daemon(() => ({ exit: 127, output: "[FATAL tini (7)] exec nod failed: No such file or directory" }), null);
    expect((await runSwap(swapApp("nod server.js"), none)).out!.message).toMatch(/nod is not a program/);
    expect(none.created).toHaveLength(1);
    const ran = daemon(() => ({ exit: 1, output: "Error: listen EADDRINUSE" }), ["/entry"]);
    expect((await runSwap(swapApp("node server.js"), ran)).out!.message).toContain("EADDRINUSE");
    expect(ran.created).toHaveLength(1);
  });

  it("a shell command never falls back to arguments", async () => {
    const d = daemon(() => ({ exit: 127, output: TINI }), ["/entry"]);
    await runSwap(swapApp("echo a && b"), d);
    expect(d.created).toHaveLength(1);
  });
});

describe("the release command", () => {
  const app: RunnableApp = { id: APP, kind: "backend", environmentId: ENV, projectId: "p", port: null, startCommand: null, memoryLimitMb: null, cpuLimit: null, pidsLimit: null, capAdd: [], sysctls: {}, volumes: [] };
  const run = (d: ReturnType<typeof daemon>, command: string) =>
    runReleaseCommand(d.docker, app, { command, imageId: IMG, env: {}, deploymentId: "dep12345", timeoutMs: 5_000 }, new DeployLog({ write: async () => {} }), new AbortController().signal);

  it("runs a saved subcommand through the image's entrypoint once it proves not to be a program", async () => {
    const d = daemon((i) => (i.entrypoint ? { exit: 127, output: "[FATAL tini (7)] exec migrate failed: No such file or directory" } : null), ["/entry"]);
    await run(d, "migrate up");
    expect(d.created.map((i) => i.cmd)).toEqual([["up"], ["migrate", "up"]]);
    expect(d.removed.every((r) => r.volumes)).toBe(true);
  });

  it("never runs twice a command that really ran", async () => {
    const d = daemon(() => ({ exit: 127, output: "./migrate.sh: line 2: psql: not found" }), ["/entry"]);
    await expect(run(d, "./migrate.sh")).rejects.toThrow(/exited with code 127; nothing was swapped/);
    expect(d.created).toHaveLength(1);
  });

  it("says why when the program is missing", async () => {
    const d = daemon(() => ({ exit: 127, output: "[FATAL tini (7)] exec npx failed: No such file or directory" }), null);
    await expect(run(d, "npx prisma migrate deploy")).rejects.toThrow(/npx is not a program/);
  });
});
