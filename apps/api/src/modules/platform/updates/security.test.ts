import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { activeReminder, MAX_SNOOZE_DAYS, remindAt, remindKey, securityAlert, snoozeSecurity } from "./security.ts";
import { buildStatus } from "./state.ts";
import { release } from "./test-fixtures.ts";
import type { FeedRelease, PendingSecurity } from "./release.ts";

const DAY = 86_400_000;
const NOW = new Date("2026-11-06T10:00:00Z");
const env = { version: "1.0.0", feedBase: "https://feed.test", publicKey: "k" };
const crit = { level: "critical" as const, summary: "Sessions survive a password change.", advisory: "https://example.com/advisories/1", cves: ["CVE-2026-3001"] };
const imp = { level: "important" as const, summary: "A log line can leak a header." };
const USER = "11111111-1111-4111-8111-111111111111";

const pending = (over: Partial<PendingSecurity> = {}): PendingSecurity => ({ version: "1.2.1", level: "critical", summary: "s", advisory: null, cves: [], publishedAt: NOW.toISOString(), ...over });

/** Just the rows these reads and writes touch. */
function fakeDb(releases: FeedRelease[], o: { current?: string; channel?: "stable" | "beta"; live?: { kind: "update" | "rollback"; version: string } } = {}) {
  const inst: Record<string, unknown> = {
    id: 1,
    releaseVersion: o.current ?? "1.2.0",
    latestRelease: { schema: 2, channel: "stable", generatedAt: "2026-10-01T00:00:00Z", releases, sha256: "f".repeat(64) },
    updateChannel: o.channel ?? "stable",
    updateCheckedAt: null, updateNextCheckAt: null, updateCheckError: null,
    updateMode: "all", updateWindow: null, updateTimeZone: "Etc/UTC", updateSkipVersion: null, updatePausedUntil: null,
  };
  const member: Record<string, unknown> = { id: USER, securityRemindKey: null, securityRemindAt: null };
  const db = {
    inst,
    member,
    instance: { findUnique: async () => inst },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === USER ? member : null),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        if (where.id !== USER) throw new Error("not found");
        return Object.assign(member, data);
      },
    },
    releaseUpdate: {
      findFirst: async () => (o.live ? { kind: o.live.kind, version: o.live.version } : null),
      findMany: async () => [],
    },
  };
  return db as unknown as Db & { inst: Record<string, unknown>; member: Record<string, unknown> };
}

describe("reminder rules", () => {
  it("offers 1, 3 or 7 days, capped at 3 for critical and 7 for important", () => {
    expect(MAX_SNOOZE_DAYS).toEqual({ critical: 3, important: 7 });
    expect(remindAt("important", 7, NOW).getTime() - NOW.getTime()).toBe(7 * DAY);
    expect(remindAt("critical", 7, NOW).getTime() - NOW.getTime()).toBe(3 * DAY);
    expect(remindAt("critical", 3, NOW).getTime() - NOW.getTime()).toBe(3 * DAY);
    expect(remindAt("critical", 1, NOW).getTime() - NOW.getTime()).toBe(DAY);
    expect(remindAt("important", 0, NOW).getTime() - NOW.getTime()).toBe(DAY);
    expect(remindAt("important", Number.NaN, NOW).getTime() - NOW.getTime()).toBe(DAY);
  });

  it("holds only for the alert it was taken for, until it passes", () => {
    const p = pending();
    const at = new Date(NOW.getTime() + 2 * DAY);
    expect(remindKey(p)).toBe("1.2.1:critical");
    expect(activeReminder(p, { securityRemindKey: "1.2.1:critical", securityRemindAt: at }, NOW)).toEqual(at);
    // A newer security release has another key.
    expect(activeReminder(pending({ version: "1.2.2" }), { securityRemindKey: "1.2.1:critical", securityRemindAt: at }, NOW)).toBeNull();
    // The same release raised from important to critical asks again.
    expect(activeReminder(p, { securityRemindKey: "1.2.1:important", securityRemindAt: at }, NOW)).toBeNull();
    // Passed, missing, or longer than the level allows.
    expect(activeReminder(p, { securityRemindKey: "1.2.1:critical", securityRemindAt: new Date(NOW.getTime() - 1) }, NOW)).toBeNull();
    expect(activeReminder(p, { securityRemindKey: null, securityRemindAt: null }, NOW)).toBeNull();
    expect(activeReminder(p, { securityRemindKey: "1.2.1:critical", securityRemindAt: new Date(NOW.getTime() + 6 * DAY) }, NOW)).toBeNull();
    expect(activeReminder(pending({ level: "important" }), { securityRemindKey: "1.2.1:important", securityRemindAt: new Date(NOW.getTime() + 6 * DAY) }, NOW)).not.toBeNull();
    expect(activeReminder(null, { securityRemindKey: "1.2.1:critical", securityRemindAt: at }, NOW)).toBeNull();
  });
});

describe("server.updates.security", () => {
  it("shows the pending security release, the target and no reminder yet", async () => {
    const db = fakeDb([release("1.3.0", { minFrom: "1.0.0" }), release("1.2.1", { critical: true, security: crit }), release("1.2.0")]);
    const a = await securityAlert(db, env, USER, NOW);
    expect(a).toEqual({
      release: { version: "1.2.1", level: "critical", summary: crit.summary, advisory: crit.advisory, cves: ["CVE-2026-3001"], publishedAt: "2026-10-01T00:00:00Z", maxSnoozeDays: 3 },
      current: "1.2.0",
      target: "1.3.0",
      snoozedUntil: null,
      updating: null,
    });
  });

  it("is empty when nothing pending carries a block, on another channel's feed, or past the fix", async () => {
    expect((await securityAlert(fakeDb([release("1.3.0")]), env, USER, NOW)).release).toBeNull();
    expect((await securityAlert(fakeDb([release("1.2.1", { security: crit })], { channel: "beta" }), env, USER, NOW)).release).toBeNull();
    expect((await securityAlert(fakeDb([release("1.2.1", { security: crit })], { current: "1.2.1" }), env, USER, NOW)).release).toBeNull();
  });

  it("says when an update is running", async () => {
    const a = await securityAlert(fakeDb([release("1.2.1", { security: crit })], { live: { kind: "update", version: "1.2.1" } }), env, USER, NOW);
    expect(a.updating).toEqual({ kind: "update", version: "1.2.1" });
  });

  it("is part of the update status, from the signed feed", async () => {
    const db = fakeDb([release("1.2.2"), release("1.2.1", { critical: true, security: imp })]);
    const s = await buildStatus(db, env, NOW);
    expect(s.security).toMatchObject({ version: "1.2.1", level: "important", maxSnoozeDays: 7 });
    expect(s.latest?.version).toBe("1.2.2");
    expect(s.latest?.critical).toBe(true);
    expect((await buildStatus(fakeDb([release("1.2.1")]), env, NOW)).security).toBeNull();
  });
});

describe("server.updates.security.snooze", () => {
  it("remembers the choice for this member, capped by the level", async () => {
    const db = fakeDb([release("1.2.1", { critical: true, security: crit })]);
    const { alert, stored } = await snoozeSecurity(db, env, USER, { version: "v1.2.1", days: 7 }, NOW);
    expect(stored?.getTime()).toBe(NOW.getTime() + 3 * DAY);
    expect(alert.snoozedUntil).toBe(new Date(NOW.getTime() + 3 * DAY).toISOString());
    expect(db.member).toMatchObject({ securityRemindKey: "1.2.1:critical", securityRemindAt: stored });
    // Read back: still put off a day later, due again after the three days.
    expect((await securityAlert(db, env, USER, new Date(NOW.getTime() + DAY))).snoozedUntil).toBe(alert.snoozedUntil);
    expect((await securityAlert(db, env, USER, new Date(NOW.getTime() + 3 * DAY + 1))).snoozedUntil).toBeNull();
  });

  it("allows 7 days for an important release and 1 day for the close key", async () => {
    const db = fakeDb([release("1.2.1", { critical: true, security: imp })]);
    expect((await snoozeSecurity(db, env, USER, { version: "1.2.1", days: 7 }, NOW)).stored?.getTime()).toBe(NOW.getTime() + 7 * DAY);
    expect((await snoozeSecurity(db, env, USER, { version: "1.2.1", days: 1 }, NOW)).stored?.getTime()).toBe(NOW.getTime() + DAY);
  });

  it("is reset by a newer security release", async () => {
    const db = fakeDb([release("1.2.1", { critical: true, security: imp })]);
    await snoozeSecurity(db, env, USER, { version: "1.2.1", days: 7 }, NOW);
    expect((await securityAlert(db, env, USER, NOW)).snoozedUntil).not.toBeNull();
    // The next feed adds 1.2.2 with its own block: the popup is due again at once.
    (db.inst.latestRelease as { releases: FeedRelease[] }).releases.unshift(release("1.2.2", { critical: true, security: crit }));
    const a = await securityAlert(db, env, USER, new Date(NOW.getTime() + DAY));
    expect(a.release).toMatchObject({ version: "1.2.2", level: "critical" });
    expect(a.snoozedUntil).toBeNull();
  });

  it("stores nothing for a release that is no longer the pending one, and answers the fresh alert", async () => {
    const db = fakeDb([release("1.2.2", { critical: true, security: crit }), release("1.2.1", { critical: true, security: imp })]);
    const r = await snoozeSecurity(db, env, USER, { version: "1.2.1", days: 3 }, NOW);
    expect(r.stored).toBeNull();
    expect(r.alert).toMatchObject({ release: { version: "1.2.2" }, snoozedUntil: null });
    expect(db.member.securityRemindKey).toBeNull();
    // Nothing pending at all: nothing to remember.
    expect((await snoozeSecurity(fakeDb([release("1.2.1")]), env, USER, { version: "1.2.1", days: 1 }, NOW)).stored).toBeNull();
  });
});
