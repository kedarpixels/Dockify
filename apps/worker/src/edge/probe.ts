import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { DOMAIN_CHECK_PREFIX, domainCheckAnswer, domainCheckToken } from "@dockify/crypto";
import { guardedLookup } from "@dockify/net-guard";

/**
 * A domain behind a proxy resolves to the proxy, so the probe GETs /.well-known/dockify-check/<token>
 * on the name itself. Traefik sends that path to the api above every tenant route, so only this server
 * can answer. The https leg skips the certificate check; net-guard's lookup refuses private addresses.
 */
export type ProbeResult = {
  status: "passed" | "failed";
  detail: string;
  /**
   * The request got no answer that says where the name leads: a timeout, a reset, a 5xx from a proxy
   * in front. checkDomain gives a live domain one more check before it drops the route.
   */
  transient?: boolean;
};

export interface ProbeAnswer {
  status: number;
  location: string | null;
  body: string;
}

export type ProbeFetch = (url: URL, timeoutMs: number) => Promise<ProbeAnswer>;

const isLasting = (e: unknown) => {
  const code = typeof e === "object" && e && "code" in e ? String((e as { code: unknown }).code) : "";
  return code === "EBLOCKED" || code === "ENOTFOUND" || code === "ENODATA";
};

const reasonOf = (e: unknown) => {
  const code = typeof e === "object" && e && "code" in e ? String((e as { code: unknown }).code) : "";
  const message = e instanceof Error ? e.message : String(e);
  if (code === "ENOTFOUND" || code === "ENODATA" || (code === "EBLOCKED" && /did not resolve/.test(message))) return "it does not resolve";
  if (code === "EBLOCKED") return "it resolves to an address that is not public";
  if (code === "ECONNREFUSED") return "the connection was refused";
  return message.slice(0, 120);
};

/**
 * `timeout` on a request only measures idle time, so a slow-drip server could hold the maintenance
 * lane for hours. The deadline covers the whole exchange: lookup, connect, TLS, headers and body.
 */
export const nodeProbeFetch: ProbeFetch = (url, timeoutMs) =>
  new Promise((resolve, reject) => {
    const expired = () => Object.assign(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`), { code: "ETIMEDOUT" });
    const https = url.protocol === "https:";
    const req = (https ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        lookup: guardedLookup(),
        timeout: timeoutMs,
        headers: { "user-agent": "Dockify domain check", accept: "text/plain" },
        ...(https ? { servername: url.hostname, rejectUnauthorized: false } : {}),
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          if (size < 256) chunks.push(c.subarray(0, 256 - size));
          size += c.length;
          if (size >= 256) res.destroy();
        });
        const done = () => {
          clearTimeout(deadline);
          resolve({ status: res.statusCode ?? 0, location: typeof res.headers.location === "string" ? res.headers.location : null, body: Buffer.concat(chunks).toString("utf8") });
        };
        res.on("end", done);
        res.on("close", done);
        res.on("error", () => done());
      },
    );
    const deadline = setTimeout(() => req.destroy(expired()), timeoutMs);
    req.on("timeout", () => req.destroy(expired()));
    req.on("error", (e) => {
      clearTimeout(deadline);
      reject(e);
    });
    req.end();
  });

/**
 * Each request has `timeoutMs` (5 s), so two hops and the TLS read that follows fit inside the api's
 * wait on a recheck (modules/domains/handlers.ts, CHECK_WAIT_MS).
 */
export async function probeDomain(o: { host: string; domainId: string; secret: string; fetch?: ProbeFetch; timeoutMs?: number }): Promise<ProbeResult> {
  const fetch = o.fetch ?? nodeProbeFetch;
  const timeoutMs = o.timeoutMs ?? 5_000;
  const failed = (why: string, transient = false): ProbeResult => ({ status: "failed", detail: `Asking ${o.host} did not reach this server: ${why}.`, ...(transient ? { transient } : {}) });
  // Node connects to an address without calling the guarded lookup, so only names are ever asked.
  if (isIP(o.host.replace(/^\[|\]$/g, ""))) return failed("it is an address, not a name");
  const token = domainCheckToken(o.secret, o.domainId, o.host);
  const expected = domainCheckAnswer(o.secret, o.host, token);
  const path = `${DOMAIN_CHECK_PREFIX}${token}`;
  let url: URL;
  try {
    url = new URL(`http://${o.host}${path}`);
  } catch {
    return failed("it is not a valid name");
  }
  // Exactly the name, on the default port, at exactly the check path: nothing in it may move the request.
  const name = url.hostname;
  if (name !== o.host.toLowerCase() || url.port !== "" || url.pathname !== path || url.search || url.username) return failed("it is not a valid name");
  for (let hop = 0; hop < 2; hop++) {
    let r: ProbeAnswer;
    try {
      r = await fetch(url, timeoutMs);
    } catch (e) {
      return failed(reasonOf(e), !isLasting(e));
    }
    if (r.status >= 300 && r.status < 400) {
      let next: URL;
      try {
        next = new URL(r.location ?? "", url);
      } catch {
        return failed("it redirected to an address that does not parse");
      }
      // Only http to https on the same name and path: a hop anywhere else proves nothing about this name.
      const sameHere = next.protocol === "https:" && next.hostname === name && (next.port === "" || next.port === "443") && next.pathname === path;
      // https sent back to https: a proxy that talks plain http to this server, which redirects every
      // http request to https (Cloudflare's Flexible mode). Every visitor would loop the same way.
      if (url.protocol === "https:" && sameHere) return failed("it redirects in a loop. Behind Cloudflare, set SSL/TLS to Full");
      if (url.protocol !== "http:" || !sameHere) return failed(`it redirected to ${next.origin}${next.pathname === path ? "" : " under another path"}`);
      url = next;
      continue;
    }
    if (r.status === 200 && r.body.trim() === expected) {
      return { status: "passed", detail: `Asking ${o.host} reached this server${url.protocol === "https:" ? " over https" : ""}.` };
    }
    // Cloudflare's "invalid origin certificate": Full (strict) before this server holds one for the name.
    // A live domain keeps its route through it: dropping the route would also stop the renewal.
    if (r.status === 526) return failed("Cloudflare refused this server's certificate (526). Set SSL/TLS to Full until the certificate is active", true);
    return failed(r.status === 200 ? "the answer was not this server's" : `it answered ${r.status}`, r.status >= 500);
  }
  return failed("it redirected more than once");
}
