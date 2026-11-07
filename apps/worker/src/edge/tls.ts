import { BlockList, isIP } from "node:net";
import type { Duplex } from "node:stream";
import { checkServerIdentity, connect, type ConnectionOptions, type PeerCertificate } from "node:tls";
import type { Dialer } from "../server/runtime.ts";

/**
 * The TLS state of a domain, observed rather than assumed: a handshake with the hostname as SNI
 * against an address its DNS returned, reading the certificate the client would get. In tunnel
 * mode that is Cloudflare's edge certificate, in direct mode Traefik's Let's Encrypt one.
 *
 * Only the ClientHello is sent, and only to a public address (or the server's own), so a hostname
 * pointed at an internal address cannot turn the probe into a scanner.
 */
export type TlsStatus = "active" | "pending" | "failed";

export interface TlsResult {
  status: TlsStatus;
  issuer: string | null;
  expiresAt: Date | null;
  detail: string | null;
}

export interface PeerInfo {
  cert: PeerCertificate | null;
  authorized: boolean;
  authorizationError: string | null;
}

export type TlsProbe = (address: string, servername: string, timeoutMs: number) => Promise<PeerInfo>;

const INTERNAL_V4 = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
  "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/3",
];
const internal = new BlockList();
for (const cidr of INTERNAL_V4) {
  const [net = "", bits = "32"] = cidr.split("/");
  internal.addSubnet(net, Number(bits), "ipv4");
}
export const isPublicV4 = (ip: string): boolean => isIP(ip) === 4 && !internal.check(ip, "ipv4");

/**
 * Whether Traefik serves this host a certificate a browser accepts, asked of the proxy itself, so the
 * answer does not wait on DNS caches. Node marks the peer authorized only when the chain is trusted and
 * the name matches, which the proxy's default certificate never is.
 */
export const proxyCertificateReady = (dial: Dialer) => async (hostname: string): Promise<boolean> => {
  const started = Date.now();
  const socket = await dial({ proxy: 443 }, { timeoutMs: PROXY_TLS_TIMEOUT_MS });
  return (await handshake({ socket, servername: hostname }, PROXY_TLS_TIMEOUT_MS - (Date.now() - started))).authorized;
};

const PROXY_TLS_TIMEOUT_MS = 5_000;

export const nodeTlsProbe: TlsProbe = (address, servername, timeoutMs) => handshake({ host: address, port: 443, servername }, timeoutMs);

/** Only the ClientHello and what answers it: the peer is read, and judged by the caller. */
const handshake = (to: ConnectionOptions & ({ socket: Duplex } | { host: string; port: number }), timeoutMs: number): Promise<PeerInfo> =>
  new Promise((resolve, reject) => {
    const socket = connect({ ...to, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] });
    const timer = setTimeout(() => socket.destroy(Object.assign(new Error("TLS handshake timed out"), { code: "ETIMEDOUT" })), timeoutMs);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const cert = socket.getPeerCertificate();
      const info: PeerInfo = {
        cert: cert && Object.keys(cert).length ? cert : null,
        authorized: socket.authorized,
        authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
      };
      socket.end();
      resolve(info);
    });
    socket.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });

const issuerOf = (cert: PeerCertificate): string | null => {
  const i = cert.issuer as unknown as Record<string, string | string[] | undefined> | undefined;
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;
  return pick(i?.O) ?? pick(i?.CN) ?? null;
};

export async function checkTls(
  probe: TlsProbe,
  host: string,
  addresses: string[],
  serverIpv4: string | null,
  now = new Date(),
  timeoutMs = 5000,
): Promise<TlsResult> {
  const target = addresses.find((ip) => ip === serverIpv4 || isPublicV4(ip));
  if (!target) return { status: "pending", issuer: null, expiresAt: null, detail: "Waiting for DNS to point at a public address." };

  let peer: PeerInfo;
  try {
    peer = await probe(target, host, timeoutMs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "pending", issuer: null, expiresAt: null, detail: `No TLS answer yet (${msg.slice(0, 120)}).` };
  }
  if (!peer.cert) return { status: "failed", issuer: null, expiresAt: null, detail: "The server sent no certificate." };

  const issuer = issuerOf(peer.cert);
  const expiresAt = peer.cert.valid_to ? new Date(peer.cert.valid_to) : null;
  const validExpiry = expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null;
  if (validExpiry && validExpiry <= now) return { status: "failed", issuer, expiresAt: validExpiry, detail: "The certificate has expired." };
  if (checkServerIdentity(host, peer.cert)) {
    // Traefik serves its default self-signed certificate while ACME is still working on it.
    const selfSigned = issuer === "TRAEFIK DEFAULT CERT" || /traefik/i.test(issuer ?? "");
    // Its name and date say nothing about the certificate this domain will get, so neither is shown.
    return selfSigned
      ? { status: "pending", issuer: null, expiresAt: null, detail: "The certificate is still being issued." }
      : { status: "failed", issuer, expiresAt: validExpiry, detail: `The certificate does not cover ${host}.` };
  }
  if (!peer.authorized) return { status: "failed", issuer, expiresAt: validExpiry, detail: `The certificate is not trusted (${peer.authorizationError ?? "unknown"}).` };
  return { status: "active", issuer, expiresAt: validExpiry, detail: null };
}
