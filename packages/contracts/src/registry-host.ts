/**
 * Which registries Dockify pulls from, by what an image reference spells. The one copy of the rule:
 * the agent's gate asks it at every pull (apps/agent/src/docker-gate.ts), the api asks it when an image
 * is saved (apps/api/src/modules/projects/host-rule.ts), so a reference the dashboard takes is one the
 * pull takes.
 *
 * A pull makes dockerd, on the host's network, fetch `/v2/` from whatever registry the image names, and
 * Docker speaks plain HTTP to a loopback address. So a worker that can ask for a pull could otherwise
 * reach what only the host can: its loopback services, cloud metadata, the control networks. This refuses
 * those by what the reference says. Registries on a LAN stay allowed, on any port: people run them.
 *
 * Not covered, and this layer cannot cover it: a DNS name that resolves to one of these addresses, and a
 * public registry that redirects there. dockerd does its own lookup later, so an answer read here proves
 * nothing about the one it will get. Only a rule on the host's network could stop those. The api does
 * read a name's answer at save time, which catches the plain mistake and nothing more.
 *
 * deploy/socket-proxy/haproxy.cfg holds the same list as a second layer. apps/worker/src/socket-proxy.test.ts
 * keeps the two in step, and `docker pull` of Dockify's own images (the installer, the updater) does not
 * come through here, so a registry on the box's own loopback still serves those.
 *
 * Plain string work only: the browser bundle and the agent both load this package.
 */

/** Names that mean this host, or its metadata service, whatever DNS says. Compared in lower case. */
const REFUSED_NAMES = /^(?:(?:[a-z0-9_-]+\.)*localhost|localhost\.localdomain|ip6-localhost|ip6-loopback|(?:[a-z0-9_-]+\.)*docker\.internal|metadata|metadata\.goog|metadata\.google\.internal|instance-data(?:\.[a-z0-9_.-]+)?)$/;

/** A label of any spelling the C library reads as a number: 127, 0x7f, 0177. */
const NUMERIC_LABEL = /^(?:0x[0-9a-f]*|[0-9]+)$/;
const PLAIN_OCTET = /^(?:0|[1-9][0-9]{0,2})$/;

/** The compose file's fixed control networks, /24 each. A test holds this list to the compose file. */
export const CONTROL_SUBNETS: readonly string[] = ["172.30.1.0", "172.30.2.0", "172.30.3.0", "172.30.4.0", "172.30.5.0"];

/** Why this dotted quad may not be a registry, or null. */
function refusedQuad(a: number, b: number, c: number, d: number): string | null {
  if (a === 0) return "this host";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local and cloud metadata";
  if (a === 100 && b === 100 && c === 100 && d === 200) return "cloud metadata";
  if (a === 168 && b === 63 && c === 129 && d === 16) return "cloud metadata";
  if (CONTROL_SUBNETS.includes(`${a}.${b}.${c}.0`)) return "a control network";
  return null;
}

/** Why this host may not be a registry, or null. Takes the host alone, with no port. */
export function refusedHost(hostIn: string): string | null {
  const host = hostIn.toLowerCase().replace(/\.+$/, "");
  if (host === "") return "no host";
  // The gate's query form takes no bracket, so an IPv6 literal could never be pulled anyway.
  if (/[[\]:]/.test(host)) return "an IPv6 address";
  if (REFUSED_NAMES.test(host)) return "this host or its metadata service";
  const labels = host.split(".");
  if (!labels.every((l) => NUMERIC_LABEL.test(l))) return null;
  // An address, in some spelling. 127.1, 2130706433 and 0x7f.0.0.1 all reach loopback, and none is how
  // anyone names a real registry, so only the plain dotted form goes on to the ranges.
  if (labels.length !== 4 || !labels.every((l) => PLAIN_OCTET.test(l) && Number(l) <= 255)) return "an address not written as four plain numbers";
  const [a, b, c, d] = labels.map(Number) as [number, number, number, number];
  return refusedQuad(a, b, c, d);
}

/**
 * The registry a reference names, as Docker decides it: only a first component with a dot or a colon,
 * upper case, or the word localhost is a host. `127.0.0.1:8000` with no slash is an image on Docker Hub.
 */
export function registryHost(ref: string): string | null {
  const slash = ref.indexOf("/");
  if (slash === -1) return null;
  const first = ref.slice(0, slash);
  if (!/[.:]/.test(first) && first !== "localhost" && first === first.toLowerCase()) return null;
  return first.replace(/:[^:]*$/, "");
}

/** Null when dockerd may pull this reference, else the reason it may not. Takes it decoded. */
export function refusedPull(ref: string): string | null {
  const host = registryHost(ref);
  if (host === null) return null;
  // No such reference is valid, and nothing should guess what a parser would make of it.
  if (host.includes("@")) return `${host} is not a registry host`;
  const why = refusedHost(host);
  return why ? `Dockify does not pull from ${host}: ${why}` : null;
}
