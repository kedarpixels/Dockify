/** Test-only release feed fixtures, shared by the update tests. */
import type { FeedRelease } from "./release.ts";

export const D = (c: string) => `sha256:${c.repeat(64)}`;
export const R = "ghcr.io/dockify/dockify";
export const release = (version: string, over: Partial<FeedRelease> = {}): FeedRelease => ({
  version,
  date: "2026-10-01",
  publishedAt: "2026-10-01T00:00:00Z",
  minFrom: "0.0.0",
  migration: "0001_init",
  critical: false,
  notesUrl: `https://github.com/dockify/dockify/releases/tag/v${version}`,
  notes: `## ${version} (2026-10-01)\n\nFaster deploys.\n`,
  images: {
    control: { amd64: `${R}-control@${D("a")}`, arm64: `${R}-control@${D("b")}` },
    web: { amd64: `${R}-web@${D("c")}`, arm64: `${R}-web@${D("d")}` },
  },
  ...over,
});
export const feedBytes = (releases: FeedRelease[], over: Record<string, unknown> = {}) =>
  Buffer.from(JSON.stringify({ schema: 2, channel: "stable", generatedAt: "2026-10-01T00:00:00Z", releases, ...over }));
export const comment = (version: string, channel = "stable") => `channel:${channel} version:${version} generated:2026-10-01T00:00:00Z`;

