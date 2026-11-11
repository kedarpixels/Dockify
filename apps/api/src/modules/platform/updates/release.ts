import { createHash } from "node:crypto";
import { z } from "zod";
import { createHttpClient, OutboundError, type HttpClient } from "@dockify/net-guard";
import { parsePublicKey, SignatureError, verifyMinisign } from "./minisign.ts";

/*
 * The signed release feed: one static <feed>/releases/<channel>.json plus its .minisig, newest first.
 * Any mirror may serve the bytes; only the signature is trusted. make-manifest.mjs writes this shape.
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
/** The longest "Remind me in" each level allows, in days. */
export const MAX_SNOOZE_DAYS: Record<SecurityLevel, number> = { critical: 3, important: 7 };

/**
 * Signed like every other field. A block that does not parse here is dropped and its release kept,
 * so an unreadable alert never hides the update that fixes it.
 */
export const SecurityBlock = z.object({
  level: z.enum(SECURITY_LEVELS),
  /** Plain text, shown escaped, never as markup. */
  summary: z.string().trim().min(1).max(600).regex(/^[^\u0000-\u0008\u000b-\u001f\u007f]*$/),
  advisory: z.url({ protocol: /^https$/ }).max(500).optional(),
  cves: z.array(z.string().regex(CVE_ID)).max(20).optional(),
});
export type SecurityBlock = z.infer<typeof SecurityBlock>;

export const FeedRelease = z.strictObject({
  version: z.string().regex(SemVer),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  publishedAt: z.iso.datetime({ offset: true }),
  /** The oldest version that may upgrade straight to this one. Older installs step through it first. */
  minFrom: z.string().regex(SemVer),
  /** The newest migration this release ships: its folder name under prisma/migrations. */
  migration: z.string().regex(/^[0-9a-z_]{1,100}$/),
  /** A security release: installs in the next window even under "security only". */
  critical: z.boolean(),
  notesUrl: z.url({ protocol: /^https$/ }).max(500),
  /** Markdown, rendered escaped. */
  notes: z.string().max(20_000),
  images: z.strictObject({ control: PerArch, web: PerArch }),
  /** sha256 of the docker-compose.yml and socket-proxy/haproxy.cfg published with this release. */
  composeSha256: Sha.optional(),
  socketProxySha256: Sha.optional(),
  /** An unreadable block counts as none. */
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

/** Negative when a < b. A prerelease sorts before its release. */
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
 * Verifies the signature over the exact bytes before parsing, so nothing unsigned reaches the JSON
 * parser or the schema. The signed trusted comment must name the channel and the newest version, so
 * a signature cannot be paired with another file.
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

export interface Offer {
  /** The newest release this install may move to now (above current, minFrom satisfied). */
  target: FeedRelease | null;
  /** A newer release that needs a stepping stone first, when one exists above `target`. */
  blocked: { version: string; minFrom: string } | null;
  /** Any release between current and target (inclusive) is a security release. */
  critical: boolean;
}

export const isSecurityRelease = (r: Pick<FeedRelease, "critical" | "security">) => r.critical || !!r.security;

/**
 * Never offers a downgrade. A release whose minFrom is above `current` is reported as blocked and
 * the newest one that accepts `current` is offered, so an old install moves one supported hop at a time.
 */
export function chooseRelease(feed: Pick<ReleaseFeed, "releases">, current: string): Offer {
  const newer = feed.releases.filter((r) => compareVersions(r.version, current) > 0);
  const target = newer.find((r) => compareVersions(current, r.minFrom) >= 0) ?? null;
  const top = newer[0];
  const blocked = top && top !== target ? { version: top.version, minFrom: top.minFrom } : null;
  const critical = !!target && newer.some((r) => isSecurityRelease(r) && compareVersions(r.version, target.version) <= 0);
  return { target, blocked, critical };
}

export interface PendingSecurity {
  /** Without a leading v. */
  version: string;
  /** The highest level among pending blocks: an older critical fix keeps a newer important one critical. */
  level: SecurityLevel;
  summary: string;
  advisory: string | null;
  cves: string[];
  publishedAt: string;
}

const LEVEL_RANK: Record<SecurityLevel, number> = { important: 1, critical: 2 };

/**
 * A newer release without a block never hides an older pending fix. Releases blocked by minFrom
 * count too: the install is exposed until it gets there.
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

export const securityInfo = (s: PendingSecurity | null) => (s ? { ...s, maxSnoozeDays: MAX_SNOOZE_DAYS[s.level] } : null);

/** The reason for refusal, or null when `rel` can be installed over `current`. */
export function refuseTarget(rel: Pick<FeedRelease, "version" | "minFrom">, current: string): string | null {
  if (compareVersions(rel.version, current) <= 0) return `refusing a downgrade: ${rel.version} is not newer than ${current}`;
  if (compareVersions(current, rel.minFrom) < 0) return `${rel.version} upgrades only from ${rel.minFrom} or newer; this install runs ${current}`;
  return null;
}

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

const MAX_MANIFEST = 512 * 1024;
const MAX_SIG = 4096;

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
 * The key baked into the control image wins over the one the installer wrote to .env, so a key
 * rotation travels inside a release that the previous key signed.
 */
export function trustedKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const pinned = env.DOCKIFY_PINNED_PUBKEY?.trim();
  if (pinned) return pinned;
  return env.DOCKIFY_RELEASE_PUBKEY?.trim() || null;
}
