/**
 * The one SSRF rule: only globally routable unicast addresses, checked
 * inside the socket's own DNS resolution so the check and the connect share one answer (no
 * rebinding window), https only, redirects never followed, a hard timeout and a response size cap.
 *
 * Every outbound call from the api and the worker goes through here: GitHub, Vercel, Cloudflare,
 * registries, S3 endpoints, alert channels, and the at-rest checks on hosts a user hands us.
 * There is no second copy of the rule anywhere; net-guard.test.ts feeds it every IANA
 * special-purpose range.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { lookup as dnsLookupAsync } from "node:dns/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { StringDecoder } from "node:string_decoder";

// ------------------------------------------------------------------ address rule

/** Every IANA special-purpose IPv4 block, plus multicast and reserved space. */
export const V4_DENY: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.31.196.0", 24], ["192.52.193.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
/**
 * Inside 2000::/3 (the only global unicast block), the IPv6 special-purpose blocks that are not
 * ordinary unicast: 2001::/23 (Teredo, benchmarking, ORCHID, AMT, AS112, drone id), documentation,
 * 6to4, SRv6 and the direct delegation AS112 block. Everything outside 2000::/3 is refused anyway.
 */
export const V6_DENY: ReadonlyArray<readonly [string, number]> = [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20], ["5f00::", 16], ["2620:4f:8000::", 48],
];

const deny = new BlockList();
for (const [a, p] of V4_DENY) deny.addSubnet(a, p, "ipv4");
for (const [a, p] of V6_DENY) deny.addSubnet(a, p, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

/** The embedded IPv4 of ::ffff:a.b.c.d or ::ffff:hhhh:hhhh, else null. */
export function mappedV4(addr: string): string | null {
  const m = /^::ffff:(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(addr);
  if (!m) return null;
  if (m[1]) return m[1];
  const hi = parseInt(m[2] ?? "0", 16);
  const lo = parseInt(m[3] ?? "0", 16);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** True only for a globally routable unicast address. Anything unparseable is refused. */
export function isPublicAddress(address: string): boolean {
  const a = address.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const kind = isIP(a);
  if (kind === 4) return !deny.check(a, "ipv4") && a !== "255.255.255.255";
  if (kind === 6) {
    const v4 = mappedV4(a);
    if (v4) return isPublicAddress(v4);
    return globalV6.check(a, "ipv6") && !deny.check(a, "ipv6");
  }
  return false;
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".localdomain", ".intranet", ".corp", ".private", ".test", ".invalid"];

/**
 * The check at rest for a hostname a user hands us: an IP literal must be public, a name must have
 * at least two labels and not sit under an internal suffix. DNS is checked again at connect time.
 */
export function isPublicHostname(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!h || h.length > 253) return false;
  if (isIP(h)) return isPublicAddress(h);
  if (h === "localhost" || INTERNAL_SUFFIXES.some((s) => h.endsWith(s))) return false;
  const labels = h.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((l) => LABEL.test(l))) return false;
  // An all-digit last label is an IP in disguise (for example 2130706433 or 0x7f.1).
  return !/^(?:\d+|0x[0-9a-f]+)$/.test(labels[labels.length - 1] ?? "");
}

/** An https URL with no userinfo and a public host, or the reason it is refused. */
export function outboundUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "Not a valid URL";
  }
  if (u.protocol !== "https:") return "Use an https URL";
  if (u.username || u.password) return "Do not put credentials in the URL";
  if (!isPublicHostname(u.hostname)) return "The host must be a public address";
  return null;
}

// ------------------------------------------------------------------ guarded lookup

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
export type Resolver = (host: string, cb: (err: NodeJS.ErrnoException | null, addrs: LookupAddress[]) => void) => void;

const systemResolver: Resolver = (host, cb) => dnsLookup(host, { all: true }, cb);

/**
 * A dns.lookup replacement for the socket: one resolution, every address checked, so there is no
 * window between the check and the connect for DNS rebinding to use.
 */
export function guardedLookup(resolver: Resolver = systemResolver) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    resolver(hostname, (err, addresses) => {
      if (err) return callback(err, "", 0);
      const bad = addresses.find((a) => !isPublicAddress(a.address));
      if (bad || addresses.length === 0) {
        const e = new Error(bad ? `Refused to connect: ${hostname} resolves to a non-public address` : `${hostname} did not resolve`) as NodeJS.ErrnoException;
        e.code = "EBLOCKED";
        return callback(e, "", 0);
      }
      const family = options?.family === 4 || options?.family === 6 ? options.family : 0;
      const pool = family ? addresses.filter((a) => a.family === family) : addresses;
      if (options?.all) return callback(null, pool);
      const chosen = pool[0];
      if (!chosen) {
        const e = new Error(`${hostname} has no address of the requested family`) as NodeJS.ErrnoException;
        e.code = "ENODATA";
        return callback(e, "", 0);
      }
      callback(null, chosen.address, chosen.family);
    });
  };
}

export type AsyncResolver = (host: string) => Promise<Array<{ address: string }>>;
const systemAsyncResolver: AsyncResolver = (host) => dnsLookupAsync(host, { all: true, verbatim: true });

/**
 * The same rule for a client that cannot take a custom lookup (fetch, a database driver): resolves
 * the host right before the call and refuses when any answer is not public. A rebinding between
 * this check and the connect is possible here, which is why the http client above is preferred.
 */
export async function assertPublicHost(hostname: string, resolve: AsyncResolver = systemAsyncResolver): Promise<void> {
  await pinPublicHost(hostname, resolve);
}

/**
 * The same check for a client that can be told which address to dial (SMTP): one resolution, every
 * answer must be public, and the answer is the address to connect to, IPv4 first, so a later DNS
 * change cannot move the connection. The caller keeps the name for TLS. A name with no answer
 * throws with code UNRESOLVED, a refused one with URL_REFUSED or EBLOCKED.
 */
export async function pinPublicHost(hostname: string, resolve: AsyncResolver = systemAsyncResolver): Promise<string> {
  const host = hostname.trim().replace(/^\[|\]$/g, "");
  if (!isPublicHostname(host)) throw new OutboundError(`${hostname} is not a public host`, "URL_REFUSED");
  if (isIP(host)) return host;
  let addrs: Array<{ address: string }>;
  try {
    addrs = await resolve(host);
  } catch {
    throw new OutboundError(`${hostname} did not resolve`, "UNRESOLVED");
  }
  const first = addrs.find((a) => isIP(a.address) === 4) ?? addrs[0];
  if (!first) throw new OutboundError(`${hostname} did not resolve`, "UNRESOLVED");
  if (addrs.some((a) => !isPublicAddress(a.address))) throw new OutboundError(`${hostname} resolves to a non-public address`, "EBLOCKED");
  return first.address;
}

// ------------------------------------------------------------------ http client

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  url: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

export class OutboundError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "OutboundError";
    this.code = code;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The production client. Never follows a redirect: a 3xx comes back to the caller as is.
 * `timeoutMs` bounds the whole exchange, not only each idle gap, so a peer that drips a byte at a
 * time cannot hold a job for longer than that.
 */
export function createHttpClient(resolver?: Resolver, transport: typeof httpsRequest = httpsRequest): HttpClient {
  const lookup = guardedLookup(resolver);
  return (req) =>
    new Promise<HttpResponse>((resolveOnce, rejectOnce) => {
      const problem = outboundUrlProblem(req.url);
      if (problem) return rejectOnce(new OutboundError(problem, "URL_REFUSED"));
      const u = new URL(req.url);
      const maxBytes = req.maxBytes ?? DEFAULT_MAX_BYTES;
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      let deadline: NodeJS.Timeout | undefined;
      const resolve = (v: HttpResponse) => {
        clearTimeout(deadline);
        resolveOnce(v);
      };
      const reject = (e: unknown) => {
        clearTimeout(deadline);
        rejectOnce(e);
      };
      const r = transport(
        {
          method: req.method,
          hostname: u.hostname.replace(/^\[|\]$/g, ""),
          port: u.port || 443,
          path: `${u.pathname}${u.search}`,
          headers: { "User-Agent": "Dockify", ...req.headers },
          lookup: lookup as never,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > maxBytes) {
              r.destroy(new OutboundError("The response is too large", "TOO_LARGE"));
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
          res.on("error", reject);
        },
      );
      const late = () => r.destroy(new OutboundError(`${u.hostname} did not answer in time`, "TIMEOUT"));
      deadline = setTimeout(late, timeoutMs);
      r.on("timeout", late);
      r.on("error", (e: NodeJS.ErrnoException) =>
        reject(e instanceof OutboundError ? e : new OutboundError(e.code === "EBLOCKED" ? e.message : `${u.hostname} could not be reached`, e.code ?? "NETWORK")),
      );
      if (req.body !== undefined) r.write(req.body);
      r.end();
    });
}

// ------------------------------------------------------------------ streaming client

export interface StreamRequest {
  url: string;
  headers?: Record<string, string>;
  /** Ends the exchange at once: the connection is destroyed, so nothing stays open upstream. */
  signal?: AbortSignal;
  /** How long the peer may take to send its response headers. */
  timeoutMs?: number;
  /** The longest quiet gap in the body; past it the body ends. */
  idleMs?: number;
  /** The longest the whole exchange may last, headers included. */
  maxMs?: number;
  /** Body bytes the stream may carry before it is cut. */
  maxBytes?: number;
}

/** Why a streamed body ended: the peer finished it, or a limit, the caller's signal or close() cut it. */
export type StreamEnd = "done" | "idle" | "max_time" | "too_large" | "aborted" | "closed";

export interface StreamResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** The body as lines split on LF (a CR before it is dropped), each cut to maxLine characters. */
  lines(maxLine?: number): AsyncGenerator<string, void, undefined>;
  /** The start of the body as text, for an error answer. The stream is closed afterwards. */
  text(limit?: number): Promise<string>;
  /** Null while the body is still open. */
  readonly ended: StreamEnd | null;
  close(): void;
}

export type StreamClient = (req: StreamRequest) => Promise<StreamResponse>;

const STREAM_HEADERS_MS = 15_000;
const STREAM_IDLE_MS = 120_000;
const STREAM_MAX_MS = 60 * 60_000;
const STREAM_MAX_BYTES = 64 * 1024 * 1024;
const STREAM_MAX_LINE = 64 * 1024;

/**
 * The same rule for a body that is read as it arrives (a log that follows a build): https only,
 * the guarded lookup, redirects never followed, GET only. Memory stays bounded because the body is
 * handed out one chunk at a time and cut at maxBytes, and one over-long line is cut rather than
 * buffered. Time is bounded by the idle gap and the whole-exchange cap. The caller's signal, close(),
 * or a consumer that stops reading early destroys the connection, so a viewer who leaves never
 * leaves a stream open upstream.
 */
export function createStreamClient(resolver?: Resolver, transport: typeof httpsRequest = httpsRequest): StreamClient {
  const lookup = guardedLookup(resolver);
  return (req) =>
    new Promise<StreamResponse>((resolve, reject) => {
      const problem = outboundUrlProblem(req.url);
      if (problem) return reject(new OutboundError(problem, "URL_REFUSED"));
      if (req.signal?.aborted) return reject(new OutboundError("The request was cancelled", "ABORTED"));
      const u = new URL(req.url);
      const started = Date.now();
      let answered = false;
      const onAbortEarly = (): void => {
        r.destroy(new OutboundError("The request was cancelled", "ABORTED"));
      };
      const r = transport(
        {
          method: "GET",
          hostname: u.hostname.replace(/^\[|\]$/g, ""),
          port: u.port || 443,
          path: `${u.pathname}${u.search}`,
          headers: { "User-Agent": "Dockify", ...req.headers },
          lookup: lookup as never,
        },
        (res) => {
          answered = true;
          clearTimeout(headersDeadline);
          req.signal?.removeEventListener("abort", onAbortEarly);
          resolve(streamResponse(res, r, req, started, u.hostname));
        },
      );
      const headersDeadline = setTimeout(() => r.destroy(new OutboundError(`${u.hostname} did not answer in time`, "TIMEOUT")), req.timeoutMs ?? STREAM_HEADERS_MS);
      req.signal?.addEventListener("abort", onAbortEarly, { once: true });
      r.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(headersDeadline);
        req.signal?.removeEventListener("abort", onAbortEarly);
        // Once the headers are in, the body side reports its own end; a late request error is that end.
        if (answered) return;
        reject(e instanceof OutboundError ? e : new OutboundError(e.code === "EBLOCKED" ? e.message : `${u.hostname} could not be reached`, e.code ?? "NETWORK"));
      });
      r.end();
    });
}

function streamResponse(res: IncomingMessage, r: ClientRequest, req: StreamRequest, started: number, host: string): StreamResponse {
  const idleMs = req.idleMs ?? STREAM_IDLE_MS;
  const maxBytes = req.maxBytes ?? STREAM_MAX_BYTES;
  let ended: StreamEnd | null = null;
  let consumed = false;
  const cut = (why: StreamEnd): void => {
    if (!ended) ended = why;
    clearTimeout(total);
    clearTimeout(idle);
    req.signal?.removeEventListener("abort", onAbort);
    res.destroy();
    r.destroy();
  };
  const total = setTimeout(() => cut("max_time"), Math.max(0, (req.maxMs ?? STREAM_MAX_MS) - (Date.now() - started)));
  let idle = setTimeout(() => cut("idle"), idleMs);
  const onAbort = (): void => cut("aborted");
  // An error on a body nobody reads yet must not crash the process; a reader sees it through the iterator.
  res.on("error", () => undefined);
  if (req.signal?.aborted) cut("aborted");
  else req.signal?.addEventListener("abort", onAbort, { once: true });

  async function* chunks(): AsyncGenerator<Buffer, void, undefined> {
    if (consumed) throw new OutboundError("The stream body was already read", "CONSUMED");
    consumed = true;
    let bytes = 0;
    try {
      for await (const c of res as AsyncIterable<Buffer>) {
        clearTimeout(idle);
        idle = setTimeout(() => cut("idle"), idleMs);
        bytes += c.length;
        if (bytes > maxBytes) {
          cut("too_large");
          return;
        }
        yield c;
      }
      if (!ended) ended = "done";
    } catch {
      // A cut destroys the socket, which ends the iterator with an error: that is the cut, not a fault.
      if (!ended) {
        cut("closed");
        throw new OutboundError(`${host} stopped sending`, "NETWORK");
      }
    } finally {
      cut(ended ?? "closed");
    }
  }

  return {
    status: res.statusCode ?? 0,
    headers: res.headers,
    get ended() {
      return ended;
    },
    async *lines(maxLine = STREAM_MAX_LINE) {
      const decoder = new StringDecoder("utf8");
      let partial = "";
      // Set while dropping the rest of a line that was already handed out cut to maxLine.
      let skipping = false;
      for await (const c of chunks()) {
        let text = decoder.write(c);
        for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n")) {
          const piece = text.slice(0, i);
          text = text.slice(i + 1);
          if (skipping) {
            skipping = false;
            partial = "";
            continue;
          }
          const line = (partial + piece).replace(/\r$/, "");
          partial = "";
          yield line.length > maxLine ? line.slice(0, maxLine) : line;
        }
        if (skipping) continue;
        partial += text;
        if (partial.length > maxLine) {
          yield partial.slice(0, maxLine);
          partial = "";
          skipping = true;
        }
      }
      const rest = partial + decoder.end();
      if (!skipping && rest) yield rest.replace(/\r$/, "").slice(0, maxLine);
    },
    async text(limit = 64 * 1024) {
      const decoder = new StringDecoder("utf8");
      let out = "";
      for await (const c of chunks()) {
        out += decoder.write(c);
        if (out.length >= limit) break;
      }
      return out.slice(0, limit);
    },
    close() {
      cut("closed");
    },
  };
}

// ------------------------------------------------------------------ following redirects

export interface FollowOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  /** At most this many redirects are followed (default 3). */
  maxRedirects?: number;
  /** Which redirect targets the caller accepts (default any). The client's own rule applies to each as well. */
  allow?: (url: URL) => boolean;
  /** The message a refused redirect throws with. */
  refused?: string;
}

/**
 * GETs a URL through a guarded client and follows a few redirects, the one place that does: the
 * client itself never follows one. Each target is resolved against the URL that answered, must be
 * https with no credentials and pass `allow`, and is then requested through the same client, so the
 * address rule and the DNS check hold at every hop. Returns where it ended and what it got there.
 */
export async function getFollowing(http: HttpClient, url: string, o: FollowOptions = {}): Promise<{ url: string; res: HttpResponse }> {
  const max = o.maxRedirects ?? 3;
  let at = url;
  for (let hop = 0; ; hop++) {
    const res = await http({ method: "GET", url: at, ...(o.headers ? { headers: o.headers } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}), ...(o.maxBytes ? { maxBytes: o.maxBytes } : {}) });
    if (res.status < 300 || res.status >= 400) return { url: at, res };
    const raw = res.headers.location;
    const location = Array.isArray(raw) ? raw[0] : raw;
    let next: URL | null = null;
    try {
      next = location ? new URL(location, at) : null;
    } catch {
      next = null;
    }
    if (!next || next.protocol !== "https:" || next.username || next.password || !(o.allow ?? (() => true))(next)) {
      throw new OutboundError(o.refused ?? "A redirect went somewhere Dockify does not follow", "REDIRECT_REFUSED");
    }
    if (hop >= max) throw new OutboundError("Too many redirects", "REDIRECT_REFUSED");
    at = next.toString();
  }
}

/** Parses a JSON body, or null. */
export function jsonOf<T>(res: HttpResponse): T | null {
  try {
    return JSON.parse(res.body.toString("utf8")) as T;
  } catch {
    return null;
  }
}

export interface PostResult {
  status: number;
  /** Retry-After in ms when the peer sent one. */
  retryAfterMs: number | null;
}

/** POSTs JSON through the guarded client (alert channels). A 3xx is returned, never followed. */
export async function guardedPostJson(url: string, body: unknown, timeoutMs = 5_000, http: HttpClient = createHttpClient()): Promise<PostResult> {
  const res = await http({
    method: "POST",
    url,
    headers: { "content-type": "application/json", "user-agent": "Dockify-Alerts/1" },
    body: Buffer.from(JSON.stringify(body)),
    timeoutMs,
    maxBytes: 64 * 1024,
  });
  const ra = res.headers["retry-after"];
  const secs = typeof ra === "string" ? Number(ra) : NaN;
  return { status: res.status, retryAfterMs: Number.isFinite(secs) ? secs * 1000 : null };
}
