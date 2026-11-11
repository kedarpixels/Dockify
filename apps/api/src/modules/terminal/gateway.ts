// The web terminal's WebSocket, bridged to the worker's control channel. The api holds no Docker access; the worker repeats every check that matters.
// The upgrade runs outside Fastify's request hook, so it repeats that hook's checks by calling the same functions. Nothing secret is in the URL:
// the single-use ticket arrives as the first message. Terminal bytes are never logged or stored.
import { request } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { terminal as T } from "@dockify/contracts";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { roleAtLeast, sessionFromCookie, type SessionActor } from "../../actor.ts";
import type { Ctx } from "../../app.ts";
import { audit } from "../../audit.ts";
import type { ClientResolver } from "../../client-ip.ts";
import { POLICIES } from "../../policy.ts";
import { rateKey } from "../../ratelimit.ts";
import { clientKey, TerminalTickets } from "./tickets.ts";

const { encodeFrame, FRAME, FrameDecoder, TERMINAL, TERMINAL_CLOSE, TerminalClientMessage, TerminalEnd } = T;
type CloseName = T.TerminalCloseName;

const PATH = /^\/api\/v1\/apps\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/terminal$/;
/** The role the catalog gives this route: one source, so the two doors cannot drift apart. */
const ROLE = POLICIES["apps.terminal"].role;

export class WorkerRefused extends Error {
  readonly close: CloseName;
  constructor(close: CloseName) {
    super(close);
    this.name = "WorkerRefused";
    this.close = close;
  }
}

export type WorkerDial = (appId: string, size: { cols: number; rows: number }) => Promise<{ socket: Duplex; head: Buffer }>;

/** The worker's refusal codes (worker terminal/session.ts). Anything else reads as the worker being unavailable. */
const REFUSAL_CLOSE: Record<string, CloseName> = { disabled: "accessEnded", refused: "targetRefused", not_found: "appGone", not_running: "notRunning", too_many: "tooMany" };

export function closeForRefusal(body: string): CloseName {
  const code = (safeJson(body) as { code?: unknown } | null)?.code;
  return (typeof code === "string" && Object.hasOwn(REFUSAL_CLOSE, code) && REFUSAL_CLOSE[code]) || "unavailable";
}

export function httpWorkerDial(baseUrl: string | undefined, token: () => string): WorkerDial {
  return (appId, size) =>
    new Promise((resolve, reject) => {
      if (!baseUrl) return reject(new WorkerRefused("unavailable"));
      const url = new URL(baseUrl);
      const req = request({
        host: url.hostname, port: url.port, method: "GET",
        path: `/terminal/${appId}?cols=${size.cols}&rows=${size.rows}`,
        headers: { Connection: "Upgrade", Upgrade: "dockify-terminal", Authorization: `Bearer ${token()}` },
        timeout: 10_000,
      });
      req.on("upgrade", (_res, socket, head) => {
        socket.setTimeout(0);
        resolve({ socket, head });
      });
      req.on("response", (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => void (body = (body + c).slice(0, 200)));
        res.on("end", () => reject(new WorkerRefused(closeForRefusal(body))));
        res.on("error", () => reject(new WorkerRefused("unavailable")));
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => reject(new WorkerRefused("unavailable")));
      req.end();
    });
}

interface Session {
  actor: SessionActor;
  appId: string;
  appName: string;
  ip: string;
  userAgent: string | null;
  ws: WebSocket;
  worker: Duplex | null;
  openedAt: number;
  lastInputAt: number;
  allowance: number;
  allowanceAt: number;
  audited: boolean;
  ended: boolean;
  alive: boolean;
}

export interface TerminalLimits {
  authTimeoutMs: number;
  idleMs: number;
  totalMs: number;
  recheckMs: number;
  heartbeatMs: number;
  maxPerUser: number;
  maxPerApp: number;
  maxPerInstance: number;
}

export interface TerminalHub {
  tickets: TerminalTickets;
  count(): number;
  close(): void;
}

function refuseUpgrade(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

const WHY: Record<CloseName, string> = {
  exited: "the shell exited",
  left: "the browser left",
  badMessage: "a message it could not read",
  ticketRefused: "a refused ticket",
  accessEnded: "access ended",
  appGone: "the app was removed",
  targetRefused: "a refused container",
  idle: "the idle limit",
  timeLimit: "the time limit",
  inputTooFast: "too much input",
  tooMany: "too many sessions",
  notRunning: "the app stopped",
  noShell: "no shell in the image",
  unavailable: "the worker being unavailable",
};

/** `upgrade` is the only upgrade listener on this server, so any other path is refused here rather than falling through to a route. */
export function attachTerminalGateway(server: Server, ctx: Pick<Ctx, "db" | "web" | "limits">, resolveClient: ClientResolver, o: { dial: WorkerDial; tickets?: TerminalTickets; limits?: Partial<TerminalLimits>; log?: (msg: string, extra?: object) => void }): TerminalHub {
  const { db, web, limits } = ctx;
  const tickets = o.tickets ?? new TerminalTickets();
  const cfg: TerminalLimits = {
    authTimeoutMs: TERMINAL.authTimeoutMs, idleMs: TERMINAL.idleMs, totalMs: TERMINAL.totalMs, recheckMs: TERMINAL.recheckMs, heartbeatMs: TERMINAL.heartbeatMs,
    maxPerUser: TERMINAL.maxPerUser, maxPerApp: TERMINAL.maxPerApp, maxPerInstance: TERMINAL.maxPerInstance, ...o.limits,
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: TERMINAL.maxMessageBytes, perMessageDeflate: false, clientTracking: false });
  const sessions = new Set<Session>();

  const writeAudit = (s: Session, action: string, verb: string, suffix: string | null, failed = false) =>
    audit(db, {
      category: "access", action, verb, actorType: "user", actorId: s.actor.userId, actorName: s.actor.name, targetType: "app", targetId: s.appId,
      targetLabel: s.appName, suffix, failed, ip: s.ip, userAgent: s.userAgent,
    }).catch((e: unknown) => o.log?.("terminal audit failed", { error: e instanceof Error ? e.message.slice(0, 200) : "unknown" }));

  const end = (s: Session, why: CloseName) => {
    if (s.ended) return;
    s.ended = true;
    sessions.delete(s);
    // Destroying this socket is what tells the worker to end the shell (worker terminal/session.ts).
    s.worker?.destroy();
    // A socket already closing finishes by itself, its code (1009 for a message past the limit) included.
    if (s.ws.readyState === WebSocket.OPEN) s.ws.close(TERMINAL_CLOSE[why], why);
    if (s.audited) {
      const minutes = Math.max(1, Math.round((Date.now() - s.openedAt) / 60_000));
      void writeAudit(s, "terminal.close", "closed a terminal into", `(${WHY[why]}, after ${minutes} ${minutes === 1 ? "minute" : "minutes"})`);
    }
  };

  /** Everything that may have changed since the socket opened. Reads rows only: it never extends a session. */
  const stillAllowed = async (s: Session, now: Date): Promise<CloseName | null> => {
    const [row, inst, app] = await Promise.all([
      db.session.findUnique({ where: { id: s.actor.sessionId }, select: { revokedAt: true, expiresAt: true, absoluteExpiresAt: true, user: { select: { disabledAt: true, member: { select: { role: true } } } } } }),
      db.instance.findUnique({ where: { id: 1 }, select: { terminalEnabled: true } }),
      db.app.findUnique({ where: { id: s.appId }, select: { id: true } }),
    ]);
    if (!app) return "appGone";
    if (!inst?.terminalEnabled) return "accessEnded";
    if (!row || row.revokedAt || row.expiresAt <= now || row.absoluteExpiresAt <= now) return "accessEnded";
    if (row.user.disabledAt || !row.user.member || !roleAtLeast(row.user.member.role, ROLE)) return "accessEnded";
    return null;
  };

  const tick = async () => {
    const at = Date.now();
    await Promise.all(
      [...sessions].map(async (s) => {
        if (at - s.openedAt >= cfg.totalMs) return end(s, "timeLimit");
        if (at - s.lastInputAt >= cfg.idleMs) return end(s, "idle");
        try {
          const verdict = await stillAllowed(s, new Date(at));
          if (verdict) end(s, verdict);
        } catch {
          // A database that cannot answer cannot vouch for this session.
          end(s, "unavailable");
        }
      }),
    );
  };
  const ticker = setInterval(() => void tick(), cfg.recheckMs);
  ticker.unref();
  const heart = setInterval(() => {
    for (const s of sessions) {
      if (s.ws.readyState !== WebSocket.OPEN) continue;
      if (!s.alive) {
        end(s, "unavailable");
        continue;
      }
      s.alive = false;
      s.ws.ping();
    }
  }, cfg.heartbeatMs);
  heart.unref();

  /** Spends input allowance; false past the sustained rate. A paste within the burst is fine. */
  const spend = (s: Session, bytes: number, now: number): boolean => {
    s.allowance = Math.min(TERMINAL.inputBurstBytes, s.allowance + ((now - s.allowanceAt) / 1000) * TERMINAL.inputBytesPerSecond);
    s.allowanceAt = now;
    if (bytes > s.allowance) return false;
    s.allowance -= bytes;
    return true;
  };

  const connectWorker = async (s: Session, size: { cols: number; rows: number }) => {
    let dialed: { socket: Duplex; head: Buffer };
    try {
      dialed = await o.dial(s.appId, size);
    } catch (e) {
      end(s, e instanceof WorkerRefused ? e.close : "unavailable");
      return;
    }
    if (s.ended) {
      dialed.socket.destroy();
      return;
    }
    const worker = dialed.socket;
    s.worker = worker;
    const decoder = new FrameDecoder();
    let finished: CloseName | null = null;
    const onData = (chunk: Buffer) => {
      try {
        decoder.push(chunk, (type, payload) => {
          if (type === FRAME.data) {
            if (s.ws.readyState !== WebSocket.OPEN) return;
            s.ws.send(payload, { binary: true });
            // Output waits for a slow browser, so a flood fills neither this process nor its memory limit.
            if (s.ws.bufferedAmount > TERMINAL.outputHighWaterBytes && !worker.isPaused()) {
              worker.pause();
              const resume = setInterval(() => {
                if (s.ended || s.ws.bufferedAmount <= TERMINAL.outputHighWaterBytes / 2) {
                  clearInterval(resume);
                  if (!s.ended) worker.resume();
                }
              }, 50);
              resume.unref();
            }
          } else if (type === FRAME.end) {
            const parsed = TerminalEnd.safeParse(safeJson(payload.toString("utf8")));
            finished = parsed.success && parsed.data.reason === "no_shell" ? "noShell" : "exited";
          }
        });
      } catch {
        end(s, "unavailable");
      }
    };
    worker.on("data", onData);
    worker.on("error", () => end(s, finished ?? "unavailable"));
    worker.on("end", () => end(s, finished ?? "unavailable"));
    worker.on("close", () => end(s, finished ?? "unavailable"));
    if (dialed.head.length) onData(dialed.head);
    s.audited = true;
    await writeAudit(s, "terminal.open", "opened a terminal into", null);
    if (!s.ended && s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ t: "ready" }));
  };

  const onConnection = (ws: WebSocket, actor: SessionActor, appId: string, ip: string, userAgent: string | null) => {
    let session: Session | null = null;
    const authTimer = setTimeout(() => ws.close(TERMINAL_CLOSE.ticketRefused, "ticketRefused"), cfg.authTimeoutMs);
    authTimer.unref();
    let authing = false;

    const authenticate = async (data: RawData) => {
      authing = true;
      const msg = TerminalClientMessage.safeParse(safeJson(data.toString()));
      if (!msg.success || msg.data.t !== "auth") return ws.close(TERMINAL_CLOSE.badMessage, "badMessage");
      const ok = tickets.consume(msg.data.ticket, { sessionId: actor.sessionId, appId, client: clientKey(ip, userAgent ?? undefined) });
      clearTimeout(authTimer);
      const app = await db.app.findUnique({ where: { id: appId }, select: { name: true } });
      const now = Date.now();
      const s: Session = {
        actor, appId, appName: app?.name ?? appId, ip, userAgent, ws, worker: null, openedAt: now, lastInputAt: now,
        allowance: TERMINAL.inputBurstBytes, allowanceAt: now, audited: false, ended: false, alive: true,
      };
      if (!ok) {
        await writeAudit(s, "terminal.refused", "was refused a terminal into", "(the ticket did not match this session, app and client)", true);
        return ws.close(TERMINAL_CLOSE.ticketRefused, "ticketRefused");
      }
      if (!app) return ws.close(TERMINAL_CLOSE.appGone, "appGone");
      // It may have gone while the checks above waited, and then nothing would ever end this session.
      if (ws.readyState !== WebSocket.OPEN) return;
      const all = [...sessions];
      if (all.length >= cfg.maxPerInstance || all.filter((x) => x.actor.userId === actor.userId).length >= cfg.maxPerUser || all.filter((x) => x.appId === appId).length >= cfg.maxPerApp) {
        return ws.close(TERMINAL_CLOSE.tooMany, "tooMany");
      }
      // Counted from here, so a burst of tickets cannot pass a ceiling while each one dials the worker.
      sessions.add(s);
      session = s;
      await connectWorker(s, { cols: msg.data.cols, rows: msg.data.rows });
    };

    // The socket library closes itself on a protocol error, with the right code.
    ws.on("error", () => {
      if (session) end(session, "badMessage");
    });
    ws.on("close", () => {
      clearTimeout(authTimer);
      if (session) end(session, "left");
    });
    ws.on("pong", () => {
      if (session) session.alive = true;
    });
    ws.on("message", (data, isBinary) => {
      if (!session) {
        // One ticket per socket. Anything before the answer is a client not following the protocol.
        if (authing || isBinary) return ws.close(TERMINAL_CLOSE.badMessage, "badMessage");
        void authenticate(data).catch(() => ws.close(TERMINAL_CLOSE.unavailable, "unavailable"));
        return;
      }
      const s = session;
      if (isBinary) {
        const bytes = data as Buffer;
        const now = Date.now();
        if (!spend(s, bytes.length, now)) return end(s, "inputTooFast");
        s.lastInputAt = now;
        if (s.worker && !s.worker.destroyed) s.worker.write(encodeFrame(FRAME.data, bytes));
        return;
      }
      const msg = TerminalClientMessage.safeParse(safeJson(data.toString()));
      if (!msg.success || msg.data.t !== "resize") return end(s, "badMessage");
      if (s.worker && !s.worker.destroyed) s.worker.write(encodeFrame(FRAME.resize, JSON.stringify(msg.data)));
    });
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    void (async () => {
      // The whole request line: a query string has no business here, least of all a ticket in one.
      const m = PATH.exec(req.url ?? "");
      if (req.method !== "GET" || !m) return refuseUpgrade(socket, 404, "Not Found");
      const appId = m[1]!;
      const client = resolveClient(req.socket.remoteAddress, req.headers);
      if (!client.known) return refuseUpgrade(socket, 400, "Bad Request");
      if (limits.general.take(rateKey(client.ip)) !== null) return refuseUpgrade(socket, 429, "Too Many Requests");
      if (req.headers.authorization) return refuseUpgrade(socket, 403, "Forbidden");
      const actor = await sessionFromCookie(db, req as never, web);
      if (!actor) return refuseUpgrade(socket, 401, "Unauthorized");
      if (!roleAtLeast(actor.role, ROLE)) return refuseUpgrade(socket, 403, "Forbidden");
      const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
      // A browser always sends these on a WebSocket, and a page elsewhere cannot forge them. The cookie
      // rides along on a cross-site socket, so this is the whole defence against hijacking one.
      const fetchSite = req.headers["sec-fetch-site"];
      if (req.headers.origin !== web.origin || (fetchSite !== undefined && fetchSite !== "same-origin")) {
        await audit(db, {
          category: "access", action: "terminal.refused", verb: "was refused a terminal", actorType: "user", actorId: actor.userId, actorName: actor.name,
          targetType: "app", targetId: appId, suffix: "(from another origin)", failed: true, ip: client.ip, userAgent,
        }).catch(() => {});
        return refuseUpgrade(socket, 403, "Forbidden");
      }
      // The step-up that bought the ticket must still hold when it is spent.
      if (!actor.elevated) return refuseUpgrade(socket, 403, "Forbidden");
      const inst = await db.instance.findUnique({ where: { id: 1 }, select: { terminalEnabled: true } });
      if (!inst?.terminalEnabled) return refuseUpgrade(socket, 403, "Forbidden");
      if (socket.destroyed) return;
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, actor, appId, client.ip, userAgent));
    })().catch((e: unknown) => {
      o.log?.("terminal upgrade failed", { error: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
      refuseUpgrade(socket, 500, "Internal Server Error");
    });
  };
  server.on("upgrade", onUpgrade);

  return {
    tickets,
    count: () => sessions.size,
    close() {
      clearInterval(ticker);
      clearInterval(heart);
      server.off("upgrade", onUpgrade);
      for (const s of [...sessions]) end(s, "unavailable");
      wss.close();
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
