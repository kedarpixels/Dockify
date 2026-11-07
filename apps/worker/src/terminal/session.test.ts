/**
 * The worker's half of the terminal, over real sockets, with hostile input: who it will exec into, what
 * it runs, and that a closed session leaves no shell behind. The containerSpec cases are the proof the
 * labels the target check reads cannot come from an image.
 */
import { connect as netConnect } from "node:net";
import { PassThrough } from "node:stream";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { readFileSync } from "node:fs";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { terminal as T } from "@dockify/contracts";
import type { Db } from "@dockify/db";
import { containerSpec } from "@dockify/engine";
import { canonicalName, labelsFor, type RunnableApp } from "../deploy/containers.ts";
import { DockerClient, type ContainerInfo } from "@dockify/engine";
import { EngineTerminalPort } from "./engine.ts";
import { assertExecBound, assertTerminalTarget, attachTerminalChannel, HANGUP_SCRIPT, openExec, PidFilter, SHELL_COMMAND, TerminalRefused, type ExecBody, type ExecInfo, type TerminalDocker } from "./session.ts";

const { encodeFrame, FRAME, FrameDecoder, MAX_FRAME_BYTES, TERMINAL } = T;

const APP = "0f0f0f0f-0000-4000-8000-000000000001";
const OTHER = "0f0f0f0f-0000-4000-8000-000000000002";
const ENV = "0f0f0f0f-0000-4000-8000-0000000000e1";
const ID = "a".repeat(64);
const TOKEN = "channel-token-for-tests";

const good = (over: Partial<ContainerInfo> = {}, labels: Record<string, string> = {}): ContainerInfo => ({
  Id: ID,
  Name: `/${canonicalName(APP)}`,
  Image: "sha256:x",
  RestartCount: 0,
  State: { Status: "running", Running: true, Restarting: false, ExitCode: 0 },
  Config: { Labels: { "dockify.managed": "true", "dockify.app": APP, "dockify.environment": ENV, "dockify.role": "app", "com.docker.compose.project": "", "dockify.preview": "", ...labels } },
  HostConfig: { Privileged: false, NetworkMode: `dockify-env-${ENV}`, IpcMode: "private", PidMode: "", UTSMode: "", UsernsMode: "" },
  NetworkSettings: { Networks: {} },
  ...over,
});
const target = { id: APP, environmentId: ENV };

describe("who the terminal will exec into", () => {
  it("accepts the app's own running container and a managed service", () => {
    expect(assertTerminalTarget(good(), target)).toBe(ID);
    expect(assertTerminalTarget(good({}, { "dockify.role": "service-postgres" }), target)).toBe(ID);
  });

  const refused: Array<[string, ContainerInfo]> = [
    ["another app's label", good({}, { "dockify.app": OTHER })],
    ["no app label", good({}, { "dockify.app": "" })],
    ["not managed", good({}, { "dockify.managed": "false" })],
    ["another environment", good({}, { "dockify.environment": "0f0f0f0f-0000-4000-8000-0000000000e2" })],
    ["a release one-off", good({}, { "dockify.role": "release" })],
    ["a setup helper", good({}, { "dockify.role": "setup-helper" })],
    ["no role", good({}, { "dockify.role": "" })],
    ["a preview", good({}, { "dockify.preview": "x" })],
    ["a Compose service, as a hand-made impostor is", good({}, { "com.docker.compose.project": "dockify", "com.docker.compose.service": "postgres" })],
    ["another name", good({ Name: "/dockify-api-1" })],
    ["a parked copy", good({ Name: `/${canonicalName(APP)}-prev-abc` })],
    ["a name with a link alias", good({ Name: `/${canonicalName(APP)}/db` })],
    ["a short id", good({ Id: "abc" })],
    ["privileged", good({ HostConfig: { Privileged: true, NetworkMode: `dockify-env-${ENV}` } })],
    ["host network", good({ HostConfig: { NetworkMode: "host" } })],
    ["another container's network namespace", good({ HostConfig: { NetworkMode: `container:${"b".repeat(64)}` } })],
    ["host pid namespace", good({ HostConfig: { NetworkMode: `dockify-env-${ENV}`, PidMode: "host" } })],
    ["host ipc namespace", good({ HostConfig: { NetworkMode: `dockify-env-${ENV}`, IpcMode: "host" } })],
    ["no host config", good({ HostConfig: undefined as never })],
  ];
  it.each(refused)("refuses %s", (_name, info) => {
    expect(() => assertTerminalTarget(info, target)).toThrow(TerminalRefused);
  });

  it("calls a stopped, restarting or paused container not running, not refused", () => {
    for (const State of [
      { Status: "exited", Running: false, Restarting: false, ExitCode: 0 },
      { Status: "restarting", Running: true, Restarting: true, ExitCode: 0 },
      { Status: "paused", Running: true, Restarting: false, Paused: true, ExitCode: 0 },
    ]) {
      try {
        assertTerminalTarget(good({ State }), target);
        expect.unreachable();
      } catch (e) {
        expect((e as TerminalRefused).code).toBe("not_running");
      }
    }
  });

  it("refuses an exec Docker says landed in another container, or with privileges or a user", () => {
    const exec: ExecInfo = { ContainerID: ID, Running: false, ExitCode: null, Privileged: false, ProcessConfig: { privileged: false, user: "", tty: true } };
    expect(() => assertExecBound(exec, ID, "")).not.toThrow();
    expect(() => assertExecBound(exec, ID, undefined)).not.toThrow();
    expect(() => assertExecBound({ ...exec, ContainerID: "b".repeat(64) }, ID, "")).toThrow(TerminalRefused);
    expect(() => assertExecBound({ ...exec, Privileged: true }, ID, "")).toThrow(TerminalRefused);
    expect(() => assertExecBound({ ...exec, ProcessConfig: { privileged: true } }, ID, "")).toThrow(TerminalRefused);
    expect(() => assertExecBound({ ...exec, ProcessConfig: { user: "root" } }, ID, "")).toThrow(TerminalRefused);
    // What Docker 29 reported on the box for an exec created with no User, in an image with USER 101.
    expect(() => assertExecBound({ ...exec, ProcessConfig: { user: "101" } }, ID, "101")).not.toThrow();
    expect(() => assertExecBound({ ...exec, ProcessConfig: { user: "root" } }, ID, "101")).toThrow(TerminalRefused);
    expect(() => assertExecBound({ ...exec, ProcessConfig: { user: "" } }, ID, "101")).toThrow(TerminalRefused);
  });
});

describe("a spoofed label cannot pass (the proof from the code)", () => {
  const app: RunnableApp = { id: APP, kind: "backend", environmentId: ENV, projectId: "p", port: 3000, startCommand: null, memoryLimitMb: null, cpuLimit: null, pidsLimit: null, capAdd: [], sysctls: {}, volumes: [] };

  /** What Docker does: an image's labels fill only the keys the create body left out. */
  const merged = (body: Record<string, string>, image: Record<string, string>) => ({ ...image, ...body });

  it("an image cannot claim to be a victim app, a service or a control container", () => {
    const hostile = {
      "dockify.app": OTHER, "dockify.environment": "e", "dockify.role": "app", "dockify.managed": "true", "dockify.project": "p",
      "com.docker.compose.project": "dockify", "com.docker.compose.service": "api", "com.docker.compose.oneoff": "False", "com.docker.compose.container-number": "1",
      "dockify.preview": "", "dockify.preview.app": "",
    };
    const body = containerSpec({ name: canonicalName(APP), image: "sha256:" + "c".repeat(64), network: `dockify-env-${ENV}`, labels: labelsFor(app, "d", "app") }, 8).Labels;
    const final = merged(body, hostile);
    expect(final["dockify.app"]).toBe(APP);
    expect(final["com.docker.compose.project"]).toBe("");
    expect(final["com.docker.compose.service"]).toBe("");
    // So it passes only as itself, and fails as the app it claimed.
    const info = good({ Config: { Labels: final } });
    expect(assertTerminalTarget(info, target)).toBe(ID);
    expect(() => assertTerminalTarget({ ...info, Name: `/${canonicalName(OTHER)}` }, { id: OTHER, environmentId: ENV })).toThrow(TerminalRefused);
  });

  it("an app with no input labels at all still has every key blank in its body", () => {
    const body = containerSpec({ name: "dk-x", image: "sha256:" + "c".repeat(64), network: `dockify-env-${ENV}` }, 8).Labels;
    for (const k of ["dockify.app", "dockify.environment", "dockify.role", "dockify.preview", "dockify.preview.app", "com.docker.compose.project", "com.docker.compose.service"]) expect(body[k]).toBe("");
  });
});

describe("the command", () => {
  it("is a constant with no user, no privilege, and nothing from a request", async () => {
    expect(SHELL_COMMAND[0]).toBe("/bin/sh");
    const created: ExecBody[] = [];
    const docker: TerminalDocker = {
      inspect: async () => good(),
      createExec: async (_n, body) => (created.push(body), "e".repeat(64)),
      inspectExec: async () => ({ ContainerID: ID, Running: false, ExitCode: null }),
      attachExec: async () => ({ stream: new Duplex({ read() {}, write(_c, _e, cb) { cb(); } }), head: Buffer.alloc(0) }),
      startDetached: async () => {},
      resizeExec: async () => {},
    };
    await openExec({ db: fakeDb(), docker }, APP, { cols: 80, rows: 24 });
    const b = created[0]!;
    expect(b.Cmd).toEqual([...SHELL_COMMAND]);
    expect(b.Env).toEqual(["TERM=xterm-256color"]);
    expect(b).not.toHaveProperty("User");
    expect(b).not.toHaveProperty("Privileged");
    expect(b).not.toHaveProperty("WorkingDir");
    expect(b.ConsoleSize).toEqual([24, 80]);
  });

  it("refuses a bad app id before anything reaches the daemon", async () => {
    let touched = false;
    const docker = new Proxy({}, { get: () => () => { touched = true; } }) as unknown as TerminalDocker;
    for (const id of ["dockify-api-1", "../../etc", `${APP}/../x`, "", APP.toUpperCase(), `${APP};sh`]) {
      await expect(openExec({ db: fakeDb(), docker }, id, { cols: 80, rows: 24 })).rejects.toBeInstanceOf(TerminalRefused);
    }
    expect(touched).toBe(false);
  });

  it("does not start an exec Docker bound to another container", async () => {
    let attached = false;
    const docker: TerminalDocker = {
      inspect: async () => good(),
      createExec: async () => "e".repeat(64),
      inspectExec: async () => ({ ContainerID: "b".repeat(64), Running: false, ExitCode: null }),
      attachExec: async () => { attached = true; throw new Error("must not run"); },
      startDetached: async () => {},
      resizeExec: async () => {},
    };
    await expect(openExec({ db: fakeDb(), docker }, APP, { cols: 80, rows: 24 })).rejects.toBeInstanceOf(TerminalRefused);
    expect(attached).toBe(false);
  });

  it("honours the off switch in the worker too", async () => {
    await expect(openExec({ db: fakeDb({ enabled: false }), docker: {} as TerminalDocker }, APP, { cols: 80, rows: 24 })).rejects.toMatchObject({ code: "disabled" });
  });
});

describe("PidFilter", () => {
  const mark = (pid: string) => Buffer.from(`\x1edockify-pid:${pid}\x1e`, "latin1");
  it("removes the marker across reads and keeps what follows", () => {
    const f = new PidFilter();
    const m = mark("42");
    expect(f.push(m.subarray(0, 4)).length).toBe(0);
    expect(f.push(Buffer.concat([m.subarray(4), Buffer.from("$ ")])).toString()).toBe("$ ");
    expect(f.pid).toBe("42");
    expect(f.push(Buffer.from("later")).toString()).toBe("later");
  });
  it("takes no pid from a hostile marker", () => {
    for (const bad of ["0", "-1", "1;reboot", "$(id)", "1 2", "12345678901"]) {
      const f = new PidFilter();
      f.push(mark(bad));
      expect(f.pid).toBeNull();
    }
  });
  it("gives up after a bounded number of bytes, losing nothing", () => {
    const f = new PidFilter();
    const big = Buffer.alloc(1000, 0x61);
    expect(f.push(big).length).toBe(1000);
    expect(f.pid).toBeNull();
  });
});

describe("frames", () => {
  it("round trips across split reads", () => {
    const d = new FrameDecoder();
    const out: Array<[number, string]> = [];
    const a = Buffer.concat([encodeFrame(FRAME.data, "hello"), encodeFrame(FRAME.resize, "{}")]);
    d.push(a.subarray(0, 3), (t, p) => out.push([t, p.toString()]));
    d.push(a.subarray(3), (t, p) => out.push([t, p.toString()]));
    expect(out).toEqual([[FRAME.data, "hello"], [FRAME.resize, "{}"]]);
  });
  it("refuses an unknown type and a length past the cap before allocating it", () => {
    expect(() => new FrameDecoder().push(Buffer.from([9, 0, 0, 0, 0]), () => {})).toThrow();
    const head = Buffer.alloc(5);
    head.writeUInt32BE(MAX_FRAME_BYTES + 1, 1);
    expect(() => new FrameDecoder().push(head, () => {})).toThrow();
    expect(() => encodeFrame(FRAME.data, Buffer.alloc(MAX_FRAME_BYTES + 1))).toThrow();
  });
});

// ------------------------------------------------------------------ over a real socket

function fakeDb(o: { enabled?: boolean; app?: boolean } = {}): Db {
  return {
    instance: { findUnique: async () => ({ terminalEnabled: o.enabled ?? true }) },
    app: { findUnique: async () => (o.app === false ? null : { id: APP, environmentId: ENV }) },
  } as unknown as Db;
}

/** A fake daemon's exec: a duplex the test drives, recording signals sent through further execs. */
function fakeDocker() {
  const toShell: Buffer[] = [];
  let push: ((b: Buffer | null) => void) | null = null;
  const stream = new Duplex({
    read() {},
    write(c: Buffer, _e, cb) {
      toShell.push(c);
      cb();
    },
  });
  push = (b) => stream.push(b);
  const signals: string[][] = [];
  const sizes: Array<[number, number]> = [];
  const running = { value: true };
  let execs = 0;
  const docker: TerminalDocker = {
    inspect: async () => good(),
    createExec: async (_n, body) => {
      execs += 1;
      if (execs > 1) signals.push(body.Cmd);
      return String(execs).repeat(64).slice(0, 64);
    },
    inspectExec: async () => ({ ContainerID: ID, Running: running.value, ExitCode: running.value ? null : 0 }),
    attachExec: async () => ({ stream, head: Buffer.from("\x1edockify-pid:77\x1e$ ", "latin1") }),
    startDetached: async () => {},
    resizeExec: async (_id, c, r) => void sizes.push([c, r]),
  };
  return { docker, stream, toShell, push: push!, signals, sizes, running };
}

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.closeAllConnections?.(), s.close();
});

async function listen(deps: Parameters<typeof attachTerminalChannel>[1]) {
  const server = createServer((_q, r) => r.writeHead(404).end());
  servers.push(server);
  const terminals = attachTerminalChannel(server, deps);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, terminals };
}

function dial(port: number, o: { token?: string; path?: string; upgrade?: string } = {}): Promise<{ socket?: Socket; status: number; body?: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1", port, method: "GET", path: o.path ?? `/terminal/${APP}?cols=80&rows=24`,
      headers: { Connection: "Upgrade", Upgrade: o.upgrade ?? "dockify-terminal", ...(o.token === "" ? {} : { Authorization: `Bearer ${o.token ?? TOKEN}` }) },
    });
    req.on("upgrade", (res, socket, head) => {
      // A first frame that came with the 101 arrives here, not on the socket.
      if (head.length) socket.unshift(head);
      resolve({ socket: socket as Socket, status: res.statusCode ?? 0 });
    });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const wait = async (ok: () => boolean, ms = 1500) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("the channel", () => {
  it("refuses without the token, on a wrong path, and on a wrong upgrade, with nothing reaching the daemon", async () => {
    const f = fakeDocker();
    let inspected = 0;
    const docker = { ...f.docker, inspect: async () => (inspected++, good()) };
    const { port } = await listen({ db: fakeDb(), docker, token: TOKEN });
    expect((await dial(port, { token: "" })).status).toBe(401);
    expect((await dial(port, { token: "wrong" })).status).toBe(401);
    expect((await dial(port, { path: "/terminal/dockify-api-1?cols=80&rows=24" })).status).toBe(404);
    expect((await dial(port, { path: `/terminal/${APP}` })).status).toBe(404);
    expect((await dial(port, { path: `/terminal/${APP}?cols=80&rows=24&user=root` })).status).toBe(404);
    expect((await dial(port, { upgrade: "websocket" })).status).toBe(404);
    expect((await dial(port, { path: `/terminal/${APP}?cols=999&rows=24` })).status).toBe(400);
    expect(inspected).toBe(0);
  });

  it("answers a refusal with a code and never the reason", async () => {
    const f = fakeDocker();
    const { port } = await listen({ db: fakeDb(), docker: { ...f.docker, inspect: async () => good({}, { "dockify.app": OTHER }) }, token: TOKEN });
    const r = await dial(port);
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body!)).toEqual({ code: "refused" });
  });

  it("carries bytes both ways, strips the marker and applies a resize", async () => {
    const f = fakeDocker();
    const { port } = await listen({ db: fakeDb(), docker: f.docker, token: TOKEN, hangupMs: 1 });
    const { socket } = await dial(port);
    const got: Buffer[] = [];
    const dec = new FrameDecoder();
    socket!.on("data", (c: Buffer) => dec.push(c, (t, p) => { if (t === FRAME.data) got.push(Buffer.from(p)); }));
    await wait(() => Buffer.concat(got).toString() === "$ ");
    socket!.write(encodeFrame(FRAME.data, "ls\n"));
    socket!.write(encodeFrame(FRAME.resize, JSON.stringify({ t: "resize", cols: 100, rows: 30 })));
    await wait(() => f.toShell.length > 0 && f.sizes.length > 0);
    expect(Buffer.concat(f.toShell).toString()).toBe("ls\n");
    expect(f.sizes).toEqual([[100, 30]]);
    f.push(Buffer.from("out"));
    await wait(() => Buffer.concat(got).toString() === "$ out");
    socket!.destroy();
  });

  it("signals the shell when the api goes away, with the pid as a separate argument", async () => {
    const f = fakeDocker();
    const { port, terminals } = await listen({ db: fakeDb(), docker: f.docker, token: TOKEN, hangupMs: 1 });
    const { socket } = await dial(port);
    await wait(() => terminals.count() === 1);
    await new Promise((r) => setTimeout(r, 20));
    socket!.destroy();
    await wait(() => f.signals.length === 2);
    expect(f.signals[0]).toEqual(["/bin/sh", "-c", HANGUP_SCRIPT, "77"]);
    expect(f.signals[1]).toEqual(["/bin/sh", "-c", 'kill -KILL "$0"', "77"]);
    await wait(() => terminals.count() === 0);
  });

  it("a browser that left before the shell printed its pid still has its shell ended", async () => {
    const f = fakeDocker();
    const late = new PassThrough();
    const docker: TerminalDocker = { ...f.docker, attachExec: async () => ({ stream: late, head: Buffer.alloc(0) }) };
    const { port, terminals } = await listen({ db: fakeDb(), docker, token: TOKEN, hangupMs: 1 });
    const { socket } = await dial(port);
    socket!.destroy();
    await new Promise((r) => setTimeout(r, 40));
    expect(f.signals).toHaveLength(0);
    late.write("\x1edockify-pid:77\x1e$ ");
    await wait(() => f.signals.length === 2);
    expect(f.signals[0]).toEqual(["/bin/sh", "-c", HANGUP_SCRIPT, "77"]);
    await wait(() => terminals.count() === 0);
  });

  it("a browser that left while the exec was attaching: the attach has started the shell, so it is ended too", async () => {
    const f = fakeDocker();
    const stream = new PassThrough();
    let attached!: () => void;
    const gate = new Promise<void>((r) => (attached = r));
    const docker: TerminalDocker = {
      ...f.docker,
      attachExec: async () => {
        await gate;
        return { stream, head: Buffer.from("\x1edockify-pid:88\x1e", "latin1") };
      },
    };
    const { port, terminals } = await listen({ db: fakeDb(), docker, token: TOKEN, hangupMs: 1 });
    const raw = netConnect(port, "127.0.0.1");
    raw.on("error", () => {});
    raw.write(`GET /terminal/${APP}?cols=80&rows=24 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: dockify-terminal\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`);
    await wait(() => terminals.count() === 1);
    raw.destroy();
    await new Promise((r) => setTimeout(r, 40));
    attached();
    await wait(() => f.signals.length === 2);
    expect(f.signals[1]).toEqual(["/bin/sh", "-c", 'kill -KILL "$0"', "88"]);
    await wait(() => terminals.count() === 0);
  });

  it("a shell that never prints a pid does not hold the close for long", async () => {
    const f = fakeDocker();
    const docker: TerminalDocker = { ...f.docker, attachExec: async () => ({ stream: new PassThrough(), head: Buffer.alloc(0) }) };
    const { port, terminals } = await listen({ db: fakeDb(), docker, token: TOKEN, hangupMs: 1, markerWaitMs: 30 });
    const { socket } = await dial(port);
    socket!.destroy();
    await wait(() => terminals.count() === 0);
    await new Promise((r) => setTimeout(r, 60));
    expect(f.signals).toHaveLength(0);
  });

  it("hangs up the shell's whole session, since busybox ash does not pass a hangup to its background jobs", () => {
    // /proc/<pid>/stat after the name in brackets: state, ppid, pgrp, session. Session is the fourth.
    expect(HANGUP_SCRIPT).toContain('l="${l##*) }"; set -- $l; [ "$4" = "$0" ] && kill -HUP "${d##*/}"');
    expect(HANGUP_SCRIPT.startsWith('kill -HUP "$0";')).toBe(true);
    expect(HANGUP_SCRIPT).not.toContain("KILL");
  });

  it("sends no signal to an exec Docker says has already ended", async () => {
    const f = fakeDocker();
    const { port } = await listen({ db: fakeDb(), docker: f.docker, token: TOKEN, hangupMs: 1 });
    const { socket } = await dial(port);
    await new Promise((r) => setTimeout(r, 20));
    f.running.value = false;
    socket!.destroy();
    await new Promise((r) => setTimeout(r, 40));
    expect(f.signals).toEqual([]);
  });

  it("reports a shell that exited, and an image with no shell", async () => {
    const f = fakeDocker();
    f.running.value = false;
    const { port } = await listen({ db: fakeDb(), docker: f.docker, token: TOKEN, hangupMs: 1 });
    const { socket } = await dial(port);
    const ends: string[] = [];
    const dec = new FrameDecoder();
    socket!.on("data", (c: Buffer) => dec.push(c, (t, p) => { if (t === FRAME.end) ends.push(p.toString()); }));
    await new Promise((r) => setTimeout(r, 10));
    f.push(null);
    await wait(() => ends.length === 1);
    expect(JSON.parse(ends[0]!)).toEqual({ reason: "exited", exitCode: 0 });

    const noShell = fakeDocker();
    const docker: TerminalDocker = {
      ...noShell.docker,
      inspectExec: async () => ({ ContainerID: ID, Running: false, ExitCode: 127 }),
      attachExec: async () => ({ stream: noShell.stream, head: Buffer.alloc(0) }),
    };
    const second = await listen({ db: fakeDb(), docker, token: TOKEN, hangupMs: 1 });
    const two = await dial(second.port);
    const ends2: string[] = [];
    const dec2 = new FrameDecoder();
    const text2: string[] = [];
    two.socket!.on("data", (c: Buffer) => dec2.push(c, (t, p) => {
      if (t === FRAME.end) ends2.push(p.toString());
      if (t === FRAME.data) text2.push(p.toString());
    }));
    await new Promise((r) => setTimeout(r, 10));
    noShell.push(Buffer.from("OCI runtime exec failed: exec failed: unable to start container process\n"));
    noShell.push(null);
    await wait(() => ends2.length === 1);
    expect(JSON.parse(ends2[0]!).reason).toBe("no_shell");
    // The page says the sentence; the daemon's own words stay out of it.
    expect(text2.join("")).toBe("");
  });

  it("opens an image with its own USER, as Docker reports it, and refuses an exec under another", async () => {
    const created = { user: "101" };
    const docker = (execUser: string): TerminalDocker => ({
      inspect: async () => good({ Config: { ...good().Config, User: created.user } }),
      createExec: async () => "e".repeat(64),
      inspectExec: async () => ({ ContainerID: ID, Running: false, ExitCode: null, ProcessConfig: { user: execUser } }),
      attachExec: async () => ({ stream: new PassThrough(), head: Buffer.alloc(0) }),
      startDetached: async () => {},
      resizeExec: async () => {},
    });
    await expect(openExec({ db: fakeDb(), docker: docker("101") }, APP, { cols: 80, rows: 24 })).resolves.toMatchObject({ containerId: ID });
    await expect(openExec({ db: fakeDb(), docker: docker("root") }, APP, { cols: 80, rows: 24 })).rejects.toThrow(TerminalRefused);
  });

  it("closes on a hostile frame", async () => {
    const f = fakeDocker();
    const { port, terminals } = await listen({ db: fakeDb(), docker: f.docker, token: TOKEN, hangupMs: 1 });
    for (const bad of [Buffer.from([9, 0, 0, 0, 0]), encodeFrame(FRAME.resize, "not json"), encodeFrame(FRAME.resize, JSON.stringify({ t: "resize", cols: 1e6, rows: -1 }))]) {
      const { socket } = await dial(port);
      await wait(() => terminals.count() === 1);
      await new Promise((r) => setTimeout(r, 5));
      socket!.write(bad);
      await wait(() => terminals.count() === 0);
    }
    expect(f.sizes).toEqual([]);
  });

  it("holds its own ceilings, even when requests arrive together", async () => {
    const f = fakeDocker();
    const docker: TerminalDocker = { ...f.docker, attachExec: async () => ({ stream: new Duplex({ read() {}, write(_c, _e, cb) { cb(); } }), head: Buffer.alloc(0) }) };
    const { port } = await listen({ db: fakeDb(), docker, token: TOKEN, hangupMs: 1 });
    const all = await Promise.all(Array.from({ length: TERMINAL.workerMaxPerApp + 3 }, () => dial(port)));
    expect(all.filter((r) => r.status === 429).length).toBe(3);
    for (const r of all) r.socket?.destroy();
  });

  it("ends every session when the worker stops", async () => {
    const f = fakeDocker();
    const { port, terminals } = await listen({ db: fakeDb(), docker: f.docker, token: TOKEN, hangupMs: 1 });
    const { socket } = await dial(port);
    await wait(() => terminals.count() === 1);
    await new Promise((r) => setTimeout(r, 10));
    await terminals.closeAll();
    expect(terminals.count()).toBe(0);
    socket!.destroy();
  });
});

describe("through the real client", () => {
  it("puts on the wire exactly what the socket proxy allows", async () => {
    const seen: string[] = [];
    const daemon = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" }).end(req.url?.endsWith("/exec") ? JSON.stringify({ Id: "e" }) : "{}");
    });
    servers.push(daemon);
    await new Promise<void>((r) => daemon.listen(0, "127.0.0.1", r));
    const port = new EngineTerminalPort(new DockerClient({ host: "127.0.0.1", port: (daemon.address() as AddressInfo).port }, { cpuCores: 4 }));
    const exec = "f".repeat(64);
    await port.createExec(canonicalName(APP), { AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true, Cmd: ["x"] });
    await port.inspectExec(exec);
    await port.resizeExec(exec, 120, 40);
    await port.startDetached(exec);
    expect(seen).toEqual([
      `POST /v1.43/containers/${canonicalName(APP)}/exec`,
      `GET /v1.43/exec/${exec}/json`,
      `POST /v1.43/exec/${exec}/resize?h=40&w=120`,
      `POST /v1.43/exec/${exec}/start`,
    ]);
    const cfg = readFileSync(new URL("../../../../deploy/socket-proxy/haproxy.cfg", import.meta.url), "utf8");
    expect(cfg).toContain("/exec/[0-9a-f]{64}/resize$ } { query -m reg ^h=[0-9]{1,3}&w=[0-9]{1,3}$ }");
    // No rule lets exec reach a container by id, or any name but the managed ones.
    expect(cfg).not.toMatch(/containers\/\[\^\/\]\+\/exec/);
  });
});
