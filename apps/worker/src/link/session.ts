/** Every call is one HTTP/2 stream. PING every 15 s; two misses end the session and every call on it. */
import { constants as h2c, type ClientHttp2Session, type ClientHttp2Stream, type OutgoingHttpHeaders } from "node:http2";
import { link as L } from "@dockify/contracts";
import { writesAsBuffers } from "@dockify/engine";

/** A call found no link, or lost it. A retry after the reconnect is safe: nothing else is known. */
export class LinkDownError extends Error {
  constructor(message = "the link to this server is down") {
    super(message);
    this.name = "LinkDownError";
  }
}

/** Refused by the agent: a clear answer, which a retry will not change. */
export class AgentRefusal extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "AgentRefusal";
  }
}

const JSON_MAX = 16 * 1024 * 1024;
const CALL_TIMEOUT_MS = 30_000;

export class LinkSession {
  readonly serverId: string;
  /** A server not yet approved answers /v1/info and nothing else. */
  readonly infoOnly: boolean;
  private readonly h2: ClientHttp2Session;
  private readonly ping: NodeJS.Timeout;
  private missed = 0;
  private readonly closed: Promise<void>;
  private ended = false;

  constructor(h2: ClientHttp2Session, o: { serverId: string; infoOnly: boolean; onClose?: () => void; pingEveryMs?: number }) {
    this.h2 = h2;
    this.serverId = o.serverId;
    this.infoOnly = o.infoOnly;
    h2.on("error", () => {});
    this.closed = new Promise((resolve) => {
      h2.once("close", () => {
        this.ended = true;
        clearInterval(this.ping);
        o.onClose?.();
        resolve();
      });
    });
    this.ping = setInterval(() => {
      if (this.missed >= L.LINK_LIMITS.pingMisses) return void this.destroy();
      this.missed++;
      void this.answersPing(o.pingEveryMs ?? 5_000).then((ok) => {
        if (ok) this.missed = 0;
      });
    }, o.pingEveryMs ?? L.LINK_LIMITS.pingEveryMs);
    this.ping.unref();
  }

  get alive(): boolean {
    return !this.ended && !this.h2.destroyed && !this.h2.closed;
  }

  /** Whether the agent answers right now, within a limit. A duplicate link is judged by this. */
  answersPing(timeoutMs = 5_000): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.alive) return resolve(false);
      const t = setTimeout(() => resolve(false), timeoutMs);
      try {
        this.h2.ping((e) => {
          clearTimeout(t);
          resolve(!e);
        });
      } catch {
        clearTimeout(t);
        resolve(false);
      }
    });
  }

  /** Throws LinkDownError when there is no session. */
  stream(path: string, headers: OutgoingHttpHeaders = {}, method = "POST"): ClientHttp2Stream {
    if (!this.alive) throw new LinkDownError();
    if (this.infoOnly && path !== "/v1/info") throw new AgentRefusal("this server has not been approved");
    const st = writesAsBuffers(this.h2.request({ [h2c.HTTP2_HEADER_METHOD]: method, [h2c.HTTP2_HEADER_PATH]: path, ...headers }, { endStream: false }));
    // The far end's session is out of memory, and refuses every new stream from now on while still
    // answering pings. Only a new session clears that, so this one ends and the agent redials.
    st.once("close", () => {
      if (st.rstCode === h2c.NGHTTP2_ENHANCE_YOUR_CALM) this.destroy();
    });
    return st;
  }

  /** A 4xx is a refusal; anything else that fails is the link. */
  async call<T>(method: "GET" | "POST", path: string, body?: unknown, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const st = this.stream(path, { "content-type": "application/json" }, method);
    return new Promise<T>((resolve, reject) => {
      let status = 0;
      let size = 0;
      const chunks: Buffer[] = [];
      const fail = (e: Error): void => {
        clearTimeout(timer);
        st.destroy();
        reject(e);
      };
      const timer = setTimeout(() => fail(new Error(`the agent did not answer ${path} in time`)), opts.timeoutMs ?? CALL_TIMEOUT_MS);
      opts.signal?.addEventListener("abort", () => fail(new Error(`${path} was cancelled`)), { once: true });
      st.once("response", (h) => {
        status = Number(h[h2c.HTTP2_HEADER_STATUS]);
      });
      st.on("data", (c: Buffer) => {
        size += c.length;
        if (size > JSON_MAX) return fail(new Error(`the agent's answer to ${path} is too large`));
        chunks.push(c);
      });
      st.on("error", () => fail(new LinkDownError(`the link dropped during ${path}`)));
      st.once("end", () => {
        clearTimeout(timer);
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          if (!status) return reject(new LinkDownError(`the link dropped during ${path}`));
          return reject(new Error(`the agent's answer to ${path} is not JSON`));
        }
        if (status >= 400 && status < 500) return reject(new AgentRefusal(String((parsed as { error?: unknown }).error ?? `refused ${path}`).slice(0, 2_000)));
        if (status !== 200) return reject(new Error(String((parsed as { error?: unknown }).error ?? `the agent answered ${status} to ${path}`).slice(0, 2_000)));
        resolve(parsed as T);
      });
      st.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  destroy(): void {
    this.h2.destroy();
  }

  wait(): Promise<void> {
    return this.closed;
  }
}

/**
 * The current session for one server, whichever connection it is on now. A runtime holds this, never
 * a session, so a reconnect needs nothing above it to change.
 */
export class ServerLink {
  readonly serverId: string;
  private session: LinkSession | null = null;
  private waiters: Array<() => void> = [];
  constructor(serverId: string) {
    this.serverId = serverId;
  }

  get current(): LinkSession {
    if (!this.session?.alive) throw new LinkDownError();
    return this.session;
  }

  get up(): boolean {
    return !!this.session?.alive;
  }

  peek(): LinkSession | null {
    return this.session;
  }

  attach(session: LinkSession): void {
    this.session = session;
    for (const w of this.waiters.splice(0)) w();
  }

  detach(session: LinkSession): void {
    if (this.session === session) this.session = null;
  }

  whenUp(signal?: AbortSignal): Promise<void> {
    if (this.up) return Promise.resolve();
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new LinkDownError("stopped while waiting for the link"));
      const done = (): void => resolve();
      this.waiters.push(done);
      signal?.addEventListener("abort", () => {
        this.waiters = this.waiters.filter((w) => w !== done);
        reject(new LinkDownError("stopped while waiting for the link"));
      }, { once: true });
    });
  }
}
