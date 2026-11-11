import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { buildApp } from "../../app.ts";
import { testConfig, testRing } from "../../test-helpers.ts";
import { observeHandlers } from "./handlers.ts";
import {
  appPoints, bucketize, dayIn, dayStartIn, dayState, incidentUpdates, isZone, lastDays, levelsAtLeast, likePattern, parseLogCursor, rate, safeLogoUrl,
  TO_API_METRIC, TO_DB_METRIC, trendDays, trendStart, trendZone, validateRule, withBell, worst, type RuleInput,
} from "./logic.ts";
import { sseFrame, whereSql } from "./logs.ts";
import { overview } from "./overview.ts";
import { clearStatusCache, publicStatus } from "./status.ts";

describe("metric buckets", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 30, 10, 0, s));
  it("averages gauges and keeps the highest counter per bucket", () => {
    const b = bucketize([
      { at: at(0), cpuPct: 10, memoryBytes: 100n, pids: 3, restarts: 0, netRxBytes: 1000n, netTxBytes: 10n },
      { at: at(30), cpuPct: 30, memoryBytes: 300n, pids: 5, restarts: 1, netRxBytes: 1600n, netTxBytes: 20n },
      { at: at(70), cpuPct: 50, memoryBytes: 500n, pids: 1, restarts: 2, netRxBytes: 7600n, netTxBytes: 5n },
    ], 60_000);
    expect(b).toHaveLength(2);
    expect(b[0]).toMatchObject({ cpuPct: 20, memoryBytes: 200, pids: 5, restarts: 1, netRx: 1600, netTx: 20 });
    const { points, lastRestartAt } = appPoints(b);
    expect(points[1]).toMatchObject({ netInBps: 100, netOutBps: 0, restarts: 1 });
    expect(lastRestartAt).toBe(points[1]?.at);
  });
  it("never reports a negative rate", () => {
    expect(rate(100, 50, 10)).toBe(0);
    expect(rate(null, 50, 10)).toBe(0);
    expect(rate(0, 50, 10)).toBe(5);
  });
});

const rule = (over: Partial<RuleInput>): RuleInput => ({
  metric: "down", appId: null, service: null, threshold: null, durationMin: 5, channels: ["bell", "bell"], enabled: true, ...over,
});

describe("alert rule validation", () => {
  it("dedupes channels and webhooks", () => {
    expect(validateRule(rule({}))).toMatchObject({ channels: ["bell"], webhooks: undefined });
    expect(validateRule(rule({ channels: ["email", "bell", "email"] }))).toMatchObject({ channels: ["email", "bell"] });
    expect(validateRule(rule({ channels: [], webhooks: ["w1", "w1"] })).webhooks).toEqual(["w1"]);
  });
  it("keeps the bell only for a rule that sends nowhere else", () => {
    expect(withBell([], [])).toEqual(["bell"]);
    expect(withBell([], ["w1"])).toEqual([]);
    expect(withBell(["email"], [])).toEqual(["email"]);
  });
  it("refuses impossible combinations", () => {
    expect(() => validateRule(rule({ metric: "service" }))).toThrow(/service/);
    expect(() => validateRule(rule({ metric: "service", service: "api", appId: "00000000-0000-4000-8000-000000000000" }))).toThrow(/app/);
    expect(() => validateRule(rule({ metric: "down", service: "api" }))).toThrow(/service/);
    expect(() => validateRule(rule({ metric: "disk", appId: "00000000-0000-4000-8000-000000000000" }))).toThrow(/server/);
    expect(() => validateRule(rule({ metric: "memory", threshold: 150 }))).toThrow(/percentage/);
    expect(() => validateRule(rule({ metric: "crashLoop", threshold: 2.5 }))).toThrow(/whole number/);
    expect(() => validateRule(rule({ metric: "down", threshold: 3 }))).toThrow(/no threshold/);
  });
  it("maps metric spellings both ways", () => {
    for (const [api, db] of Object.entries(TO_DB_METRIC)) expect(TO_API_METRIC[db]).toBe(api);
  });
});

describe("status page pieces", () => {
  it("grades days", () => {
    expect(dayState(undefined)).toBe("none");
    expect(dayState({ downMinutes: 0, degradedMinutes: 0, sampledMinutes: 0 })).toBe("none");
    expect(dayState({ downMinutes: 0, degradedMinutes: 0, sampledMinutes: 1440 })).toBe("ok");
    expect(dayState({ downMinutes: 3, degradedMinutes: 0, sampledMinutes: 1440 })).toBe("minor");
    expect(dayState({ downMinutes: 45, degradedMinutes: 0, sampledMinutes: 1440 })).toBe("major");
    expect(worst(["operational", "outage", "degraded"])).toBe("outage");
    expect(lastDays(3, Date.UTC(2026, 9, 30, 5))).toEqual(["2026-10-28", "2026-10-29", "2026-10-30"]);
  });
  it("drops malformed incident updates and unsafe logos", () => {
    expect(incidentUpdates([{ at: "2026-10-30T10:00:00Z", status: "identified", body: "db", secret: "x" }, { at: "nope" }, "x"]))
      .toEqual([{ at: "2026-10-30T10:00:00.000Z", status: "identified", body: "db" }]);
    expect(incidentUpdates({})).toEqual([]);
    expect(safeLogoUrl("javascript:alert(1)")).toBeNull();
    expect(safeLogoUrl("http://x.test/a.png")).toBeNull();
    expect(safeLogoUrl("https://cdn.example.com/logo.png")).toBe("https://cdn.example.com/logo.png");
  });
});

describe("log filters", () => {
  it("parameterizes every user value", () => {
    const sql = whereSql({ appIds: ["a"], q: "50%_off", regex: false, stream: "stderr", level: "warn" });
    expect(sql.sql).not.toContain("50%");
    expect(sql.values).toEqual([["a"], "stderr", ["error", "warn"], "%50\\%\\_off%"]);
    const re = whereSql({ appIds: null, q: "time(out|d)", regex: true });
    expect(re.sql).toContain("~*");
    expect(re.values).toEqual(["time(out|d)"]);
    expect(whereSql({ appIds: null }).sql).toBe("");
  });
  it("validates cursors and levels", () => {
    expect(parseLogCursor("123")).toBe(123n);
    expect(parseLogCursor(undefined)).toBeNull();
    expect(() => parseLogCursor("1;drop")).toThrow(/cursor/);
    expect(levelsAtLeast("error")).toEqual(["error"]);
    expect(levelsAtLeast("debug")).toHaveLength(4);
    expect(likePattern("a\\b")).toBe("%a\\\\b%");
  });
  it("frames SSE events", () => {
    expect(sseFrame("line", { a: 1 }, "7")).toBe('id: 7\nevent: line\ndata: {"a":1}\n\n');
  });
});

describe("deploy trend days", () => {
  const at = (day: string) => Date.parse(`${day}T15:30:00Z`);
  it("reaches back 59 days in January, so the previous 30 day window is whole", () => {
    const d = trendDays(at("2026-01-10"));
    expect(d[0]).toBe("2025-11-12");
    expect(d.indexOf("2026-01-10")).toBe(59);
    expect(d.at(-1)).toBe("2026-12-31");
    expect(d).toHaveLength(50 + 365);
  });
  it("starts on Jan 1 once 59 days back is still in the same year", () => {
    expect(trendDays(at("2026-07-01"))[0]).toBe("2026-01-01");
    expect(trendDays(at("2026-07-01"))).toHaveLength(365);
    // Mar 1 is the 60th day of a common year and Feb 29 the 60th of a leap year: the first days
    // whose 59 day reach back lands exactly on Jan 1.
    expect(trendDays(at("2026-02-28"))[0]).toBe("2025-12-31");
    expect(trendDays(at("2026-03-01"))[0]).toBe("2026-01-01");
    expect(trendDays(at("2028-02-28"))[0]).toBe("2027-12-31");
    expect(trendDays(at("2028-02-29"))[0]).toBe("2028-01-01");
  });
  it("is one entry per day, contiguous, always ending Dec 31, with Feb 29 in a leap year", () => {
    for (const day of ["2026-01-01", "2026-01-10", "2026-02-28", "2026-07-01", "2026-12-31", "2028-01-10", "2028-03-15"]) {
      const d = trendDays(at(day));
      expect(d.at(-1), day).toBe(`${day.slice(0, 4)}-12-31`);
      expect(d, day).toContain(day);
      expect(d.indexOf(day), day).toBeGreaterThanOrEqual(59);
      for (let i = 1; i < d.length; i++) expect(Date.parse(d[i]!) - Date.parse(d[i - 1]!), `${day} at ${d[i]}`).toBe(86_400_000);
    }
    expect(trendDays(at("2028-03-15"))).toContain("2028-02-29");
    expect(trendDays(at("2028-03-15"))).toHaveLength(366);
    expect(trendDays(at("2028-01-10"))).toHaveLength(50 + 366);
    expect(trendDays(at("2026-07-01"))).not.toContain("2026-02-29");
  });
  it("does not move with the time of day", () => {
    expect(trendDays(Date.parse("2026-01-10T00:00:00Z"))).toEqual(trendDays(Date.parse("2026-01-10T23:59:59.999Z")));
    expect(trendStart(Date.parse("2026-01-10T23:59:59.999Z"))).toBe(Date.parse("2025-11-12T00:00:00Z"));
  });
});

describe("deploy trend in a time zone", () => {
  it("knows real zones and refuses anything else", () => {
    for (const z of ["UTC", "Asia/Kathmandu", "America/Argentina/Buenos_Aires", "Etc/GMT+5"]) expect(isZone(z), z).toBe(true);
    for (const z of ["", "Mars/Olympus", "../etc/passwd", "Asia/Kathmandu ", "A".repeat(65), 42, null, undefined]) expect(isZone(z), String(z)).toBe(false);
  });
  it("counts in the saved zone, else the browser's, else UTC", () => {
    expect(trendZone("Europe/Berlin", "Asia/Kathmandu")).toBe("Europe/Berlin");
    expect(trendZone(null, "Asia/Kathmandu")).toBe("Asia/Kathmandu");
    expect(trendZone("Not/AZone", "Asia/Kathmandu")).toBe("Asia/Kathmandu");
    expect(trendZone(null, "Not/AZone")).toBe("UTC");
    expect(trendZone(undefined, undefined)).toBe("UTC");
  });
  it("reads the calendar day where the viewer is", () => {
    // 18:16 UTC on 31 Oct is one minute past midnight on 1 Nov in Nepal (UTC+5:45).
    const t = Date.parse("2026-10-31T18:16:00Z");
    expect(dayIn(t)).toBe("2026-10-31");
    expect(dayIn(t, "Asia/Kathmandu")).toBe("2026-11-01");
    expect(dayIn(t, "America/New_York")).toBe("2026-10-31");
  });
  it("finds where a day starts, across clock changes and a skipped midnight", () => {
    expect(dayStartIn("2026-11-01", "Asia/Kathmandu")).toBe(Date.parse("2026-10-31T18:15:00Z"));
    expect(dayStartIn("2026-03-08", "America/New_York")).toBe(Date.parse("2026-03-08T05:00:00Z"));
    expect(dayStartIn("2026-11-01", "America/New_York")).toBe(Date.parse("2026-11-01T04:00:00Z"));
    expect(dayStartIn("2026-11-02", "America/New_York")).toBe(Date.parse("2026-11-02T05:00:00Z"));
    expect(dayStartIn("2026-11-01")).toBe(Date.parse("2026-11-01T00:00:00Z"));
    // Chile skips from 00:00 to 01:00 on 6 Sep 2026, so that day starts at 01:00 local, 04:00 UTC.
    for (const [day, zone] of [["2026-09-06", "America/Santiago"], ["2026-03-29", "Asia/Beirut"], ["2026-01-01", "Pacific/Kiritimati"]] as const) {
      const start = dayStartIn(day, zone);
      expect(dayIn(start, zone), `${zone} ${day}`).toBe(day);
      expect(dayIn(start - 1000, zone), `${zone} ${day}`).not.toBe(day);
    }
    expect(dayStartIn("2026-09-06", "America/Santiago")).toBe(Date.parse("2026-09-06T04:00:00Z"));
  });
  it("runs the trend through the viewer's year, which can be a day ahead of UTC", () => {
    const eve = Date.parse("2026-12-31T20:00:00Z");
    expect(trendDays(eve)[0]).toBe("2026-01-01");
    expect(trendDays(eve).at(-1)).toBe("2026-12-31");
    // Already 1 Jan 2027 at UTC+14: the 59 day reach back starts 3 Nov 2026 and the year runs to 2027.
    const kiri = trendDays(eve, "Pacific/Kiritimati");
    expect(kiri[0]).toBe("2026-11-03");
    expect(kiri.at(-1)).toBe("2027-12-31");
    expect(trendStart(eve, "Pacific/Kiritimati")).toBe(dayStartIn("2026-11-03", "Pacific/Kiritimati"));
  });
});

/** Just enough Prisma for overview(): empty everywhere, plus the deployments the trend reads. */
function overviewDb(deployments: Array<{ createdAt: Date; status: string }>, seen: { trendFrom?: Date }): Db {
  const none = { count: async () => 0, groupBy: async () => [], findMany: async () => [], findUnique: async () => null, findFirst: async () => null };
  return {
    $queryRaw: async () => [],
    project: none, environment: none, app: none, domain: none, appUptimeDay: none, instance: none, user: none, releaseUpdate: none, metricSample: none,
    deployment: {
      count: async () => 0,
      findMany: async (args: { where?: { createdAt?: { gte?: Date } }; select?: { status?: boolean } }) => {
        // the recent list asks with include and no select; the trend asks for createdAt and status
        if (!args.select?.status) return [];
        const from = args.where?.createdAt?.gte;
        seen.trendFrom = from;
        return deployments.filter((d) => !from || d.createdAt >= from);
      },
    },
  } as unknown as Db;
}

describe("overview projects", () => {
  it("lists every active project, an empty one too, within a token's projects", async () => {
    const asked: unknown[] = [];
    // Its own project table: the helper shares one empty table object across every model.
    const db = Object.assign(overviewDb([], {}), {
      project: {
        count: async () => 0,
        findMany: async (args: unknown) => {
          asked.push(args);
          return [{ slug: "empty", name: "Empty" }, { slug: "shop", name: "Shop" }];
        },
      },
    }) as unknown as Db;
    const out = await overview(db, null, Date.parse("2026-07-01T12:00:00Z"));
    expect(out.projects).toEqual([{ slug: "empty", name: "Empty" }, { slug: "shop", name: "Shop" }]);
    expect(asked[0]).toMatchObject({ where: { archivedAt: null } });
    const token = { kind: "token", userId: "u", name: "ci", role: "admin", tokenId: "t", scope: "read", allProjects: false, projectIds: ["p1"], grants: [], elevated: false };
    await overview(db, token as unknown as Parameters<typeof overview>[1], Date.parse("2026-07-01T12:00:00Z"));
    expect(asked[1]).toMatchObject({ where: { id: { in: ["p1"] }, archivedAt: null } });
  });
});

describe("overview viewer", () => {
  const person = { name: "Sam", email: "sam@example.com", avatarUrl: null, timeZone: "Europe/Berlin", hour12: false };
  const dbOf = () => Object.assign(overviewDb([], {}), { user: { findUnique: async () => person } }) as unknown as Db;
  const at = Date.parse("2026-07-01T12:00:00Z");

  it("tells a signed-in person who they are", async () => {
    const session = { kind: "session", userId: "u", name: "Sam", role: "viewer", sessionId: "s", elevated: false };
    const out = await overview(dbOf(), session as unknown as Parameters<typeof overview>[1], at);
    expect(out.viewer).toMatchObject({ name: "Sam", email: "sam@example.com", role: "viewer" });
  });

  it("tells a token nothing about its owner, and still counts days in the owner's zone", async () => {
    const token = { kind: "token", userId: "u", name: "ci", role: "viewer", tokenId: "t", scope: "read", allProjects: false, projectIds: ["p1"], grants: [], elevated: false };
    const out = await overview(dbOf(), token as unknown as Parameters<typeof overview>[1], at);
    expect("viewer" in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain("sam@example.com");
    expect(out.trendZone).toBe("Europe/Berlin");
  });
});

describe("overview deploy trend", () => {
  it("queries from the day it zero-fills from, so January counts the end of last year", async () => {
    const seen: { trendFrom?: Date } = {};
    const db = overviewDb([
      { createdAt: new Date("2025-11-11T23:59:59Z"), status: "ready" },
      { createdAt: new Date("2025-11-12T08:00:00Z"), status: "ready" },
      { createdAt: new Date("2025-12-20T08:00:00Z"), status: "failed" },
      { createdAt: new Date("2026-01-10T09:00:00Z"), status: "ready" },
    ], seen);
    const out = await overview(db, null, Date.parse("2026-01-10T12:00:00Z"));
    expect(seen.trendFrom?.toISOString()).toBe("2025-11-12T00:00:00.000Z");
    expect(out.deployTrend[0]).toEqual({ date: "2025-11-12", total: 1, failed: 0 });
    expect(out.deployTrend.find((d) => d.date === "2025-12-20")).toEqual({ date: "2025-12-20", total: 1, failed: 1 });
    expect(out.deployTrend.find((d) => d.date === "2026-01-10")).toEqual({ date: "2026-01-10", total: 1, failed: 0 });
    expect(out.deployTrend.at(-1)).toEqual({ date: "2026-12-31", total: 0, failed: 0 });
    expect(out.deployTrend).toHaveLength(50 + 365);
    expect(out.deployTrend.reduce((n, d) => n + d.total, 0)).toBe(3);
  });
  it("starts the query and the trend at Jan 1 by midyear", async () => {
    const seen: { trendFrom?: Date } = {};
    const out = await overview(overviewDb([], seen), null, Date.parse("2026-07-01T12:00:00Z"));
    expect(seen.trendFrom?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(out.deployTrend[0]?.date).toBe("2026-01-01");
    expect(out.deployTrend.at(-1)?.date).toBe("2026-12-31");
    expect(out.deployTrend).toHaveLength(365);
    expect(out.trendZone).toBe("UTC");
  });

  // Nine deploys just after midnight on 1 Nov in Nepal, which is still 31 Oct in UTC.
  const lateNight = Array.from({ length: 9 }, (_, i) => ({ createdAt: new Date(Date.parse("2026-10-31T18:16:00Z") + i * 60_000), status: i < 6 ? "failed" : "ready" }));
  const morning = Date.parse("2026-11-01T06:00:00Z");
  const session = { kind: "session", userId: "u1", name: "Sam", role: "admin", sessionId: "s1", elevated: false } as unknown as Parameters<typeof overview>[1];

  it("counts the viewer's own calendar days when they saved a zone", async () => {
    const seen: { trendFrom?: Date } = {};
    const db = Object.assign(overviewDb(lateNight, seen), {
      user: { findUnique: async () => ({ name: "Sam", email: "k@example.com", avatarUrl: null, timeZone: "Asia/Kathmandu", hour12: false }) },
    }) as unknown as Db;
    const out = await overview(db, session, morning, { tz: "America/New_York" });
    expect(out.trendZone).toBe("Asia/Kathmandu");
    expect(seen.trendFrom?.toISOString()).toBe("2025-12-31T18:15:00.000Z");
    expect(out.deployTrend.find((d) => d.date === "2026-11-01")).toEqual({ date: "2026-11-01", total: 9, failed: 6 });
    expect(out.deployTrend.find((d) => d.date === "2026-10-31")).toEqual({ date: "2026-10-31", total: 0, failed: 0 });
    expect(out.deployTrend[0]?.date).toBe("2026-01-01");
  });

  it("falls back to the browser's zone, and to UTC for a zone it does not know", async () => {
    const browser = await overview(overviewDb(lateNight, {}), null, morning, { tz: "Asia/Kathmandu" });
    expect(browser.trendZone).toBe("Asia/Kathmandu");
    expect(browser.deployTrend.find((d) => d.date === "2026-11-01")?.total).toBe(9);
    const forged = await overview(overviewDb(lateNight, {}), null, morning, { tz: "Not/AZone" });
    expect(forged.trendZone).toBe("UTC");
    expect(forged.deployTrend.find((d) => d.date === "2026-10-31")?.total).toBe(9);
    expect(forged.deployTrend.find((d) => d.date === "2026-11-01")?.total).toBe(0);
  });
});

/** Just enough Prisma for the public status page. */
function statusDb(enabled: boolean, calls = { n: 0 }): Db {
  const now = Date.now();
  return {
    project: {
      findUnique: async () => {
        calls.n++;
        return {
          slug: "shop", name: "Shop internal", archivedAt: null,
          statusPage: {
            id: "p1", enabled, title: "Shop", logoUrl: "https://cdn.example.com/l.png",
            items: [
              { label: "Website", appId: "a1", app: { status: "running" } },
              { label: "API", appId: "a2", app: { status: "running" } },
            ],
            incidents: [{
              id: "i1", title: "Slow checkout", impact: "minor", status: "monitoring", startedAt: new Date(now - 3_600_000), resolvedAt: null,
              affects: ["API", "secret-internal-db"], updates: [{ at: new Date(now).toISOString(), status: "monitoring", body: "Fix out" }],
            }],
          },
        };
      },
    },
    appUptimeDay: { findMany: async () => [{ appId: "a1", day: new Date(Math.floor(now / 86_400_000) * 86_400_000), downMinutes: 40, degradedMinutes: 0, sampledMinutes: 600 }] },
    alertEvent: { findMany: async () => [{ appId: "a2", metric: "down" }] },
  } as unknown as Db;
}

describe("public status", () => {
  it("returns only whitelisted fields and caches per slug", async () => {
    clearStatusCache();
    const calls = { n: 0 };
    const db = statusDb(true, calls);
    const out = await publicStatus(db, "shop");
    expect(out.name).toBe("Shop");
    expect(out.state).toBe("outage");
    expect(out.components.map((c) => [c.name, c.state])).toEqual([["Website", "operational"], ["API", "outage"]]);
    expect(out.components[0]?.days).toHaveLength(90);
    expect(out.components[0]?.days.at(-1)).toMatchObject({ state: "major", downMinutes: 40 });
    expect(out.incidents[0]?.affects).toEqual(["API"]);
    expect(JSON.stringify(out)).not.toMatch(/internal|appId|a1|a2/);
    await publicStatus(db, "shop");
    expect(calls.n).toBe(1);
  });
  it("answers 404 without auth for an unpublished page, the same as for a missing one", async () => {
    clearStatusCache();
    const { app } = await buildApp({ db: statusDb(false), ring: testRing(), config: testConfig(), handlers: observeHandlers as never, logger: false });
    const res = await app.inject({ method: "GET", url: "/api/v1/public/status/shop" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Not found", code: "NOT_FOUND" });
    await app.close();
  });
  it("serves a published page publicly with a cache header", async () => {
    clearStatusCache();
    const { app } = await buildApp({ db: statusDb(true), ring: testRing(), config: testConfig(), handlers: observeHandlers as never, logger: false });
    const res = await app.inject({ method: "GET", url: "/api/v1/public/status/shop" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=30");
    expect(res.json().slug).toBe("shop");
    await app.close();
  });
});
