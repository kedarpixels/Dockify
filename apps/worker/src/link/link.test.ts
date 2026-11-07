/**
 * The real link, end to end on real sockets: the agent's dial loop against the worker's listener, over
 * ws, then mutual TLS 1.3, then HTTP/2, with the worker's Docker client on top and the agent's gate in
 * front of a fake Docker. Never over stream.duplexPair(): its synchronous delivery aborts the process
 * inside js_stream_socket.
 */
import { connect as netConnect } from "node:net";
import { DockerClient, type RouteStore } from "@dockify/engine";
import { X509Certificate } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect, createServer as netServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { link as L } from "@dockify/contracts";
import { createWebSocketStream, WebSocket } from "ws";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentApi } from "../../../agent/src/api.ts";
import { createDockerGate } from "../../../agent/src/docker-gate.ts";
import { runLink, type LinkHandle } from "../../../agent/src/link.ts";
import { LINK_KEYS } from "../../../../packages/engine/src/link-keys.fixture.ts";
import { hijackDocker } from "../data/engine-port.ts";
import { createLinkListener, type LinkListener } from "./listener.ts";
import { LinkDownError, ServerLink, type LinkSession } from "./session.ts";

const pin = (cert: string) => new X509Certificate(cert).fingerprint256;
const SERVER = "11111111-1111-4111-8111-111111111111";

const noRoutes: RouteStore = { read: async () => null, snapshot: async () => ({}), apply: async () => {} };

interface Rig {
  url: string;
  listener: LinkListener;
  link: ServerLink;
  known: Map<string, { id: string; state: "active" | "pending_approval" | "revoked" }>;
  tokens: Set<string>;
  logs: string[];
  docker: Server;
  dockerSeen: string[];
  agents: LinkHandle[];
  closers: Array<() => void>;
}

async function rig(): Promise<Rig> {
  const dockerSeen: string[] = [];
  const docker = createServer((req, res) => {
    dockerSeen.push(`${req.method} ${req.url}`);
    req.resume();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify([{ Id: "a", Names: ["/dk-a"], Labels: {} }]));
  });
  docker.on("upgrade", (_q, sock: Socket) => {
    sock.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
    sock.on("data", (d: Buffer) => sock.write(Buffer.concat([Buffer.from("echo:"), d])));
    // A restore's stdin ending is what ends psql: the far end must see it, and still answer after.
    sock.on("end", () => sock.end("stdin ended"));
  });
  await new Promise<void>((r) => docker.listen(0, "127.0.0.1", r));
  const known = new Map<string, { id: string; state: "active" | "pending_approval" | "revoked" }>();
  const tokens = new Set<string>();
  const logs: string[] = [];
  const link = new ServerLink(SERVER);
  const listener = createLinkListener({
    ...LINK_KEYS.cp,
    serverByPin: async (p) => known.get(p) ?? null,
    enroll: async (token, p) => {
      if (!tokens.delete(token)) return false;
      known.set(p, { id: SERVER, state: "active" });
      return true;
    },
    existing: () => link.peek(),
    onSession: (s: LinkSession) => link.attach(s),
    log: (m) => logs.push(m),
  });
  await listener.listen(0, "127.0.0.1");
  return { url: `ws://127.0.0.1:${(listener.server.address() as AddressInfo).port}/link`, listener, link, known, tokens, logs, docker, dockerSeen, agents: [], closers: [] };
}

function agent(r: Rig, o: { url?: string; id?: { key: string; cert: string }; workerPin?: string; token?: string | null; joined?: () => void; log?: (m: string) => void } = {}): LinkHandle {
  const gate = createDockerGate({ host: "127.0.0.1", port: (r.docker.address() as AddressInfo).port });
  r.closers.push(() => gate.close());
  let token = o.token ?? null;
  const onStream = createAgentApi({
    gate,
    dial: async () => {
      throw new Error("not in this test");
    },
    routes: noRoutes,
    routeRules: { upstreams: [] },
    diskPath: ".",
    buildRoot: "unused",
    build: { docker: { loadImage: async () => {}, inspectImage: async () => { throw new Error("unused"); } }, buildkitAddr: "unix:///none" },
    facts: { version: "1.2.3", hostname: "box", publicIpv4: "203.0.113.5", publicIpv6: null, dockerVersion: "28.3", os: "Ubuntu", ingress: "direct_tls" },
  });
  const h = runLink({
    url: o.url ?? r.url,
    ...(o.id ?? LINK_KEYS.agent),
    workerPin: o.workerPin ?? pin(LINK_KEYS.cp.cert),
    joinToken: async () => token,
    onJoined: async () => {
      token = null;
      o.joined?.();
    },
    onStream,
    log: o.log ?? ((m) => r.logs.push(m)),
    random: () => 0.5,
  });
  r.agents.push(h);
  return h;
}

const until = async (what: string, fn: () => boolean, ms = 8_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
};

const dockerOver = (link: ServerLink) => new DockerClient({ createConnection: () => link.current.stream("/v1/docker") }, { cpuCores: 2 });

let r: Rig;
afterEach(async () => {
  for (const a of r.agents) await a.stop();
  for (const c of r.closers) c();
  await r.listener.close();
  r.docker.closeAllConnections();
  r.docker.close();
});

describe("the link", () => {
  it("1: comes up over ws and mutual TLS 1.3 with both pins checked", async () => {
    r = await rig();
    r.known.set(pin(LINK_KEYS.agent.cert), { id: SERVER, state: "active" });
    agent(r);
    await r.link.whenUp();
    const info = await r.link.current.call<{ proto: number; hostname: string }>("GET", "/v1/info");
    expect(info.hostname).toBe("box");
    expect(info.proto).toBeGreaterThan(0);
  });

  it("2 and 3: the Docker client's own calls pass through one stream each, and the gate refuses a privileged create", async () => {
    r = await rig();
    r.known.set(pin(LINK_KEYS.agent.cert), { id: SERVER, state: "active" });
    agent(r);
    await r.link.whenUp();
    const docker = dockerOver(r.link);
    expect((await docker.listContainers({ a: "b" }))[0]!.Id).toBe("a");
    await expect(docker.call("POST", "/containers/create?name=dk-a", { HostConfig: { Privileged: true } })).rejects.toMatchObject({ status: 400 });
    await expect(docker.call("POST", "/commit")).rejects.toMatchObject({ status: 400 });
    expect(r.dockerSeen.some((s) => s.includes("create") || s.includes("commit"))).toBe(false);
  });

  it("4: an exec hijack works through one stream, in both directions", async () => {
    r = await rig();
    r.known.set(pin(LINK_KEYS.agent.cert), { id: SERVER, state: "active" });
    agent(r);
    await r.link.whenUp();
    const docker = dockerOver(r.link);
    const h = await hijackDocker(docker.target, `/exec/${"a".repeat(64)}/start`, { Detach: false, Tty: true });
    expect(h.writable).toBe(true);
    const sock = h.socket as Socket;
    const got = new Promise<string>((resolve) => {
      let t = "";
      sock.on("data", (d: Buffer) => {
        t += d.toString();
        if (t.includes("ping")) resolve(t);
      });
    });
    sock.write("ping");
    expect(await got).toContain("echo:");
    sock.destroy();
  });

  it("carries the end of stdin across the link, and the output after it", async () => {
    r = await rig();
    r.known.set(pin(LINK_KEYS.agent.cert), { id: SERVER, state: "active" });
    agent(r);
    await r.link.whenUp();
    const h = await hijackDocker(dockerOver(r.link).target, `/exec/${"a".repeat(64)}/start`, { Detach: false, Tty: false });
    const sock = h.socket as Socket;
    let got = "";
    const ended = new Promise<void>((resolve) => {
      sock.on("data", (d: Buffer) => {
        got += d.toString();
        if (got.includes("stdin ended")) resolve();
      });
    });
    sock.end();
    await ended;
    sock.destroy();
  });

  it("a dump far larger than the flow-control window, read slowly, arrives whole", async () => {
    r = await rig();
    r.known.set(pin(LINK_KEYS.agent.cert), { id: SERVER, state: "active" });
    agent(r);
    await r.link.whenUp();
    r.docker.removeAllListeners("upgrade");
    const SIZE = 24 * 1024 * 1024;
    r.docker.on("upgrade", (_q, sock: Socket) => {
      sock.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
      const chunk = Buffer.alloc(1024 * 1024, 0x62);
      let sent = 0;
      const pump = (): void => {
        while (sent < SIZE) {
          sent += chunk.length;
          if (!sock.write(chunk)) return void sock.once("drain", pump);
        }
        // The far end closes outright, as a finished exec does: nothing queued may be lost.
        sock.end(() => sock.destroy());
      };
      pump();
    });
    const h = await hijackDocker(dockerOver(r.link).target, `/exec/${"a".repeat(64)}/start`, { Detach: false, Tty: false });
    const sock = h.socket as Socket;
    let n = h.head?.length ?? 0;
    await new Promise<void>((resolve) => {
      // Slow enough that the agent still holds most of it when Docker has already gone.
      sock.on("data", (d: Buffer) => {
        n += d.length;
        sock.pause();
        setTimeout(() => sock.resume(), 2);
      });
      sock.once("close", () => resolve());
    });
    expect(n).toBe(SIZE);
  }, 60_000);

  it("5: a large transfer shares the link with a small call, past the WebSocket's message limit", async () => {
    r = await rig();
    r.known.set(pin(LINK_KEYS.agent.cert), { id: SERVER, state: "active" });
    agent(r);
    await r.link.whenUp();
    const docker = dockerOver(r.link);
    const SIZE = 64 * 1024 * 1024;
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    // A restore's stdin: the largest thing the worker sends to a server now that the gate takes no upload.
    r.docker.removeAllListeners("upgrade");
    const received = new Promise<number>((resolve) => {
      r.docker.on("upgrade", (_q, sock: Socket) => {
        sock.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
        let n = 0;
        sock.on("data", (d: Buffer) => {
          n += d.length;
        });
        sock.on("end", () => {
          sock.end();
          resolve(n);
        });
      });
    });
    const h = await hijackDocker(docker.target, `/exec/${"a".repeat(64)}/start`, { Detach: false, Tty: false });
    const stdin = h.socket as Socket;
    const load = (async () => {
      for (let i = 0; i < SIZE / chunk.length; i++) {
        if (!stdin.write(chunk)) await new Promise((resolve) => stdin.once("drain", resolve));
      }
      stdin.end();
    })();
    await sleep(50);
    const t0 = Date.now();
    await docker.listContainers({});
    const small = Date.now() - t0;
    await load;
    expect(await received).toBe(SIZE);
    expect(small).toBeLessThan(5_000);
    expect(r.link.up).toBe(true);
  }, 90_000);

  it("a request target that does not parse closes that socket and nothing else", async () => {
    r = await rig();
    const port = (r.listener.server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => {
      const c = netConnect(port, "127.0.0.1", () => {
        c.write("GET //[ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
      });
      c.on("error", () => {});
      c.on("close", () => resolve());
    });
    expect(r.listener.server.listening).toBe(true);
    await new Promise<void>((resolve) => {
      const c = netConnect(port, "127.0.0.1", () => c.write("GET /other?x=1 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"));
      c.on("error", () => {});
      c.on("close", () => resolve());
    });
  });

  it("a key waiting to send a join line still counts among the unauthenticated", async () => {
    r = await rig();
    const waiting: WebSocket[] = [];
    const connected: Array<Promise<void>> = [];
    for (let i = 0; i < L.LINK_LIMITS.maxUnauthenticated; i++) {
      const ws = new WebSocket(r.url);
      waiting.push(ws);
      connected.push(new Promise<void>((resolve, reject) => {
        ws.once("error", reject);
        ws.once("open", () => {
          const t = tlsConnect({ socket: createWebSocketStream(ws), ...LINK_KEYS.rogue, rejectUnauthorized: false, minVersion: "TLSv1.3", servername: "link" });
          t.on("error", () => {});
          t.once("secureConnect", () => resolve());
        });
      }));
    }
    await Promise.all(connected);
    // Every one has finished TLS and sits in its join line's ten seconds. One more gets no connection.
    await sleep(50);
    const refused = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(r.url);
      ws.once("open", () => {
        ws.terminate();
        resolve(false);
      });
      ws.once("error", () => resolve(true));
    });
    expect(refused).toBe(true);
    for (const ws of waiting) ws.terminate();
    // And a slot comes back when one goes.
    await until("a free slot", () => waiting.every((ws) => ws.readyState === WebSocket.CLOSED));
    await sleep(50);
    r.known.set(pin(LINK_KEYS.agent.cert), { id: SERVER, state: "active" });
    agent(r);
    await r.link.whenUp();
  }, 30_000);

  it("6: an unknown key with no token gets nothing and is dropped", async () => {
    r = await rig();
    agent(r, { id: LINK_KEYS.rogue, token: "not-a-real-token" });
    await until("the refusal", () => r.logs.some((l) => l.includes("join was refused")));
    expect(r.link.up).toBe(false);
  });

  it("7: a worker with the wrong key is hung up on before the token is sent", async () => {
    r = await rig();
    r.tokens.add("the-token");
    const logged: string[] = [];
    agent(r, { workerPin: pin(LINK_KEYS.rogue.cert), token: "the-token", log: (m) => logged.push(m) });
    await until("the hang up", () => logged.some((l) => l.includes("does not match the pin")));
    expect(r.tokens.has("the-token")).toBe(true);
    expect(r.link.up).toBe(false);
  });

  it("8: one flipped bit ends the connection and delivers nothing", async () => {
    r = await rig();
    r.known.set(pin(LINK_KEYS.agent.cert), { id: SERVER, state: "active" });
    const target = (r.listener.server.address() as AddressInfo).port;
    let flipAt = -1;
    let seen = 0;
    const middle: NetServer = netServer((a) => {
      const b = connect(target, "127.0.0.1");
      a.on("error", () => b.destroy());
      b.on("error", () => a.destroy());
      a.on("close", () => b.destroy());
      b.on("close", () => a.destroy());
      a.on("data", (d: Buffer) => {
        seen += d.length;
        if (flipAt >= 0 && seen > flipAt) {
          d = Buffer.from(d);
          d[d.length - 1]! ^= 1;
          flipAt = -1;
        }
        b.write(d);
      });
      b.pipe(a);
    });
    await new Promise<void>((res) => middle.listen(0, "127.0.0.1", res));
    r.closers.push(() => middle.close());
    agent(r, { url: `ws://127.0.0.1:${(middle.address() as AddressInfo).port}/link` });
    await r.link.whenUp();
    const before = r.link.current;
    const answered = await before.call("GET", "/v1/info");
    expect(answered).toBeTruthy();
    flipAt = seen;
    // Something from the agent has to cross the middle now: the answer to this call.
    await expect(before.call("GET", "/v1/info", undefined, { timeoutMs: 3_000 })).rejects.toBeInstanceOf(Error);
    await until("the old session to end", () => !before.alive);
  });

  it("9: a certificate that expired years ago, with the right pin, connects and serves", async () => {
    r = await rig();
    expect(new X509Certificate(LINK_KEYS.old.cert).validToDate.getTime()).toBeLessThan(Date.now());
    r.known.set(pin(LINK_KEYS.old.cert), { id: SERVER, state: "active" });
    agent(r, { id: LINK_KEYS.old });
    await r.link.whenUp();
    expect(await r.link.current.call("GET", "/v1/info")).toBeTruthy();
  });

  it("a known key's token is single use, and the agent then reconnects into a session", async () => {
    r = await rig();
    r.tokens.add("join-once");
    let joined = 0;
    agent(r, { token: "join-once", joined: () => joined++ });
    await r.link.whenUp();
    expect(joined).toBe(1);
    expect(r.tokens.size).toBe(0);
    // A second key cannot use the spent token.
    agent(r, { id: LINK_KEYS.rogue, token: "join-once" });
    await until("the refusal", () => r.logs.some((l) => l.includes("join was refused")));
    expect(r.known.has(pin(LINK_KEYS.rogue.cert))).toBe(false);
  });

  it("an agent that still holds a token for a key already known just comes up", async () => {
    r = await rig();
    r.known.set(pin(LINK_KEYS.agent.cert), { id: SERVER, state: "active" });
    let joined = 0;
    agent(r, { token: "stale", joined: () => joined++ });
    await until("a session", () => joined === 1 && r.link.up);
    expect(await r.link.current.call("GET", "/v1/info")).toBeTruthy();
  });

  it("refuses a second link with the same key while the first answers", async () => {
    r = await rig();
    r.known.set(pin(LINK_KEYS.agent.cert), { id: SERVER, state: "active" });
    agent(r);
    await r.link.whenUp();
    const first = r.link.current;
    agent(r);
    await until("the refusal", () => r.logs.some((l) => l.includes("second link")));
    expect(r.link.current).toBe(first);
  });

  it("a revoked key is refused, and an unapproved one answers /v1/info and nothing else", async () => {
    r = await rig();
    r.known.set(pin(LINK_KEYS.rogue.cert), { id: "22222222-2222-4222-8222-222222222222", state: "revoked" });
    agent(r, { id: LINK_KEYS.rogue });
    await until("the refusal", () => r.logs.some((l) => l.includes("may not connect")));
    expect(r.link.up).toBe(false);
    for (const a of r.agents.splice(0)) await a.stop();

    r.known.set(pin(LINK_KEYS.agent.cert), { id: SERVER, state: "pending_approval" });
    agent(r);
    await r.link.whenUp();
    expect(await r.link.current.call("GET", "/v1/info")).toBeTruthy();
    expect(() => r.link.current.stream("/v1/docker")).toThrow(/not been approved/);
  });

  it("a partition that sends nothing is noticed from both ends, and both come back", async () => {
    r = await rig();
    r.known.set(pin(LINK_KEYS.agent.cert), { id: SERVER, state: "active" });
    await r.listener.close();
    const link = new ServerLink(SERVER);
    r.listener = createLinkListener({
      ...LINK_KEYS.cp,
      serverByPin: async (p) => r.known.get(p) ?? null,
      enroll: async () => false,
      existing: () => link.peek(),
      onSession: (s: LinkSession) => link.attach(s),
      log: () => {},
      pingEveryMs: 100,
    });
    await r.listener.listen(0, "127.0.0.1");
    const target = (r.listener.server.address() as AddressInfo).port;
    let frozen = false;
    const middle: NetServer = netServer((a) => {
      const b = connect(target, "127.0.0.1");
      for (const s of [a, b]) s.on("error", () => { a.destroy(); b.destroy(); });
      a.on("data", (d: Buffer) => {
        if (!frozen) b.write(d);
      });
      b.on("data", (d: Buffer) => {
        if (!frozen) a.write(d);
      });
    });
    await new Promise<void>((res) => middle.listen(0, "127.0.0.1", res));
    r.closers.push(() => middle.close());
    const notes: string[] = [];
    const h = runLink({
      url: `ws://127.0.0.1:${(middle.address() as AddressInfo).port}/link`,
      ...LINK_KEYS.agent,
      workerPin: pin(LINK_KEYS.cp.cert),
      joinToken: async () => null,
      onJoined: async () => {},
      onStream: (st) => {
        st.respond({ ":status": 200 });
        st.end("{}");
      },
      log: (m) => notes.push(m),
      pingEveryMs: 100,
      random: () => 0.5,
    });
    r.agents.push(h);
    await link.whenUp();
    const first = link.current;
    frozen = true;
    await until("the worker to notice", () => !first.alive);
    await until("the agent to notice", () => notes.some((n) => n.includes("stopped answering")));
    frozen = false;
    await until("a new session", () => link.up && link.current !== first, 15_000);
    expect(await link.current.call("GET", "/v1/info")).toBeTruthy();
  }, 30_000);

  it("comes back after the listener restarts, and a call during the gap says the link is down", async () => {
    r = await rig();
    r.known.set(pin(LINK_KEYS.agent.cert), { id: SERVER, state: "active" });
    agent(r);
    await r.link.whenUp();
    const session = r.link.current;
    session.destroy();
    await until("the drop", () => !r.link.up);
    expect(() => r.link.current).toThrow(LinkDownError);
    await r.link.whenUp();
    expect(r.link.current).not.toBe(session);
    expect(await r.link.current.call("GET", "/v1/info")).toBeTruthy();
  });
});
