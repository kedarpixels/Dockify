/** The password's life in the settings: made once when needed, shown once, never stored or audited in the clear. */
import { verify as argonVerify } from "@node-rs/argon2";
import { describe, expect, it } from "vitest";
import { projects as P } from "@dockify/contracts";
import { previewHandlers } from "./handlers.ts";

const PROJECT = "0f0f0f0f-0000-4000-8000-0000000000a1";
const APP = "0f0f0f0f-0000-4000-8000-0000000000a2";

function fake(over: Record<string, unknown> = {}, open: Array<{ id: string }> = [{ id: "pv1" }]) {
  const updates: Array<Record<string, unknown>> = [];
  const audits: unknown[] = [];
  const jobs: unknown[] = [];
  const row: Record<string, unknown> = {
    id: PROJECT, slug: "shop", archivedAt: null, previewEnabled: false, previewBaseEnv: "development", previewMaxConcurrent: 2, previewDomain: null,
    previewCpuLimit: 0.5, previewMemoryMb: 512, previewPidsLimit: 128, previewIdleMinutes: 30, previewTtlHours: 72, previewFromForks: false, previewIsolatedDb: true, previewProductionAccess: false,
    previewAccess: "password", previewPasswordSetAt: null, environments: [{ id: "e", name: "development", apps: [{ id: APP, name: "web", kind: "frontend", previewEnabled: true, gitRepository: "o/r", deployTarget: "server" }] }], ...over,
  };
  const tx = {
    $executeRaw: async () => 1,
    project: { update: async ({ data }: { data: Record<string, unknown> }) => { updates.push(data); Object.assign(row, data); return row; } },
    app: { update: async () => ({}) },
    instance: { update: async () => ({}) },
    previewEnv: { findMany: async () => open },
    activityLog: { create: async ({ data }: { data: unknown }) => { audits.push(data); return {}; } },
    job: { upsert: async (a: unknown) => { jobs.push(a); return {}; }, findFirst: async () => null, create: async (a: unknown) => { jobs.push(a); return {}; } },
    previewDomain: { upsert: async () => ({}) },
    server: { findFirst: async () => ({ id: "srv-1" }) },
  };
  const db = {
    ...tx,
    project: { ...tx.project, findUnique: async () => ({ ...row }) },
    instance: { findUnique: async () => ({ previewServerMax: 4, previewDomain: null, publicUrl: "https://dash.example.com" }), update: async () => ({}) },
    $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
  };
  return { db, updates, audits, jobs, row };
}

const ctx = (db: unknown) => ({ db, config: { publicUrl: new URL("https://dash.example.com"), ingress: "direct_tls", serverIpv4: null } }) as never;
const actor = { kind: "session", userId: "u", name: "Owner", role: "admin", sessionId: "s", elevated: true } as never;
const req = { clientIp: "1.1.1.1", headers: {} } as never;
const body = (o: Partial<P.PreviewSettings> = {}): P.PreviewSettings => ({ enabled: true, baseEnvironment: "development", appIds: [APP], domain: null, maxConcurrent: 2, serverMaxConcurrent: 4, cpuLimit: 0.5, memoryMb: 512, pidsLimit: 128, idleMinutes: 30, ttlHours: 72, fromForks: false, isolatedDb: true, productionAccess: false, access: "password", ...o });
const save = (db: unknown, b: P.PreviewSettings) => previewHandlers["previews.settings"]!({ params: { slug: "shop" }, body: b, actor, req, ctx: ctx(db) } as never) as Promise<Record<string, unknown>>;

describe("preview settings and the password", () => {
  it("defaults a new project's settings to protected", () => {
    expect(P.PREVIEW_DEFAULTS.access).toBe("password");
    expect(P.PreviewSettings.safeParse({ ...body(), access: "anyone" }).success).toBe(false);
  });

  it("refuses a password from the client: it is always generated", () => {
    expect(P.PreviewSettings.safeParse({ ...body(), password: "hunter2" }).success).toBe(false);
  });
});

describe("previews.password", () => {
  it("returns a new password once, stores only its hash, and audits no secret", async () => {
    const f = fake({ previewPasswordSetAt: new Date(0), previewPasswordHash: "old" });
    const out = (await previewHandlers["previews.password"]!({ params: { slug: "shop" }, actor, req, ctx: ctx(f.db) } as never)) as { password: string; setAt: string };
    expect(out.password).toMatch(/^[a-z2-9]{5}(-[a-z2-9]{5}){3}$/);
    const stored = f.updates[0]!.previewPasswordHash as string;
    expect(stored).not.toContain(out.password);
    expect(await argonVerify(stored, out.password)).toBe(true);
    expect(JSON.stringify(f.audits)).not.toContain(out.password);
    expect(JSON.stringify(f.audits)).not.toContain(stored);
    expect(JSON.stringify(f.audits)).toContain("previews.password");
  });
});

describe("the policy", () => {
  it("makes a new password an elevated, admin only, session only act", async () => {
    const { POLICIES } = await import("../../policy.ts");
    expect(POLICIES["previews.password"]).toMatchObject({ access: "elevated", role: "admin" });
    expect((POLICIES["previews.password"] as { token?: unknown }).token).toBeUndefined();
    expect(POLICIES["apps.terminal.ticket"]).toMatchObject({ access: "elevated", role: "admin" });
    expect((POLICIES["apps.terminal.ticket"] as { token?: unknown }).token).toBeUndefined();
    expect((POLICIES["apps.terminal"] as { token?: unknown }).token).toBeUndefined();
  });
});

describe("previews may use production secrets and services", () => {
  it("is off when nothing says otherwise, and a body has to say", () => {
    expect(P.PREVIEW_DEFAULTS.productionAccess).toBe(false);
    const { productionAccess: _gone, ...old } = body();
    expect(P.PreviewSettings.safeParse(old).success).toBe(false);
  });

  it("is saved, read back and audited, and tells open pull requests", async () => {
    const f = fake({ previewPasswordSetAt: new Date(0), previewEnabled: true });
    const out = await save(f.db, body({ productionAccess: true }));
    expect(f.updates[0]).toMatchObject({ previewProductionAccess: true });
    expect(out.productionAccess).toBe(true);
    expect(JSON.stringify(f.audits)).toContain('"productionAccess":true');
    expect(JSON.stringify(f.audits)).toContain("previews.settings");
    expect(JSON.stringify(f.jobs)).toContain("preview_feedback");
  });

  it("queues the reconcile at once when it changes, either way, and not otherwise", async () => {
    const reconciles = (f: ReturnType<typeof fake>) => (f.jobs as Array<{ data: { kind: string; lane: string; serverId: string; dedupeKey: string | null } }>).filter((j) => j.data.kind === "reconcile");
    for (const [from, to] of [[true, false], [false, true]] as const) {
      const f = fake({ previewPasswordSetAt: new Date(0), previewEnabled: true, previewProductionAccess: from });
      await save(f.db, body({ productionAccess: to }));
      expect(reconciles(f).map((j) => j.data)).toEqual([expect.objectContaining({ kind: "reconcile", lane: "maintenance", serverId: "srv-1", dedupeKey: null })]);
    }
    const same = fake({ previewPasswordSetAt: new Date(0), previewEnabled: true, previewProductionAccess: true });
    await save(same.db, body({ productionAccess: true }));
    expect(reconciles(same)).toEqual([]);
    // Turning previews off retires them, so nothing is left to move.
    const off = fake({ previewPasswordSetAt: new Date(0), previewEnabled: true, previewProductionAccess: true }, []);
    await save(off.db, body({ enabled: false, productionAccess: false }));
    expect(reconciles(off)).toEqual([]);
  });

  it("needs a fresh step-up, like the settings around it", async () => {
    const { POLICIES } = await import("../../policy.ts");
    expect(POLICIES["previews.settings"]).toMatchObject({ access: "elevated", role: "admin" });
  });
});

describe("saving settings", () => {
  it("makes the first password when protection is on and none exists, and returns it once", async () => {
    const f = fake();
    const out = await save(f.db, body());
    expect(typeof out.password).toBe("string");
    expect(await argonVerify(f.updates[0]!.previewPasswordHash as string, out.password as string)).toBe(true);
    expect(JSON.stringify(f.audits)).not.toContain(out.password as string);
    expect(P.PreviewSettingsSaved.safeParse(out).success).toBe(true);
  });

  it("does not touch an existing password, or make one for Public or while off", async () => {
    const has = fake({ previewPasswordSetAt: new Date(0) });
    expect((await save(has.db, body())).password).toBeUndefined();
    expect(has.updates[0]).not.toHaveProperty("previewPasswordHash");
    const pub = fake();
    expect((await save(pub.db, body({ access: "public" }))).password).toBeUndefined();
    const off = fake({}, []);
    expect((await save(off.db, body({ enabled: false }))).password).toBeUndefined();
  });

  it("updates open pull request comments when the access changes", async () => {
    const f = fake({ previewPasswordSetAt: new Date(0), previewAccess: "public", previewEnabled: true });
    await save(f.db, body());
    expect(JSON.stringify(f.jobs)).toContain("preview_feedback");
    const same = fake({ previewPasswordSetAt: new Date(0), previewEnabled: true });
    await save(same.db, body());
    expect(JSON.stringify(same.jobs)).not.toContain("preview_feedback");
  });
});
