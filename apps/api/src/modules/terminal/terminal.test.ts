/**
 * The terminal's front door over a real listening socket and a real WebSocket client, with an attacker's
 * requests: who may get a ticket, what spends one, what ends a session, and what never reaches a log.
 */
import { PassThrough, Duplex } from "node:stream";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { terminal as T } from "@dockify/contracts";
import { hashToken } from "@dockify/crypto";
import type { Db } from "@dockify/db";
import { buildApp } from "../../app.ts";
import { testConfig, testRing } from "../../test-helpers.ts";
import { closeForRefusal, WorkerRefused, type WorkerDial } from "./gateway.ts";
import { clientKey, TerminalTickets } from "./tickets.ts";

const { encodeFrame, FRAME, FrameDecoder, TERMINAL, TERMINAL_CLOSE } = T;

const APP = "0f0f0f0f-0000-4000-8000-000000000001";
const OTHER_APP = "0f0f0f0f-0000-4000-8000-000000000002";
const ORIGIN = "https://dockify.test";
const COOKIE_NAME = "__Host-dockify_sid";
const TOKEN = "session-token-for-tests";
const UA = "test-browser/1";

interface World {
  role: "admin" | "viewer";
  elevated: boolean;
  revoked: boolean;
  disabled: boolean;
  member: boolean;
  appExists: boolean;
  enabled: boolean;
  deployTarget: "server" | "vercel";
  audits: Array<{ action: string; suffix: string | null; failed: boolean; actorId: string | null; targetId: string | null }>;
}

function world(over: Partial<World> = {}): World {
  return { role: "admin", elevated: true, revoked: false, disabled: false, member: true, appExists: true, enabled: true, deployTarget: "server", audits: [], ...over };
}

function fakeDb(w: World): Db {
  const future = new Date(Date.now() + 3_600_000);
  const sessionRow = () => ({
    id: "s1", userId: "u1", tokenHash: hashToken(TOKEN), revokedAt: w.revoked ? new Date() : null, expiresAt: future, absoluteExpiresAt: future, lastSeenAt: new Date(),
    elevatedUntil: w.elevated ? future : null,
    user: { name: "Owner", disabledAt: w.disabled ? new Date() : null, member: w.member ? { role: w.role } : null },
  });
  return {
    session: {
      findUnique: async ({ where }: { where: { tokenHash?: string; id?: string } }) => (where.id === "s1" || where.tokenHash === hashToken(TOKEN) ? sessionRow() : null),
      update: async () => ({}),
    },
    instance: { findUnique: async () => ({ terminalEnabled: w.enabled }) },
    app: {
      findUnique: async ({ where }: { where: { id: string } }) => (w.appExists && (where.id === APP || where.id === OTHER_APP) ? { id: where.id, name: "web", deployTarget: w.deployTarget, environment: { projectId: "p1" } } : null),
    },
    activityLog: {
      create: async ({ data }: { data: World["audits"][number] }) => {
        w.audits.push(data);
        return {};
      },
    },
  } as unknown as Db;
}

/** A worker with a real duplex the test drives. */
function fakeWorker() {
  const sent: Array<{ type: number; body: string }> = [];
  const decoder = new FrameDecoder();
  const out = new PassThrough();
  let destroyed = false;
  const socket = new Duplex({
    read() {},
    write(c: Buffer, _e, cb) {
      decoder.push(c, (type, p) => sent.push({ type, body: p.toString() }));
      cb();
    },
    destroy(_e, cb) {
      destroyed = true;
      cb(null);
    },
  });
  out.on("data", (c: Buffer) => socket.push(c));
  const dials: Array<{ appId: string; cols: number; rows: number }> = [];
  const dial: WorkerDial = async (appId, size) => {
    dials.push({ appId, ...size });
    return { socket, head: Buffer.alloc(0) };
  };
  return { dial, sent, say: (s: string) => out.write(encodeFrame(FRAME.data, s)), finish: (reason: string, code: number) => out.write(encodeFrame(FRAME.end, JSON.stringify({ reason, exitCode: code }))), dials, destroyed: () => destroyed };
}

const open: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of open.splice(0)) await c();
});

async function start(w: World, dial: WorkerDial, limits: Parameters<typeof buildApp>[0]["terminalLimits"] = {}) {
  const { app } = await buildApp({ db: fakeDb(w), ring: testRing(), config: testConfig(), logger: false, workerWatch: false, integrations: false, terminalDial: dial, terminalLimits: limits });
  await app.listen({ port: 0, host: "127.0.0.1" });
  open.push(() => app.close());
  return { app, port: (app.server.address() as AddressInfo).port };
}

const browserHeaders = { origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: `${COOKIE_NAME}=${TOKEN}`, "user-agent": UA };

async function ticket(app: Awaited<ReturnType<typeof start>>["app"], appId = APP, headers: Record<string, string> = browserHeaders): Promise<string> {
  const res = await app.inject({ method: "POST", url: `/api/v1/apps/${appId}/terminal/ticket`, headers, payload: {}, remoteAddress: "127.0.0.1" });
  expect(res.statusCode).toBe(200);
  return (res.json() as { ticket: string }).ticket;
}

interface Conn {
  ws: WebSocket;
  closed: Promise<number>;
  text: string[];
  bytes: Buffer[];
}

function connect(port: number, o: { headers?: Record<string, string>; path?: string } = {}): Promise<Conn | { refused: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${o.path ?? `/api/v1/apps/${APP}/terminal`}`, { headers: o.headers ?? browserHeaders });
    const text: string[] = [];
    const bytes: Buffer[] = [];
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    ws.on("message", (d, binary) => (binary ? bytes.push(d as Buffer) : text.push(d.toString())));
    ws.on("open", () => resolve({ ws, closed, text, bytes }));
    ws.on("unexpected-response", (_q, res) => {
      resolve({ refused: res.statusCode ?? 0 });
      res.resume();
    });
    ws.on("error", () => {});
  });
}

async function connected(port: number): Promise<Conn> {
  const c = await connect(port);
  if ("refused" in c) throw new Error(`refused ${c.refused}`);
  open.push(async () => c.ws.terminate());
  return c;
}

const auth = (t: string, cols = 80, rows = 24) => JSON.stringify({ t: "auth", ticket: t, cols, rows });
const until = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

async function opened(port: number, t: string): Promise<Conn> {
  const c = await connected(port);
  c.ws.send(auth(t));
  await until(() => c.text.includes(JSON.stringify({ t: "ready" })));
  return c;
}

describe("the ticket", () => {
  it("needs a session, the admin role and a fresh step-up", async () => {
    const f = fakeWorker();
    const url = `/api/v1/apps/${APP}/terminal/ticket`;
    const a = await start(world({ elevated: false }), f.dial);
    const stale = await a.app.inject({ method: "POST", url, headers: browserHeaders, payload: {} });
    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toMatchObject({ code: "STEP_UP_REQUIRED" });
    const none = await a.app.inject({ method: "POST", url, headers: { origin: ORIGIN }, payload: {} });
    expect(none.statusCode).toBe(401);
    const b = await start(world({ role: "viewer" }), f.dial);
    expect((await b.app.inject({ method: "POST", url, headers: browserHeaders, payload: {} })).statusCode).toBe(403);
  });

  it("is never given to an API token, whatever its scope", async () => {
    const f = fakeWorker();
    const a = await start(world(), f.dial);
    const res = await a.app.inject({ method: "POST", url: `/api/v1/apps/${APP}/terminal/ticket`, headers: { authorization: "Bearer dk_anything" }, payload: {} });
    expect(res.statusCode).toBe(403);
  });

  it("refuses from another site, when off, for a removed app and for a Vercel app", async () => {
    const f = fakeWorker();
    const url = `/api/v1/apps/${APP}/terminal/ticket`;
    const a = await start(world(), f.dial);
    expect((await a.app.inject({ method: "POST", url, headers: { ...browserHeaders, origin: "https://evil.example" }, payload: {} })).statusCode).toBe(403);
    const off = await start(world({ enabled: false }), f.dial);
    const r = await off.app.inject({ method: "POST", url, headers: browserHeaders, payload: {} });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ code: "TERMINAL_DISABLED" });
    const gone = await start(world({ appExists: false }), f.dial);
    expect((await gone.app.inject({ method: "POST", url, headers: browserHeaders, payload: {} })).statusCode).toBe(404);
    const vercel = await start(world({ deployTarget: "vercel" }), f.dial);
    expect((await vercel.app.inject({ method: "POST", url, headers: browserHeaders, payload: {} })).statusCode).toBe(409);
  });

  it("stops a loop asking for tickets", async () => {
    const f = fakeWorker();
    const a = await start(world(), f.dial);
    const url = `/api/v1/apps/${APP}/terminal/ticket`;
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await a.app.inject({ method: "POST", url, headers: browserHeaders, payload: {} })).statusCode);
    expect(codes.filter((c) => c === 429).length).toBe(2);
  });

  describe("store", () => {
    const b = { sessionId: "s", appId: "a", client: clientKey("1.1.1.1", "ua") };
    it("spends on any attempt, right or wrong", () => {
      const t = new TerminalTickets();
      const { ticket: v } = t.issue(b);
      expect(t.consume(v, { ...b, sessionId: "other" })).toBe(false);
      expect(t.consume(v, b)).toBe(false);
    });
    it("is single use, and bound to session, app and client", () => {
      const t = new TerminalTickets();
      const one = t.issue(b).ticket;
      expect(t.consume(one, b)).toBe(true);
      expect(t.consume(one, b)).toBe(false);
      expect(t.consume(t.issue(b).ticket, { ...b, appId: "x" })).toBe(false);
      expect(t.consume(t.issue(b).ticket, { ...b, client: clientKey("2.2.2.2", "ua") })).toBe(false);
      expect(t.consume(t.issue(b).ticket, { ...b, client: clientKey("1.1.1.1", "other") })).toBe(false);
    });
    it("expires, keeps only a hash, and bounds what it holds", () => {
      const t = new TerminalTickets(1000);
      const v = t.issue(b, 0).ticket;
      expect(t.consume(v, b, 1000)).toBe(false);
      const holds = t.issue(b).ticket;
      expect(JSON.stringify([...(t as unknown as { live: Map<string, unknown> }).live.entries()])).not.toContain(holds);
      for (let i = 0; i < 700; i++) t.issue(b);
      expect(t.size).toBeLessThanOrEqual(500);
    });
  });
});

describe("the upgrade", () => {
  it("refuses another site's page, though the cookie rides along, and writes it down", async () => {
    const w = world();
    const f = fakeWorker();
    const { port } = await start(w, f.dial);
    for (const headers of [
      { ...browserHeaders, origin: "https://evil.example" },
      { ...browserHeaders, origin: "https://tenant.dockify.test" },
      { ...browserHeaders, origin: "null" },
      { cookie: browserHeaders.cookie, "user-agent": UA },
      { ...browserHeaders, "sec-fetch-site": "same-site" },
    ]) {
      expect(await connect(port, { headers })).toEqual({ refused: 403 });
    }
    expect(w.audits.filter((a) => a.action === "terminal.refused" && a.failed).length).toBe(5);
    expect(f.dials).toEqual([]);
  });

  it("refuses without a session, a Viewer, a lapsed step-up, a token, and when off", async () => {
    const f = fakeWorker();
    const a = await start(world(), f.dial);
    expect(await connect(a.port, { headers: { origin: ORIGIN, "user-agent": UA } })).toEqual({ refused: 401 });
    expect(await connect(a.port, { headers: { ...browserHeaders, authorization: "Bearer dk_x" } })).toEqual({ refused: 403 });
    expect(await connect((await start(world({ role: "viewer" }), f.dial)).port)).toEqual({ refused: 403 });
    expect(await connect((await start(world({ elevated: false }), f.dial)).port)).toEqual({ refused: 403 });
    expect(await connect((await start(world({ revoked: true }), f.dial)).port)).toEqual({ refused: 401 });
    expect(await connect((await start(world({ enabled: false }), f.dial)).port)).toEqual({ refused: 403 });
  });

  it("takes no ticket from a URL, and only this exact path", async () => {
    const f = fakeWorker();
    const { port } = await start(world(), f.dial);
    for (const path of [
      `/api/v1/apps/${APP}/terminal?ticket=abc`,
      `/api/v1/apps/${APP}/terminal/`,
      `/api/v1/apps/dockify-api-1/terminal`,
      `/api/v1/apps/..%2F..%2Fhost/terminal`,
      "/healthz",
      "/internal/secrets/open",
    ]) {
      expect(await connect(port, { path })).toEqual({ refused: 404 });
    }
  });

  it("answers a plain GET with 426 and no ticket in its contract", async () => {
    const f = fakeWorker();
    const { app } = await start(world(), f.dial);
    const res = await app.inject({ method: "GET", url: `/api/v1/apps/${APP}/terminal`, headers: browserHeaders });
    expect(res.statusCode).toBe(426);
    const { endpoints } = await import("@dockify/contracts");
    expect((endpoints["apps.terminal"] as { query?: unknown }).query).toBeUndefined();
  });
});

describe("the first message", () => {
  it("opens with a good ticket, passes the size and audits who and which app", async () => {
    const w = world();
    const f = fakeWorker();
    const { app, port } = await start(w, f.dial);
    await opened(port, await ticket(app));
    expect(f.dials).toEqual([{ appId: APP, cols: 80, rows: 24 }]);
    expect(w.audits.map((a) => a.action)).toEqual(["terminal.open"]);
    expect(w.audits[0]).toMatchObject({ actorId: "u1", targetId: APP, failed: false });
  });

  it.each([
    ["garbage", "not json"],
    ["a resize first", JSON.stringify({ t: "resize", cols: 80, rows: 24 })],
    ["extra fields", JSON.stringify({ t: "auth", ticket: "a".repeat(43), cols: 80, rows: 24, container: "dockify-api-1" })],
    ["a huge window", JSON.stringify({ t: "auth", ticket: "a".repeat(43), cols: 1e9, rows: 24 })],
    ["a bad ticket shape", JSON.stringify({ t: "auth", ticket: "../../x", cols: 80, rows: 24 })],
  ])("closes on %s", async (_n, msg) => {
    const f = fakeWorker();
    const { port } = await start(world(), f.dial);
    const c = await connected(port);
    c.ws.send(msg);
    expect(await c.closed).toBe(TERMINAL_CLOSE.badMessage);
    expect(f.dials).toEqual([]);
  });

  it("closes on bytes before the ticket, and on no ticket at all", async () => {
    const f = fakeWorker();
    const { port } = await start(world(), f.dial, { authTimeoutMs: 40 });
    const a = await connected(port);
    a.ws.send(Buffer.from("rm -rf /\n"));
    expect(await a.closed).toBe(TERMINAL_CLOSE.badMessage);
    const b = await connected(port);
    expect(await b.closed).toBe(TERMINAL_CLOSE.ticketRefused);
    expect(f.dials).toEqual([]);
  });

  it("refuses a ticket for another app, another client, a replay, and audits it", async () => {
    const w = world();
    const f = fakeWorker();
    const { app, port } = await start(w, f.dial);
    const forOther = await connected(port);
    forOther.ws.send(auth(await ticket(app, OTHER_APP)));
    expect(await forOther.closed).toBe(TERMINAL_CLOSE.ticketRefused);

    const stolen = await ticket(app, APP, { ...browserHeaders, "user-agent": "the victim's browser" });
    const thief = await connected(port);
    thief.ws.send(auth(stolen));
    expect(await thief.closed).toBe(TERMINAL_CLOSE.ticketRefused);

    const once = await ticket(app);
    await opened(port, once);
    const replay = await connected(port);
    replay.ws.send(auth(once));
    expect(await replay.closed).toBe(TERMINAL_CLOSE.ticketRefused);
    expect(f.dials.length).toBe(1);
    expect(w.audits.filter((a) => a.action === "terminal.refused").length).toBe(3);
  });

  it("reads a container the worker refused as that, never as the visitor's access ending", () => {
    expect(closeForRefusal(JSON.stringify({ code: "refused" }))).toBe("targetRefused");
    expect(closeForRefusal(JSON.stringify({ code: "disabled" }))).toBe("accessEnded");
    expect(closeForRefusal(JSON.stringify({ code: "not_running" }))).toBe("notRunning");
    expect(closeForRefusal(JSON.stringify({ code: "not_found" }))).toBe("appGone");
    expect(closeForRefusal(JSON.stringify({ code: "too_many" }))).toBe("tooMany");
    for (const body of ["", "not json", "null", JSON.stringify({ code: "constructor" }), JSON.stringify({ code: 403 }), JSON.stringify({ code: "unauthenticated" })]) {
      expect(closeForRefusal(body), body).toBe("unavailable");
    }
  });

  it("tells the browser what the worker said in a fixed code, and nothing the daemon wrote", async () => {
    for (const [close, code] of [["notRunning", TERMINAL_CLOSE.notRunning], ["appGone", TERMINAL_CLOSE.appGone], ["targetRefused", TERMINAL_CLOSE.targetRefused], ["unavailable", TERMINAL_CLOSE.unavailable]] as const) {
      const { app, port } = await start(world(), async () => {
        throw new WorkerRefused(close);
      });
      const c = await connected(port);
      c.ws.send(auth(await ticket(app)));
      expect(await c.closed).toBe(code);
      expect(c.text).toEqual([]);
    }
    const { app, port } = await start(world(), async () => {
      throw new Error("dial tcp 172.30.4.2:2375: secret internal detail");
    });
    const c = await connected(port);
    c.ws.send(auth(await ticket(app)));
    expect(await c.closed).toBe(TERMINAL_CLOSE.unavailable);
    expect(c.text.join("")).not.toContain("172.30");
  });
});

describe("an open session", () => {
  it("passes bytes and resizes, and validates a resize", async () => {
    const f = fakeWorker();
    const { app, port } = await start(world(), f.dial);
    const c = await opened(port, await ticket(app));
    c.ws.send(Buffer.from("ls\n"));
    c.ws.send(JSON.stringify({ t: "resize", cols: 100, rows: 30 }));
    await until(() => f.sent.length === 2);
    expect(f.sent[0]).toEqual({ type: FRAME.data, body: "ls\n" });
    expect(JSON.parse(f.sent[1]!.body)).toEqual({ t: "resize", cols: 100, rows: 30 });
    f.say("hello");
    await until(() => c.bytes.length === 1);
    expect(c.bytes[0]!.toString()).toBe("hello");
    c.ws.send(JSON.stringify({ t: "resize", cols: 1e6, rows: 0 }));
    expect(await c.closed).toBe(TERMINAL_CLOSE.badMessage);
    expect(f.destroyed()).toBe(true);
  });

  it("closes a message past the size limit, at the socket", async () => {
    const f = fakeWorker();
    const { app, port } = await start(world(), f.dial);
    const c = await opened(port, await ticket(app));
    c.ws.send(Buffer.alloc(TERMINAL.maxMessageBytes + 1));
    expect(await c.closed).toBe(1009);
    expect(f.sent).toEqual([]);
    await until(() => f.destroyed());
  });

  it("closes past the sustained input rate, and takes a paste inside the burst", async () => {
    const f = fakeWorker();
    const { app, port } = await start(world(), f.dial);
    const c = await opened(port, await ticket(app));
    const chunk = Buffer.alloc(TERMINAL.maxMessageBytes);
    for (let i = 0; i < 4; i++) c.ws.send(chunk);
    await until(() => f.sent.length === 4);
    for (let i = 0; i < 30; i++) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(chunk);
    expect(await c.closed).toBe(TERMINAL_CLOSE.inputTooFast);
  });

  const endsWhen: Array<[string, (w: World) => void, number]> = [
    ["the session is revoked", (w) => void (w.revoked = true), TERMINAL_CLOSE.accessEnded],
    ["the role drops to Viewer", (w) => void (w.role = "viewer"), TERMINAL_CLOSE.accessEnded],
    ["the user is removed", (w) => void (w.member = false), TERMINAL_CLOSE.accessEnded],
    ["the user is disabled", (w) => void (w.disabled = true), TERMINAL_CLOSE.accessEnded],
    ["the app is removed", (w) => void (w.appExists = false), TERMINAL_CLOSE.appGone],
    ["the instance switch goes off", (w) => void (w.enabled = false), TERMINAL_CLOSE.accessEnded],
  ];
  it.each(endsWhen)("ends when %s, and the worker's socket goes with it", async (_n, change, code) => {
    const w = world();
    const f = fakeWorker();
    const { app, port } = await start(w, f.dial, { recheckMs: 20 });
    const c = await opened(port, await ticket(app));
    change(w);
    expect(await c.closed).toBe(code);
    expect(f.destroyed()).toBe(true);
    await until(() => w.audits.some((a) => a.action === "terminal.close"));
  });

  it("does not stay open on a recheck that cannot reach the database", async () => {
    const w = world();
    const f = fakeWorker();
    const db = fakeDb(w);
    const { app } = await buildApp({ db, ring: testRing(), config: testConfig(), logger: false, workerWatch: false, integrations: false, terminalDial: f.dial, terminalLimits: { recheckMs: 20 } });
    await app.listen({ port: 0, host: "127.0.0.1" });
    open.push(() => app.close());
    const c = await opened((app.server.address() as AddressInfo).port, await ticket(app as never));
    (db.app as unknown as { findUnique: () => Promise<never> }).findUnique = async () => {
      throw new Error("database down");
    };
    expect(await c.closed).toBe(TERMINAL_CLOSE.unavailable);
  });

  it("ends at the idle limit though output keeps coming, and at the total limit though input does", async () => {
    const w = world();
    const f = fakeWorker();
    const a = await start(w, f.dial, { recheckMs: 10, idleMs: 60 });
    const idle = await opened(a.port, await ticket(a.app));
    const noisy = setInterval(() => f.say("tail -f output\n"), 5);
    expect(await idle.closed).toBe(TERMINAL_CLOSE.idle);
    clearInterval(noisy);

    const g = fakeWorker();
    const b = await start(world(), g.dial, { recheckMs: 10, totalMs: 80 });
    const busy = await opened(b.port, await ticket(b.app));
    const typing = setInterval(() => busy.ws.readyState === WebSocket.OPEN && busy.ws.send(Buffer.from("x")), 5);
    expect(await busy.closed).toBe(TERMINAL_CLOSE.timeLimit);
    clearInterval(typing);
  });

  it("holds the per-user, per-app and instance ceilings, also for tickets spent together", async () => {
    const f = fakeWorker();
    const { app, port } = await start(world(), f.dial, { maxPerUser: 2 });
    const tickets = [await ticket(app), await ticket(app), await ticket(app), await ticket(app)];
    const conns = await Promise.all(tickets.map(() => connected(port)));
    conns.forEach((c, i) => c.ws.send(auth(tickets[i]!)));
    await until(() => conns.filter((c) => c.ws.readyState !== WebSocket.OPEN).length === 2);
    const codes = await Promise.all(conns.filter((c) => c.ws.readyState !== WebSocket.OPEN).map((c) => c.closed));
    expect(codes).toEqual([TERMINAL_CLOSE.tooMany, TERMINAL_CLOSE.tooMany]);
  });

  it("says the image has no shell, and when the shell exits", async () => {
    const f = fakeWorker();
    const { app, port } = await start(world(), f.dial);
    const c = await opened(port, await ticket(app));
    f.finish("no_shell", 127);
    await new Promise((r) => setTimeout(r, 5));
    f.destroyed();
    (await f.dial(APP, { cols: 1, rows: 1 })).socket.push(null);
    expect(await c.closed).toBe(TERMINAL_CLOSE.noShell);
  });

  it("closes the worker's side when the browser leaves, and audits the close with why", async () => {
    const w = world();
    const f = fakeWorker();
    const { app, port } = await start(w, f.dial);
    const c = await opened(port, await ticket(app));
    c.ws.terminate();
    await until(() => f.destroyed());
    await until(() => w.audits.some((a) => a.action === "terminal.close"));
    expect(w.audits.find((a) => a.action === "terminal.close")?.suffix).toContain("the browser left");
  });

  it("writes no keystroke, output or ticket to the log or the audit rows", async () => {
    const lines: string[] = [];
    const w = world();
    const f = fakeWorker();
    const { app } = await buildApp({
      db: fakeDb(w), ring: testRing(), config: testConfig({ logLevel: "trace" }), workerWatch: false, integrations: false, terminalDial: f.dial,
    });
    const spy = (app.log as unknown as { warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void });
    spy.warn = (...a) => void lines.push(JSON.stringify(a));
    spy.info = (...a) => void lines.push(JSON.stringify(a));
    await app.listen({ port: 0, host: "127.0.0.1" });
    open.push(() => app.close());
    const t = await ticket(app as never);
    const c = await opened((app.server.address() as AddressInfo).port, t);
    c.ws.send(Buffer.from("echo hunter2-secret\n"));
    await until(() => f.sent.length === 1);
    f.say("output-secret");
    await until(() => c.bytes.length === 1);
    c.ws.close();
    await until(() => w.audits.some((a) => a.action === "terminal.close"));
    const all = lines.join("\n") + JSON.stringify(w.audits);
    expect(all).not.toContain("hunter2-secret");
    expect(all).not.toContain("output-secret");
    expect(all).not.toContain(t);
  });
});
