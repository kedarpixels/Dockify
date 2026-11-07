import { readSecret } from "@dockify/crypto";

export type IngressMode = "cloudflare_tunnel" | "direct_tls";

export interface ApiConfig {
  port: number;
  bind: string;
  /** The one browser-facing origin. Cookie Secure flag and the CSRF check both derive from it. */
  publicUrl: URL;
  ingress: IngressMode;
  /**
   * Peers allowed to tell us the client address: the web container (and Traefik in direct mode).
   * Anything else connecting is the client itself. CIDRs or single addresses.
   */
  trustedProxies: string[];
  logLevel: string;
  /** Optional one-time token the installer prints; when set, first-owner setup must present it. */
  setupToken: string | undefined;
  /** The server's public IPv4 for the "point your A record at" hint; null when not set. */
  serverIpv4: string | null;
  /** The server's public IPv6 for the AAAA record hint, when it has one (DOCKIFY_SERVER_IPV6). */
  serverIpv6?: string | null;
  /** Extra hostnames no tenant may claim, besides the dashboard host. */
  reservedHosts: string[];
  /** CNAME target for tunnel mode (`<tunnel id>.cfargotunnel.com`); null when unknown. */
  tunnelTarget: string | null;
  /** Bare tunnel id the installer created for this box; stored on the Cloudflare row so edge jobs can route. */
  cfTunnelId: string | null;
  /** Socket peers allowed on the internal routes (the worker's control-network address). Empty: any peer with the token. */
  internalPeers: string[];
  /** The host port the web container publishes on 127.0.0.1 (DOCKIFY_PORT), the SSH tunnel's address. 3000 when unset. */
  webPort?: number;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const rawUrl = env.DOCKIFY_PUBLIC_URL?.trim();
  if (!rawUrl) throw new ConfigError("DOCKIFY_PUBLIC_URL is not set (for example https://dockify.example.com)");
  let publicUrl: URL;
  try {
    publicUrl = new URL(rawUrl);
  } catch {
    throw new ConfigError(`DOCKIFY_PUBLIC_URL is not a valid URL: ${rawUrl}`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname);
  if (publicUrl.protocol !== "https:" && !(publicUrl.protocol === "http:" && loopback)) {
    throw new ConfigError("DOCKIFY_PUBLIC_URL must be https (plain http is allowed only on localhost)");
  }

  const ingressRaw = env.DOCKIFY_INGRESS?.trim() || "cloudflare_tunnel";
  if (ingressRaw !== "cloudflare_tunnel" && ingressRaw !== "direct_tls") {
    throw new ConfigError("DOCKIFY_INGRESS must be cloudflare_tunnel or direct_tls");
  }

  const port = Number(env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("PORT must be a port number");

  return {
    port,
    bind: env.BIND?.trim() || "0.0.0.0",
    publicUrl,
    ingress: ingressRaw,
    trustedProxies: (env.DOCKIFY_TRUSTED_PROXIES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    logLevel: env.LOG_LEVEL?.trim() || "info",
    setupToken: readSecret("DOCKIFY_SETUP_TOKEN", env),
    serverIpv4: env.DOCKIFY_SERVER_IPV4?.trim() || null,
    serverIpv6: env.DOCKIFY_SERVER_IPV6?.trim() || null,
    reservedHosts: (env.DOCKIFY_RESERVED_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    tunnelTarget: env.DOCKIFY_CF_TUNNEL_ID?.trim() ? `${env.DOCKIFY_CF_TUNNEL_ID.trim()}.cfargotunnel.com` : null,
    cfTunnelId: env.DOCKIFY_CF_TUNNEL_ID?.trim() || null,
    internalPeers: (env.DOCKIFY_INTERNAL_PEERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    webPort: Number(env.DOCKIFY_PORT) || 3000,
  };
}
