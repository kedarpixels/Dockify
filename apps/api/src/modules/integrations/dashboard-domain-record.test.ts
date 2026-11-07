/**
 * The dashboard's new address on a Cloudflare zone Dockify manages, found on the test box:
 *
 *   - the name was looked up before Dockify made its record, so resolvers cached "no such name" for
 *     the zone's negative TTL (30 minutes on Cloudflare) and the checks waited that long;
 *   - Stop answering on an old address left the record Dockify itself had made.
 *
 * Cloudflare's side is stubbed at the module that talks to it; everything else is the real handler.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardDomain as D } from "@dockify/contracts";
import type { Db } from "@dockify/db";
import type { Ctx } from "../../app.ts";
import { testConfig, testRing } from "../../test-helpers.ts";

const cf = vi.hoisted(() => ({
  connected: true,
  records: [] as Array<{ id: string; type: string; name: string; content: string; proxied: boolean; ours: boolean }>,
  managed: true,
  put: { zoneId: "a".repeat(32), recordId: "b".repeat(32) as string | null, removed: [] as unknown[], created: true },
}));

vi.mock("./cloudflare-domains.ts", async (original) => ({
  ...(await original<object>()),
  hostReadContext: async () => (cf.connected ? { api: {}, zones: [], managed: new Set(), target: {}, settings: new Map() } : null),
  readHost: async (_c: unknown, host: string) => ({
    hostname: host, zone: { id: "a".repeat(32), name: "example.com", status: "active" }, managed: cf.managed, records: cf.records,
    expected: { type: "A", content: "203.0.113.7", proxied: null }, correct: false, sslMode: null, alwaysUseHttps: null, findings: [],
  }),
  putRecord: async () => cf.put,
}));

const { dashboardDomainHandlers } = await import("./dashboard-domain.ts");
const { recordAddressChange } = await import("../../boot.ts");

const CURRENT = "1-2-3-4.sslip.io";
const NEW = "dash.example.com";
const ZONE = "a".repeat(32);
const MADE = "b".repeat(32);

interface Job { kind: string; lane?: string; payload: unknown; dedupeKey: string | null }
function world(o: Record<string, unknown> = {}) {
  const w = {
    instance: { publicUrl: `https://${CURRENT}`, dashboardDomain: null as unknown, dashboardPreviousHosts: [] as string[], dashboardLastChange: null, dashboardCfRecords: null as unknown, previewDomain: "preview.example.com", ...o },
    jobs: [] as Job[],
    audits: [] as Array<{ action: string; suffix?: string | null }>,
  };
  const tx = {
    $executeRaw: async () => 0,
    instance: {
      findUnique: async () => w.instance,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        const next = { ...data };
        for (const k of Object.keys(next)) if (next[k] && typeof next[k] === "object" && String(next[k]).includes("DbNull")) next[k] = null;
        Object.assign(w.instance, next);
      },
    },
    domain: { findUnique: async () => null },
    previewDeployment: { findUnique: async () => null },
    integration: { findUnique: async ({ where }: { where: { kind_name: { kind: string } } }) => (where.kind_name.kind === "cloudflare" && cf.connected ? { id: "c", status: "connected", config: {}, secretId: null } : null) },
    job: {
      findFirst: async ({ where }: { where: { dedupeKey: string } }) => w.jobs.find((j) => j.dedupeKey === where.dedupeKey) ?? null,
      create: async ({ data }: { data: Job }) => (w.jobs.push(data), { id: `j${w.jobs.length}` }),
      updateMany: async () => ({ count: 0 }),
    },
    activityLog: { create: async ({ data }: { data: { action: string } }) => void w.audits.push(data) },
    secret: { findUnique: async () => null },
  };
  return { w, db: { ...tx, $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as Db };
}

const actor = { kind: "session", userId: "u", name: "Ana", role: "admin", sessionId: "s", elevated: true } as const;
const req = { clientIp: "203.0.113.1", headers: {} } as never;
const handlers = dashboardDomainHandlers({} as never);
const ctxOf = (db: Db) => ({ db, ring: testRing(), config: testConfig({ publicUrl: new URL(`https://${CURRENT}`), ingress: "direct_tls", serverIpv4: "203.0.113.7" }) }) as unknown as Ctx;
type State = { pending: D.PendingDomain | null; previousHosts: string[]; previousRecords: string[] };
const call = (id: keyof typeof handlers, db: Db, input: object = {}) => (handlers[id] as (i: object) => Promise<State>)({ actor, req, ctx: ctxOf(db), ...input });
const checks = (w: { jobs: Job[] }) => w.jobs.filter((j) => j.kind === "dashboard_domain");

beforeEach(() => {
  cf.connected = true;
  cf.managed = true;
  cf.records = [];
  cf.put = { zoneId: ZONE, recordId: MADE, removed: [], created: true };
});

describe("a new address on a zone Dockify manages: the record first, the lookup after", () => {
  it("queues no lookup while the page offers to create the record", async () => {
    const { w, db } = world();
    const s = await call("settings.domain.start", db, { body: { hostname: NEW } });
    expect(s.pending?.recordFirst).toBe(true);
    expect(checks(w)).toEqual([]);
  });

  it("looks up at once as before when the name has a record, the zone is not Dockify's, or Cloudflare is not connected", async () => {
    for (const set of [() => (cf.records = [{ id: "c".repeat(32), type: "A", name: NEW, content: "203.0.113.7", proxied: false, ours: false }]), () => (cf.managed = false), () => (cf.connected = false)]) {
      cf.records = [];
      cf.managed = true;
      cf.connected = true;
      set();
      const { w, db } = world();
      const s = await call("settings.domain.start", db, { body: { hostname: NEW } });
      expect(s.pending?.recordFirst).toBeUndefined();
      expect(checks(w)).toHaveLength(1);
    }
  });

  it("creating the record ends the wait, records it as Dockify's, and queues the lookup", async () => {
    const { w, db } = world();
    await call("settings.domain.start", db, { body: { hostname: NEW } });
    const s = await call("settings.domain.record", db, { body: { proxied: false } });
    expect(s.pending?.recordFirst).toBeUndefined();
    expect(s.pending?.cfRecord).toEqual({ zoneId: ZONE, recordId: MADE });
    expect(checks(w)).toHaveLength(1);
  });

  it("never records a record the owner made as Dockify's, even when it is the right one", async () => {
    const { db } = world();
    await call("settings.domain.start", db, { body: { hostname: NEW } });
    cf.put = { zoneId: ZONE, recordId: "d".repeat(32), removed: [], created: false };
    const s = await call("settings.domain.record", db, { body: { proxied: false, replace: ["d".repeat(32)] } });
    expect(s.pending?.cfRecord).toBeNull();
  });

  it("Check now looks up whether or not the record was made", async () => {
    const { w, db } = world();
    await call("settings.domain.start", db, { body: { hostname: NEW } });
    // The worker never runs here, so the handler returns after its wait: keep that short.
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const done = call("settings.domain.check", db, { body: {} });
    await vi.advanceTimersByTimeAsync(20_000);
    const s = await done;
    vi.useRealTimers();
    expect(s.pending?.recordFirst).toBeUndefined();
    expect(checks(w)).toHaveLength(1);
  });
});

describe("the Cloudflare record of an old address", () => {
  const moved = (cfRecord: { zoneId: string; recordId: string } | null) => world({ dashboardDomain: { ...D.freshPendingDomain(NEW, null, new Date()), phase: "switching", cfRecord } });

  it("outlives the pending domain when the dashboard moves to it", async () => {
    const { w, db } = moved({ zoneId: ZONE, recordId: MADE });
    await recordAddressChange(db, `https://${CURRENT}`, `https://${NEW}`);
    expect(w.instance.dashboardDomain).toBeNull();
    expect(D.readCfRecords(w.instance.dashboardCfRecords)).toEqual({ [NEW]: { zoneId: ZONE, recordId: MADE } });
    // Moving away again: NEW is now an old address, and the page says Stop answering removes its record.
    await recordAddressChange(db, `https://${NEW}`, `https://${CURRENT}`);
    const s = await call("settings.domain.get", db);
    expect(s.previousHosts).toEqual([NEW]);
    expect(s.previousRecords).toEqual([NEW]);
  });

  it("Stop answering removes the record Dockify made, by its recorded id, and forgets it", async () => {
    const { w, db } = world({ dashboardPreviousHosts: [NEW, "old.example.com"], dashboardCfRecords: { [NEW]: { zoneId: ZONE, recordId: MADE } } });
    const s = await call("settings.domain.previous.delete", db, { params: { host: NEW } });
    expect(w.jobs).toContainEqual(expect.objectContaining({ kind: "edge_cf_unwire", lane: "maintenance", payload: { hostname: NEW, zoneId: ZONE, recordId: MADE, tunnelId: null } }));
    expect(D.readCfRecords(w.instance.dashboardCfRecords)).toEqual({});
    expect(s.previousRecords).toEqual([]);
    expect(w.audits.at(-1)).toMatchObject({ action: "dashboard.domain.forget", suffix: "removing the Cloudflare record Dockify made for it" });
  });

  it("never touches a record Dockify did not make", async () => {
    const { w, db } = moved(null);
    await recordAddressChange(db, `https://${CURRENT}`, `https://${NEW}`);
    await recordAddressChange(db, `https://${NEW}`, `https://${CURRENT}`);
    await call("settings.domain.previous.delete", db, { params: { host: NEW } });
    expect(w.jobs.map((j) => j.kind)).not.toContain("edge_cf_unwire");
    expect(w.audits.at(-1)).toMatchObject({ action: "dashboard.domain.forget", suffix: null });
  });

  it("a later move onto the same name with the owner's record drops the old entry", async () => {
    const { w, db } = moved(null);
    w.instance.dashboardCfRecords = { [NEW]: { zoneId: ZONE, recordId: MADE } };
    await recordAddressChange(db, `https://${CURRENT}`, `https://${NEW}`);
    expect(D.readCfRecords(w.instance.dashboardCfRecords)).toEqual({});
  });
});
