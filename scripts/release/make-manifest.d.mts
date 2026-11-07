// Types for make-manifest.mjs, so the api tests can import it under strict TypeScript.

export type Channel = "stable" | "beta";
export type Arch = "amd64" | "arm64";
export interface PerArch { amd64: string; arm64: string }
export interface Images { control: PerArch; web: PerArch }

export type SecurityLevel = "critical" | "important";
export interface SecurityBlock {
  level: SecurityLevel;
  /** One line of plain text, at most 600 characters. */
  summary: string;
  /** https only. */
  advisory?: string;
  /** CVE ids, at most 20, each once. */
  cves?: string[];
}

export interface FeedRelease {
  version: string;
  date: string;
  publishedAt: string;
  minFrom: string;
  migration: string;
  critical: boolean;
  notesUrl: string;
  notes: string;
  images: Images;
  composeSha256?: string;
  socketProxySha256?: string;
  security?: SecurityBlock;
}

export interface ReleaseFeed {
  schema: 2;
  channel: Channel;
  generatedAt: string;
  releases: FeedRelease[];
}

export declare const SEMVER: RegExp;
export declare const DIGEST_REF: RegExp;
export declare const CHANNELS: readonly Channel[];
export declare const ARCHES: readonly Arch[];
export declare const MAX_RELEASES: number;
export declare const MAX_NOTES: number;
export declare const SECURITY_LEVELS: readonly SecurityLevel[];
export declare const MAX_SUMMARY: number;
export declare const MAX_CVES: number;
export declare const USAGE: string;

export declare class ReleaseError extends Error {}

export declare function compareVersions(a: string, b: string): number;
export declare function bare(v: string): string;
export declare function isPrerelease(v: string): boolean;
export declare function isCalendarDate(s: string): boolean;
export declare function todayUtc(now?: Date): string;
export declare function checkImageRef(ref: string, where?: string): string;
export declare function checkHttpsUrl(url: string, where?: string): string;
export declare function validateSecurity(s: unknown, where?: string): SecurityBlock;
export declare function validateRelease(r: unknown, where?: string): FeedRelease;
export declare function validateFeed(feed: unknown, where?: string): ReleaseFeed;
export declare function makeRelease(input: {
  version: string;
  date: string;
  publishedAt: string;
  minFrom: string;
  migration: string;
  critical?: boolean;
  notesUrl: string;
  notes: string;
  images: Images;
  composeSha256?: string;
  socketProxySha256?: string;
  /** Makes the release critical too. */
  security?: SecurityBlock;
}): FeedRelease;
export declare function defaultMinFrom(previous: Pick<ReleaseFeed, "releases"> | null | undefined): string;
export declare function buildFeed(input: {
  channel: Channel;
  release: FeedRelease;
  previous?: ReleaseFeed | null;
  generatedAt: string;
  replace?: boolean;
}): ReleaseFeed;
export declare function trustedComment(feed: Pick<ReleaseFeed, "channel" | "generatedAt" | "releases">): string;
export declare function serializeFeed(feed: ReleaseFeed): string;
export declare function parseNotesHeading(text: string): { version: string; date: string | null; unreleased: boolean };
export declare function checkNotes(text: string, version: string, date: string): string;
export declare function latestMigration(repoRoot: string): string;
export declare function sha256File(path: string): string;
export declare function resolveImages(opts: Record<string, string | boolean | undefined>, readJson: (path: string) => unknown): Images;
export declare function parseArgs(argv: string[]): Record<string, string | boolean>;
export declare function run(
  argv: string[],
  ctx?: { now?: Date; cwd?: string; env?: Record<string, string | undefined> },
): { help: string; feed?: undefined; out?: undefined; comment?: undefined } | { help?: undefined; feed: ReleaseFeed; out: string; comment: string };
