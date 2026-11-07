import { createHash } from "node:crypto";
import { z } from "zod";
import { createHttpClient, OutboundError, type HttpClient } from "@dockify/net-guard";
import { parsePublicKey, SignatureError, verifyMinisign } from "./minisign.ts";

/*
 * The signed release feed. One static file per channel, published to the GitHub Release and to the
 * `releases` branch (raw hosting), and optionally mirrored on dockify.sh:
 *
 *   <feed>/releases/stable.json          the manifest, every stable release, newest first
 *   <feed>/releases/stable.json.minisig  its minisign (Ed25519) signature
 *   <feed>/releases/beta.json(.minisig)  the same for the beta channel
 *
 * Nothing is dynamic: a mirror or a CDN can serve the bytes, and the signature makes every one of
 * them untrusted. scripts/release/make-manifest.mjs writes this exact shape.
 */

export const DIGEST_REF = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::\d{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/;
const SemVer = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/;
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Ref = z.string().max(300).regex(DIGEST_REF);

export const CHANNELS = ["stable", "beta"] as const;
export type Channel = (typeof CHANNELS)[number];
export const ARCHES = ["amd64", "arm64"] as const;
export type Arch = (typeof ARCHES)[number];

const PerArch = z.strictObject({ amd64: Ref, arm64: Ref });

export const SECURITY_LEVELS = ["critical", "important"] as const;
export type SecurityLevel = (typeof SECURITY_LEVELS)[number];
export const CVE_ID = /^CVE-\d{4}-\d{4,7}$/;
/** The longest "Remind me in" each level allows, in days (security.ts). */
export const MAX_SNOOZE_DAYS: Record<SecurityLevel, number> = { critical: 3, important: 7 };

/**
 * A security release's block: what the dashboard's red popup, banner and email say. It is part of
 * the signed bytes like every other field, so nobody can raise an alert or remove one without the
 * release key. make-manifest checks it strictly at release time; here a block that does not parse
 * (a level this version does not know, say) is dropped and the release itself kept, so an alert
 * this install cannot read never hides the update that fixes it.
 */
export const SecurityBlock = z.object({
  level: z.enum(SECURITY_LEVELS),
  /** Plain text: what the fix closes and who is exposed. Shown escaped, never as markup. */
  summary: z.string().trim().min(1).max(600).regex(/^[^\u0000-\u0008\u000b-\u001f\u007f]*$/),
  /** The advisory, https only. */
  advisory: z.url({ protocol: /^https$/ }).max(500).optional(),
  cves: z.array(z.string().regex(CVE_ID)).max(20).optional(),
});
export type SecurityBlock = z.infer<typeof SecurityBlock>;

/** One release in the feed. Images are referenced by digest only, per architecture. */
export const FeedRelease = z.strictObject({
  version: z.string().regex(SemVer),
  /** The release day, YYYY-MM-DD, as the notes heading shows it. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  publishedAt: z.iso.datetime({ offset: true }),
  /** The oldest version that may upgrade straight to this one. Older installs step through it first. */
  minFrom: z.string().regex(SemVer),
  /** The newest database migration this release ships (its folder name under prisma/migrations). */
  migration: z.string().regex(/^[0-9a-z_]{1,100}$/),
  /** A security release: installs in the next window even under "security only". */
  critical: z.boolean(),
  notesUrl: z.url({ protocol: /^https$/ }).max(500),
  /** The release notes, markdown (the same file the site changelog renders). Rendered escaped. */
  notes: z.string().max(20_000),
  images: z.strictObject({ control: PerArch, web: PerArch }),
  /** sha256 of the docker-compose.yml and socket-proxy/haproxy.cfg published with this release. */
  composeSha256: Sha.optional(),
  socketProxySha256: Sha.optional(),
  /** Set on a security release (docs/RELEASING.md). An unreadable block counts as none. */
  security: SecurityBlock.optional().catch(undefined),
});
export type FeedRelease = z.infer<typeof FeedRelease>;

export const ReleaseFeed = z.strictObject({
  schema: z.literal(2),
  channel: z.enum(CHANNELS),
  /** When the file was written. A feed older than the last one accepted is a replay and refused. */
  generatedAt: z.iso.datetime({ offset: true }),
  releases: z.array(FeedRelease).min(1).max(100),
});
export type ReleaseFeed = z.infer<typeof ReleaseFeed>;

export interface VerifiedFeed extends ReleaseFeed {
  /** sha256 of the exact signed bytes. An approved update is pinned to it. */
  sha256: string;
}

/** Compares two versions: negative when a < b. A prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const pa = SemVer.exec(a);
  const pb = SemVer.exec(b);
  if (!pa || !pb) return a === b ? 0 : a < b ? -1 : 1;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d;
  }
  const ra = pa[4];
  const rb = pb[4];
  if (ra === rb) return 0;
  if (ra === undefined) return 1;
  if (rb === undefined) return -1;
  const xa = ra.split(".");
  const xb = rb.split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const s = xa[i];
    const t = xb[i];
    if (s === undefined) return -1;
    if (t === undefined) return 1;
    const ns = /^\d+$/.test(s);
    const nt = /^\d+$/.test(t);
    if (ns && nt && Number(s) !== Number(t)) return Number(s) - Number(t);
    if (ns !== nt) return ns ? -1 : 1;
    if (s !== t) return s < t ? -1 : 1;
  }
  return 0;
}

export const bare = (v: string) => v.replace(/^v/, "");

/**
 * Verifies the signature over the exact bytes with the pinned key FIRST, and only then parses
 * them: nothing unsigned reaches the JSON parser or the schema. The trusted comment (signed too)
 * must name the channel and the newest version, so a signature cannot be paired with another file.
 */
export function verifyFeed(bytes: Buffer, sigText: string, publicKey: string, channel: Channel): VerifiedFeed {
  const sig = verifyMinisign(bytes, sigText, parsePublicKey(publicKey));
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new SignatureError("signed manifest is not JSON");
  }
  const m = ReleaseFeed.safeParse(json);
  if (!m.success) throw new SignatureError("signed manifest does not match the release schema");
  const feed = m.data;
  if (feed.channel !== channel) throw new SignatureError(`signed manifest is for the ${feed.channel} channel, not ${channel}`);
  const sorted = [...feed.releases].sort((a, b) => compareVersions(b.version, a.version));
  if (sorted.some((r, i) => r.version !== feed.releases[i]!.version)) throw new SignatureError("releases are not listed newest first");
  if (new Set(sorted.map((r) => bare(r.version))).size !== sorted.length) throw new SignatureError("a version is listed twice");
  const newest = feed.releases[0]!.version;
  const has = (k: string, v: string) => new RegExp(`(^|\\s)${k}:${v.replace(/[.+]/g, "\\$&")}(\\s|$)`).test(sig.trustedComment);
  if (!has("version", newest)) throw new SignatureError("trusted comment does not name the newest version");
  if (!has("channel", feed.channel)) throw new SignatureError("trusted comment does not name the channel");
  return { ...feed, sha256: createHash("sha256").update(bytes).digest("hex") };
}

// ------------------------------------------------------------------ choosing a release

/** What the feed offers an install running `current`. */
export interface Offer {
  /** The newest release this install may move to now (above current, minFrom satisfied). */
  target: FeedRelease | null;
  /** A newer release that needs a stepping stone first, when one exists above `target`. */
  blocked: { version: string; minFrom: string } | null;
  /** Any release between current and target (inclusive) is a security release. */
  critical: boolean;
}

/** A security release: flagged critical, or carrying a security block (make-manifest sets both). */
export const isSecurityRelease = (r: Pick<FeedRelease, "critical" | "security">) => r.critical || !!r.security;

/**
 * Picks the upgrade target. Downgrades and same-version entries are never offered; a release whose
 * minFrom is above `current` is reported as blocked, and the newest release that does accept
 * `current` is offered instead, so an old install steps forward one supported hop at a time.
 */
export function chooseRelease(feed: Pick<ReleaseFeed, "releases">, current: string): Offer {
  const newer = feed.releases.filter((r) => compareVersions(r.version, current) > 0);
  const target = newer.find((r) => compareVersions(current, r.minFrom) >= 0) ?? null;
  const top = newer[0];
  const blocked = top && top !== target ? { version: top.version, minFrom: top.minFrom } : null;
  const critical = !!target && newer.some((r) => isSecurityRelease(r) && compareVersions(r.version, target.version) <= 0);
  return { target, blocked, critical };
}

/** What an install running some version still needs from the signed security blocks above it. */
export interface PendingSecurity {
  /** The newest pending release that carries a block, without a leading v. */
  version: string;
  /** The highest level of every pending block: an older critical fix keeps a newer important one critical. */
  level: SecurityLevel;
  /** That release's summary, on one line. */
  summary: string;
  advisory: string | null;
  /** Every pending CVE id, newest release first, each once. */
  cves: string[];
  publishedAt: string;
}

const LEVEL_RANK: Record<SecurityLevel, number> = { important: 1, critical: 2 };

/**
 * The security block the dashboard shows for an install running `current`: the newest release
 * above it that carries one. Several pending releases keep the alert as long as any one of them is
 * a security release, so a newer release without a block never hides an older pending fix. Blocked
 * releases (minFrom above `current`) count too: the install is exposed until it gets there.
 */
export function pendingSecurity(feed: Pick<ReleaseFeed, "releases">, current: string): PendingSecurity | null {
  const pending = feed.releases
    .filter((r): r is FeedRelease & { security: SecurityBlock } => !!r.security && compareVersions(r.version, current) > 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  const top = pending[0];
  if (!top) return null;
  const level = pending.reduce<SecurityLevel>((l, r) => (LEVEL_RANK[r.security.level] > LEVEL_RANK[l] ? r.security.level : l), top.security.level);
  return {
    version: bare(top.version),
    level,
    summary: top.security.summary.replace(/\s+/g, " ").trim(),
    advisory: top.security.advisory ?? null,
    cves: [...new Set(pending.flatMap((r) => r.security.cves ?? []))].slice(0, 20),
    publishedAt: top.publishedAt,
  };
}

/** The dashboard's view of a pending security block: the block and the longest reminder its level allows. */
export const securityInfo = (s: PendingSecurity | null) => (s ? { ...s, maxSnoozeDays: MAX_SNOOZE_DAYS[s.level] } : null);

/** Why a specific version cannot be installed over `current`, or null when it can. */
export function refuseTarget(rel: Pick<FeedRelease, "version" | "minFrom">, current: string): string | null {
  if (compareVersions(rel.version, current) <= 0) return `refusing a downgrade: ${rel.version} is not newer than ${current}`;
  if (compareVersions(current, rel.minFrom) < 0) return `${rel.version} upgrades only from ${rel.minFrom} or newer; this install runs ${current}`;
  return null;
}

/** The image pair this host runs. */
export interface Images {
  control: string;
  web: string;
}
export const archOf = (nodeArch: string = process.arch): Arch => {
  if (nodeArch === "x64") return "amd64";
  if (nodeArch === "arm64") return "arm64";
  throw new Error(`Dockify releases ship amd64 and arm64 images; this host is ${nodeArch}`);
};
export const imagesFor = (rel: Pick<FeedRelease, "images">, arch: Arch): Images => ({ control: rel.images.control[arch], web: rel.images.web[arch] });

// ------------------------------------------------------------------ fetching

const MAX_MANIFEST = 512 * 1024;
const MAX_SIG = 4096;

/** The manifest URL for a feed base and a channel. */
export function feedUrl(base: string, channel: Channel): string {
  const u = new URL(base);
  if (u.protocol !== "https:") throw new Error("the release feed must be https");
  return `${base.replace(/\/+$/, "")}/releases/${channel}.json`;
}

export type Fetcher = (url: string, maxBytes: number) => Promise<Buffer>;

/** https only, no redirects, public addresses only (net-guard checks inside the socket's lookup). */
export function guardedFetcher(http: HttpClient = createHttpClient()): Fetcher {
  return async (url, maxBytes) => {
    if (!url.startsWith("https://")) throw new OutboundError("the release feed must be https", "URL_REFUSED");
    const res = await http({ method: "GET", url, headers: { accept: "application/json, text/plain" }, timeoutMs: 15_000, maxBytes });
    if (res.status !== 200) throw new Error(`release feed answered ${res.status}`);
    return res.body;
  };
}

export async function fetchVerifiedFeed(base: string, channel: Channel, publicKey: string, get: Fetcher = guardedFetcher()): Promise<VerifiedFeed> {
  const url = feedUrl(base, channel);
  const [bytes, sig] = await Promise.all([get(url, MAX_MANIFEST), get(`${url}.minisig`, MAX_SIG)]);
  return verifyFeed(bytes, sig.toString("utf8"), publicKey, channel);
}

/**
 * The trusted key: the one baked into the control image at release time (DOCKIFY_PINNED_PUBKEY,
 * deploy/Dockerfile), else the one the installer wrote to .env. The image key wins, so a key
 * rotation travels inside a release that the previous key signed (docs/RELEASING.md).
 */
export function trustedKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const pinned = env.DOCKIFY_PINNED_PUBKEY?.trim();
  if (pinned) return pinned;
  return env.DOCKIFY_RELEASE_PUBKEY?.trim() || null;
}
