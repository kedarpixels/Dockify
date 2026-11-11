/**
 * The agent's end of the link: it dials out, then only answers. WebSocket so ordinary proxies carry it, then
 * mutual TLS 1.3 with the worker's certificate pinned, then HTTP/2 with the worker as client. No session
 * resumption or early data, and certificate dates are never read, so no clock can break the link.
 */
import { link as L } from "@dockify/contracts";
import { capWrites, writesAsBuffers } from "@dockify/engine";
import { X509Certificate } from "node:crypto";
import http2, { type IncomingHttpHeaders, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2";
import tls, { type TLSSocket } from "node:tls";
import { createWebSocketStream, WebSocket } from "ws";

export const pinOf = (certPem: string | Buffer): string => new X509Certificate(certPem).fingerprint256;

export interface LinkOptions {
  url: string;
  key: string | Buffer;
  cert: string | Buffer;
  /** The worker's certificate fingerprint. A mismatch hangs up before anything is sent. */
  workerPin: string;
  joinToken: () => Promise<string | null>;
  onJoined: () => Promise<void>;
  /** A connection ended and the worker never spoke HTTP/2 on it: it does not know this key (any more). */
  onUnknown?: () => void;
  onStream: (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => void;
  log: (msg: string, extra?: object) => void;
  random?: () => number;
  pingEveryMs?: number;
}

export interface LinkHandle {
  stop(): Promise<void>;
  up(): boolean;
}

/** One connection, resolved when it ends. Answers `true` if it ever carried a session. */
function connectOnce(o: LinkOptions, set: (s: ServerHttp2Session | null) => void, stopped: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let carried = false;
    let known = false;
    let done = false;
    let socket: TLSSocket | null = null;
    let ping: NodeJS.Timeout | null = null;
    const ws = new WebSocket(o.url, { perMessageDeflate: false, maxPayload: L.LINK_LIMITS.wsMaxPayload, handshakeTimeout: L.LINK_LIMITS.handshakeMs });
    const finish = (reason?: string): void => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      if (ping) clearInterval(ping);
      stopped.removeEventListener("abort", onStop);
      set(null);
      if (reason) o.log(reason);
      socket?.destroy();
      ws.terminate();
      resolve(carried);
    };
    const onStop = (): void => finish();
    stopped.addEventListener("abort", onStop, { once: true });
    const deadline = setTimeout(() => finish("the link's handshake took too long"), L.LINK_LIMITS.handshakeMs);
    ws.on("error", (e: Error) => finish(`could not reach the control plane: ${e.message}`));
    ws.on("close", () => finish());

    const duplex = capWrites(createWebSocketStream(ws), L.LINK_LIMITS.wsWriteBytes);
    duplex.on("error", () => {});
    socket = tls.connect({
      socket: duplex,
      key: o.key,
      cert: o.cert,
      rejectUnauthorized: false,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      servername: "link",
    });
    const s = socket;
    s.on("error", (e: Error) => finish(`the link's TLS failed: ${e.message}`));
    s.once("close", () => finish());
    s.once("secureConnect", () => {
      void (async () => {
        const peer = s.getPeerX509Certificate()?.fingerprint256;
        if (peer !== o.workerPin) return finish("the control plane's certificate does not match the pin; hanging up");
        const token = await o.joinToken().catch(() => null);
        if (token) return enroll(s, token);
        clearTimeout(deadline);
        const session = http2.performServerHandshake(s, {
          settings: { initialWindowSize: L.LINK_LIMITS.h2InitialWindow, maxConcurrentStreams: L.LINK_LIMITS.h2MaxConcurrentStreams },
          maxSessionMemory: L.LINK_LIMITS.h2MaxSessionMemoryMb,
        });
        session.on("error", () => {});
        session.once("close", () => finish());
        session.once("connect", () => {
          if (!session.destroyed) session.setLocalWindowSize(L.LINK_LIMITS.h2SessionWindow);
        });
        session.on("stream", (st, headers) => o.onStream(writesAsBuffers(st), headers));
        carried = true;
        set(session);
        session.once("remoteSettings", () => {
          known = true;
        });
        session.once("close", () => {
          if (!known) o.onUnknown?.();
        });
        // A partition leaves a connection that looks alive; two unanswered pings end it, so the redial starts.
        let missed = 0;
        ping = setInterval(() => {
          if (missed >= L.LINK_LIMITS.pingMisses) return finish("the control plane stopped answering");
          missed++;
          try {
            session.ping((e) => {
              if (!e) missed = 0;
            });
          } catch {
            finish();
          }
        }, o.pingEveryMs ?? L.LINK_LIMITS.pingEveryMs);
        ping.unref();
      })().catch((e: unknown) => finish(`the link failed: ${e instanceof Error ? e.message : String(e)}`));
    });

    const enroll = (t: TLSSocket, token: string): void => {
      let got = "";
      t.setEncoding("utf8");
      t.on("data", (chunk: string) => {
        got += chunk;
        const nl = got.indexOf("\n");
        if (nl === -1 && got.length < L.LINK_LIMITS.joinLineBytes) return;
        let answer: { ok?: unknown; error?: unknown } | null = null;
        try {
          answer = JSON.parse(got.slice(0, nl === -1 ? undefined : nl)) as { ok?: unknown; error?: unknown };
        } catch {
          // HTTP/2 bytes, not a line: the worker already knows this key, so the token was left over.
        }
        if (answer && answer.ok !== true) return finish(`the join was refused: ${String(answer.error ?? "no reason given")}`);
        void o.onJoined().then(() => finish(), (e: unknown) => finish(`could not record the join: ${e instanceof Error ? e.message : String(e)}`));
      });
      t.write(`${JSON.stringify({ join: token })}\n`);
    };
  });
}

/** Dials until stopped: 1 s doubling to 60 s, with 20 percent jitter. A session that was up resets it. */
export function runLink(o: LinkOptions): LinkHandle {
  const ac = new AbortController();
  let current: ServerHttp2Session | null = null;
  const random = o.random ?? Math.random;
  const loop = (async () => {
    let delay: number = L.LINK_LIMITS.redialFirstMs;
    while (!ac.signal.aborted) {
      const carried = await connectOnce(o, (s) => {
        current = s;
      }, ac.signal);
      if (ac.signal.aborted) break;
      if (carried) delay = L.LINK_LIMITS.redialFirstMs;
      const wait = Math.round(delay * (1 - L.LINK_LIMITS.redialJitter + random() * 2 * L.LINK_LIMITS.redialJitter));
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, wait);
        ac.signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        }, { once: true });
      });
      delay = Math.min(delay * 2, L.LINK_LIMITS.redialMaxMs);
    }
  })();
  return {
    up: () => current !== null,
    async stop() {
      ac.abort();
      await loop;
    },
  };
}
