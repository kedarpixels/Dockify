/**
 * Inside the WebSocket the worker is the TLS 1.3 server asking for the agent's certificate, then the
 * HTTP/2 client. A hand-made TLSSocket over the stream never finishes setup, hence tls.createServer.
 * A second connection with a known key is refused while the first answers a ping, as a stolen key would.
 */
import { constants as cryptoConstants } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import http2 from "node:http2";
import type { Socket } from "node:net";
import tls, { type TLSSocket } from "node:tls";
import { link as L } from "@dockify/contracts";
import { capWrites } from "@dockify/engine";
import { createWebSocketStream, WebSocketServer, type WebSocket } from "ws";
import { LinkSession } from "./session.ts";
import type { KnownServer } from "./enroll.ts";

export interface ListenerDeps {
  key: string | Buffer;
  cert: string | Buffer;
  serverByPin(pin: string): Promise<KnownServer | null>;
  enroll(token: string, pin: string, ip: string | null): Promise<boolean>;
  existing(serverId: string): LinkSession | null;
  onSession(session: LinkSession): void;
  log(msg: string, extra?: object): void;
  pingEveryMs?: number;
}

export interface LinkListener {
  listen(port: number, host: string): Promise<void>;
  server: Server;
  close(): Promise<void>;
}

export function createLinkListener(deps: ListenerDeps): LinkListener {
  const { log } = deps;
  let unauthenticated = 0;
  const open = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: L.LINK_LIMITS.wsMaxPayload });
  const server = createServer((_req, res) => {
    res.writeHead(404).end();
  });

  const tlsOptions: tls.TlsOptions = {
    key: deps.key,
    cert: deps.cert,
    requestCert: true,
    rejectUnauthorized: false,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    secureOptions: cryptoConstants.SSL_OP_NO_TICKET,
    handshakeTimeout: L.LINK_LIMITS.handshakeMs,
  };

  const takeJoinLine = (socket: TLSSocket, pin: string, ip: string | null): void => {
    let got = "";
    const timer = setTimeout(() => socket.destroy(), L.LINK_LIMITS.joinLineMs);
    socket.setEncoding("utf8");
    const answer = (line: object): void => {
      socket.end(`${JSON.stringify(line)}\n`);
    };
    socket.on("data", (chunk: string) => {
      got += chunk;
      if (got.length > L.LINK_LIMITS.joinLineBytes) return socket.destroy();
      const nl = got.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      socket.removeAllListeners("data");
      let token: string;
      try {
        token = L.JoinLine.parse(JSON.parse(got.slice(0, nl))).join;
      } catch {
        return socket.destroy();
      }
      void deps.enroll(token, pin, ip).then(
        (ok) => {
          if (ok) log("a server joined", { pin });
          else log("a join was refused", { pin, ip });
          answer(ok ? { ok: true } : { error: "This join code was already used, or it expired. Do not approve anything in the dashboard." });
        },
        (e: unknown) => {
          log("a join could not be recorded", { error: e instanceof Error ? e.message : String(e) });
          socket.destroy();
        },
      );
    });
    socket.once("close", () => clearTimeout(timer));
  };

  /** `proven` ends a connection's place among the unauthenticated; one with an unknown key keeps it until it closes. */
  const accept = async (socket: TLSSocket, ip: string | null, proven: () => void): Promise<void> => {
    const pin = socket.getPeerX509Certificate()?.fingerprint256;
    if (!pin) return void socket.destroy();
    const known = await deps.serverByPin(pin);
    if (!known) return takeJoinLine(socket, pin, ip);
    proven();
    if (known.state === "revoked" || known.state === "awaiting_join") {
      log("a link with a key that may not connect was refused", { pin, state: known.state });
      return void socket.destroy();
    }
    const previous = deps.existing(known.id);
    if (previous?.alive) {
      if (await previous.answersPing()) {
        log("a second link with a known key was refused: the first still answers. If this repeats, that key may be stolen", { serverId: known.id, ip });
        return void socket.destroy();
      }
      previous.destroy();
    }
    if (socket.destroyed) return;
    const h2 = http2.connect("http://link", {
      createConnection: () => socket,
      settings: { initialWindowSize: L.LINK_LIMITS.h2InitialWindow, enablePush: false },
      maxSessionMemory: L.LINK_LIMITS.h2MaxSessionMemoryMb,
    });
    h2.once("connect", () => {
      if (!h2.destroyed) h2.setLocalWindowSize(L.LINK_LIMITS.h2SessionWindow);
    });
    const session = new LinkSession(h2, { serverId: known.id, infoOnly: known.state !== "active", ...(deps.pingEveryMs ? { pingEveryMs: deps.pingEveryMs } : {}) });
    // Only once the agent has spoken HTTP/2. An agent with a leftover token sends its join line instead,
    // which ends this connection, and it comes straight back without it.
    h2.once("remoteSettings", () => deps.onSession(session));
  };

  const onConnection = (ws: WebSocket, ip: string | null): void => {
    open.add(ws);
    ws.once("close", () => open.delete(ws));
    const duplex = capWrites(createWebSocketStream(ws), L.LINK_LIMITS.wsWriteBytes);
    duplex.on("error", () => {});
    unauthenticated++;
    let counted = true;
    const settle = (): void => {
      if (counted) unauthenticated--;
      counted = false;
      clearTimeout(deadline);
    };
    const deadline = setTimeout(() => {
      settle();
      ws.terminate();
    }, L.LINK_LIMITS.handshakeMs);
    ws.once("close", settle);
    // One TLS server per connection, so the socket it hands back is known to be this connection's.
    const secure = tls.createServer(tlsOptions);
    secure.on("tlsClientError", (e) => {
      log("a link's TLS failed", { error: e.message, ip });
      ws.terminate();
    });
    secure.once("secureConnection", (socket: TLSSocket) => {
      clearTimeout(deadline);
      socket.on("error", () => {});
      socket.once("close", () => ws.terminate());
      void accept(socket, ip, settle).catch((e: unknown) => {
        log("a link could not be accepted", { error: e instanceof Error ? e.message : String(e) });
        socket.destroy();
      });
    });
    secure.emit("connection", duplex);
  };

  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    // The bare path, never new URL: a target like //[ makes it throw, and nothing here would catch that.
    if ((req.url ?? "/").split("?", 1)[0] !== "/link" || unauthenticated >= L.LINK_LIMITS.maxUnauthenticated) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, socket.remoteAddress ?? null));
  });

  return {
    server,
    listen: (port, host) => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    }),
    async close() {
      for (const ws of open) ws.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
