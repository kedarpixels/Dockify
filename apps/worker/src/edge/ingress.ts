import { isIP } from "node:net";
import { isValidHost, normalizeHost } from "./hostnames.ts";

/**
 * cloudflare_tunnel: no public ports; TLS ends at Cloudflare, whose edge sets CF-Connecting-IP.
 * direct_tls: every client header is untrusted, so Traefik is the hop that decides the client address.
 */
export type IngressMode = "cloudflare_tunnel" | "direct_tls";
export type EdgeMode = { ingress: "cloudflare_tunnel" } | { ingress: "direct_tls"; certResolver: string };

export const CERT_RESOLVER = "le";
export const CLIENT_IP_MIDDLEWARE = "dockify-client-ip";
export const TUNNEL_SERVICE = "http://proxy:80";

/**
 * Fixed addresses on the compose edge network, pinned by deploy/docker-compose.yml. Dashboard routes
 * name the web and the api by address, never by service name: Traefik joins tenant networks, where a
 * tenant app or service called "web" or "api" can answer to that name.
 */
export const EDGE_ADDRESSES = { api: "172.30.1.10", web: "172.30.1.20", proxyDirect: "172.30.1.30", cloudflared: "172.30.1.40" } as const;
export const WEB_UPSTREAM = `http://${EDGE_ADDRESSES.web}:3000`;
export const API_UPSTREAM = `http://${EDGE_ADDRESSES.api}:3001`;
/** The path prefix routed to the api on the dashboard host. The trailing slash keeps /api/v1x out. */
export const API_PATH_PREFIX = "/api/v1/";

export interface EdgeSettings {
  mode: EdgeMode;
  dashboardHost: string;
  serverIpv4: string | null;
  serverIpv6: string | null;
  acmeEmail: string | null;
  acmeCaServer: string | null;
}

export class EdgeConfigError extends Error {}

export function loadEdgeSettings(env: NodeJS.ProcessEnv = process.env): EdgeSettings {
  const ingress = env.DOCKIFY_INGRESS?.trim() || "cloudflare_tunnel";
  if (ingress !== "cloudflare_tunnel" && ingress !== "direct_tls") {
    throw new EdgeConfigError("DOCKIFY_INGRESS must be cloudflare_tunnel or direct_tls");
  }
  const rawUrl = env.DOCKIFY_PUBLIC_URL?.trim();
  if (!rawUrl) throw new EdgeConfigError("DOCKIFY_PUBLIC_URL is not set");
  let dashboardHost: string;
  try {
    dashboardHost = normalizeHost(new URL(rawUrl).hostname);
  } catch {
    throw new EdgeConfigError(`DOCKIFY_PUBLIC_URL is not a valid URL: ${rawUrl}`);
  }
  const ip = env.DOCKIFY_SERVER_IPV4?.trim() || null;
  if (ip && isIP(ip) !== 4) throw new EdgeConfigError("DOCKIFY_SERVER_IPV4 must be an IPv4 address");
  const ip6 = env.DOCKIFY_SERVER_IPV6?.trim() || null;
  if (ip6 && isIP(ip6) !== 6) throw new EdgeConfigError("DOCKIFY_SERVER_IPV6 must be an IPv6 address");
  const acmeEmail = env.DOCKIFY_ACME_EMAIL?.trim() || null;
  if (ingress === "direct_tls") {
    if (!isValidHost(dashboardHost)) throw new EdgeConfigError("direct_tls needs DOCKIFY_PUBLIC_URL to use a real hostname");
    if (!acmeEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(acmeEmail)) throw new EdgeConfigError("direct_tls needs DOCKIFY_ACME_EMAIL");
  }
  const caServer = env.DOCKIFY_ACME_CASERVER?.trim() || null;
  if (caServer && !caServer.startsWith("https://")) throw new EdgeConfigError("DOCKIFY_ACME_CASERVER must be https");
  return {
    mode: ingress === "direct_tls" ? { ingress, certResolver: CERT_RESOLVER } : { ingress },
    dashboardHost,
    serverIpv4: ip,
    serverIpv6: ip6,
    acmeEmail,
    acmeCaServer: caServer,
  };
}

export interface StaticOptions {
  mode: EdgeMode;
  acmeEmail?: string | null;
  acmeCaServer?: string | null;
  /** Peers allowed to send X-Forwarded-For in tunnel mode: the cloudflared container. */
  tunnelPeers?: string[];
  dynamicDir?: string;
  acmeStorage?: string;
}

/**
 * forwardedHeaders has no trustedIPs and insecure is false, so Traefik drops any X-Forwarded-* a client
 * sent and sets X-Forwarded-For and X-Real-Ip from the TCP peer.
 */
export function renderTraefikStatic(o: StaticOptions): string {
  const dynamicDir = o.dynamicDir ?? "/proxy-dynamic/conf";
  const common = {
    global: { checkNewVersion: false, sendAnonymousUsage: false },
    log: { level: "INFO", format: "json" },
    accessLog: { format: "json", fields: { headers: { defaultMode: "drop" } } },
    api: { dashboard: false, insecure: false },
    ping: { entryPoint: "traefik" },
    providers: { file: { directory: dynamicDir, watch: true } },
  };

  if (o.mode.ingress === "cloudflare_tunnel") {
    for (const p of o.tunnelPeers ?? []) {
      const [addr = "", bits] = p.split("/");
      if (!isIP(addr) || (bits !== undefined && !/^\d{1,3}$/.test(bits))) throw new EdgeConfigError(`Invalid tunnel peer: ${p}`);
    }
    const peers = o.tunnelPeers ?? [];
    return `${JSON.stringify({
      ...common,
      entryPoints: {
        web: { address: ":80", forwardedHeaders: peers.length ? { trustedIPs: peers } : { insecure: false } },
        traefik: { address: "127.0.0.1:8082" },
      },
    }, null, 2)}\n`;
  }

  if (!o.acmeEmail) throw new EdgeConfigError("direct_tls needs an ACME email");
  const acme: Record<string, unknown> = {
    email: o.acmeEmail,
    storage: o.acmeStorage ?? "/letsencrypt/acme.json",
    httpChallenge: { entryPoint: "web" },
  };
  if (o.acmeCaServer) acme.caServer = o.acmeCaServer;
  return `${JSON.stringify({
    ...common,
    entryPoints: {
      web: { address: ":80", forwardedHeaders: { insecure: false } },
      websecure: { address: ":443", forwardedHeaders: { insecure: false }, http: { tls: {} } },
      traefik: { address: "127.0.0.1:8082" },
    },
    certificatesResolvers: { [o.mode.certResolver]: { acme } },
  }, null, 2)}\n`;
}
