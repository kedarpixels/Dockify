import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { updateNotices } from "./notices.ts";
import { release } from "./test-fixtures.ts";
import type { FeedRelease } from "./release.ts";

const NOW = Date.parse("2026-11-11T10:00:00Z");

/** Just the two rows the bell reads. */
function fakeDb(releases: FeedRelease[], o: { recorded?: string | null; skip?: string; last?: Record<string, unknown> } = {}) {
  const inst = {
    releaseVersion: o.recorded === undefined ? "1.0.3" : o.recorded,
    latestRelease: { schema: 2, channel: "stable", generatedAt: "2026-11-01T00:00:00Z", releases, sha256: "f".repeat(64) },
    updateChannel: "stable",
    updateSkipVersion: o.skip ?? null,
  };
  return { instance: { findUnique: async () => inst }, releaseUpdate: { findFirst: async () => o.last ?? null } } as unknown as Db;
}

const feed = [release("1.0.4", { publishedAt: "2026-11-09T12:00:00Z" }), release("1.0.3")];
const kinds = async (db: Db, image: string) => (await updateNotices(db, image, NOW)).map((n) => n.id);

describe("the bell's update notice", () => {
  it("offers a newer release, dated when it was published", async () => {
    const [n] = await updateNotices(fakeDb(feed), "1.0.3", NOW);
    expect(n).toMatchObject({ id: "update-available-1.0.4", kind: "updateAvailable", tone: "info", at: "2026-11-09T12:00:00Z" });
    expect(n!.detail).toContain("You run v1.0.3");
  });

  it("is gone once the recorded version is that release or newer", async () => {
    expect(await kinds(fakeDb(feed, { recorded: "1.0.4" }), "1.0.4")).toEqual([]);
    expect(await kinds(fakeDb(feed, { recorded: "1.1.0" }), "1.0.3")).toEqual([]);
  });

  it("is gone once the running image is that release or newer, whatever was recorded", async () => {
    // Images swapped without the updater: the row still names the old version.
    expect(await kinds(fakeDb(feed, { recorded: "1.0.3" }), "1.0.4")).toEqual([]);
    expect(await kinds(fakeDb(feed, { recorded: "1.0.3" }), "v1.0.5")).toEqual([]);
    expect(await kinds(fakeDb(feed, { recorded: null }), "1.0.4")).toEqual([]);
  });

  it("still trusts the record over an image that has no version of its own", async () => {
    expect(await kinds(fakeDb(feed, { recorded: "1.0.4" }), "0.0.0-dev")).toEqual([]);
    expect(await kinds(fakeDb(feed, { recorded: "1.0.3" }), "0.0.0-dev")).toEqual(["update-available-1.0.4"]);
  });

  it("drops a pending security release the same way", async () => {
    const sec = [release("1.0.4", { critical: true, security: { level: "critical", summary: "Sessions survive a password change." } }), release("1.0.3")];
    expect(await kinds(fakeDb(sec), "1.0.3")).toEqual(["security-release-1.0.4"]);
    expect(await kinds(fakeDb(sec), "1.0.4")).toEqual([]);
  });

  it("is not raised for a skipped version", async () => {
    expect(await kinds(fakeDb(feed, { skip: "1.0.4" }), "1.0.3")).toEqual([]);
  });

  it("dates a finished update by when it finished, and forgets it after a week", async () => {
    const last = (finishedAt: string) => ({ id: "u1", kind: "update", state: "done", version: "1.0.4", fromVersion: "1.0.3", error: null, finishedAt: new Date(finishedAt) });
    const [n] = await updateNotices(fakeDb(feed, { recorded: "1.0.4", last: last("2026-11-10T08:00:00Z") }), "1.0.4", NOW);
    expect(n).toMatchObject({ id: "update-u1", kind: "updated", title: "Updated to v1.0.4", at: "2026-11-10T08:00:00.000Z" });
    expect(await kinds(fakeDb(feed, { recorded: "1.0.4", last: last("2026-11-01T08:00:00Z") }), "1.0.4")).toEqual([]);
  });
});
