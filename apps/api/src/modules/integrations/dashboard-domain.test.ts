import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { dashboardDomain as D, endpoints } from "@dockify/contracts";
import { domainCheckAnswer, domainCheckToken } from "@dockify/crypto";
import type { Db } from "@dockify/db";
import type { Ctx } from "../../app.ts";
import { recordAddressChange } from "../../boot.ts";
import { describePolicy, POLICIES } from "../../policy.ts";
import { registerDomainCheckRoute } from "../domains/check-route.ts";
import { dashboardDomainHandlers, followGitHubWebhook, githubSteps, hostProblem } from "./dashboard-domain.ts";
import type { IntegrationDeps } from "./deps.ts";
import { testConfig, testRing } from "../../test-helpers.ts";
import { internalChannelToken } from "@dockify/crypto";

const CURRENT = "1-2-3-4.sslip.io";
const NEW = "dash.new.example.com";

interface World {
  instance: { publicUrl: string; dashboardDomain: unknown; dashboardPreviousHosts: string[]; dashboardLastChange: unknown; previewDomain: string | null };
  domains: Array<{ hostname: string; app: { name: string }; id?: string }>;
  jobs: Array<{ kind: string; payload: unknown; dedupeKey: string | null; lane?: string; completedAt?: Date | null; failedAt?: Date | null; lockedUntil?: Date | null; lastError?: string }>;
  audits: Array<{ action: string; verb: string; targetLabel?: string; suffix?: string | null; failed?: boolean }>;
  integrations: Record<string, { status: string; config: unknown; secretId: string | null; id: string } | undefined>;
}

function world(o: Partial<World["instance"]> = {}, integrations: World["integrations"] = {}): { w: World; db: Db } {
  const w: World = { instance: { publicUrl: `https://${CURRENT}`, dashboardDomain: null, dashboardPreviousHosts: [], dashboardLastChange: null, previewDomain: null, ...o }, domains: [], jobs: [], audits: [], integrations };
  const tx = {
    $executeRaw: async () => 0,
    instance: {
      findUnique: async () => w.instance,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        const next = { ...data };
        // Prisma.DbNull is how a JSON column is set to NULL.
        for (const k of Object.keys(next)) if (next[k] && typeof next[k] === "object" && String(next[k]).includes("DbNull")) next[k] = null;
        Object.assign(w.instance, next);
      },
    },
    domain: { findUnique: async ({ where }: { where: { hostname: string } }) => w.domains.find((d) => d.hostname === where.hostname) ?? null },
    previewDeployment: { findUnique: async () => null },
    integration: { findUnique: async ({ where }: { where: { kind_name: { kind: string } } }) => w.integrations[where.kind_name.kind] ?? null },
    job: {
      findFirst: async ({ where }: { where: { dedupeKey: string } }) => w.jobs.find((j) => j.dedupeKey === where.dedupeKey && !j.completedAt && !j.failedAt) ?? null,
      create: async ({ data }: { data: World["jobs"][number] }) => {
        w.jobs.push(data);
        return { id: `j${w.jobs.length}` };
      },
      updateMany: async ({ data }: { data: Partial<World["jobs"][number]> }) => {
        for (const j of w.jobs) if (j.dedupeKey?.startsWith("dashboard.domain.")) Object.assign(j, data);
        return { count: 1 };
      },
    },
    activityLog: { create: async ({ data }: { data: World["audits"][number] }) => void w.audits.push(data) },
    secret: { findUnique: async () => null },
  };
  return { w, db: { ...tx, $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as Db };
}

const actor = { kind: "session", userId: "u", name: "Ana", role: "admin", sessionId: "s", elevated: true } as const;
const req = { clientIp: "203.0.113.1", headers: {} } as never;
const deps = {} as IntegrationDeps;
const ctxOf = (db: Db, over: Partial<Ctx["config"]> = {}) => ({ db, ring: testRing(), config: testConfig({ publicUrl: new URL(`https://${CURRENT}`), ingress: "direct_tls", serverIpv4: "203.0.113.7", ...over }) }) as unknown as Ctx;
const handlers = dashboardDomainHandlers(deps);
const call = (id: keyof typeof handlers, ctx: Ctx, input: object = {}) => (handlers[id] as (i: object) => Promise<D.PendingDomain & { pending: D.PendingDomain | null; url: string; github: unknown; previousHosts: string[] }>)({ actor, req, ctx, ...input });
const pendingOf = (w: World) => D.readPendingDomain(w.instance.dashboardDomain);

describe("who can do what", () => {
  it("is Admin only, and anything that changes the address needs a step-up", () => {
    expect(describePolicy(POLICIES["settings.domain.get"])).toBe("session:admin");
    expect(describePolicy(POLICIES["settings.domain.check"])).toBe("session:admin");
    for (const id of ["settings.domain.start", "settings.domain.record", "settings.domain.switch", "settings.domain.previous.delete", "integrations.cloudflare.record"] as const) {
      expect(describePolicy(POLICIES[id]), id).toBe("elevated:admin");
    }
    expect(POLICIES["settings.domain.switch"].token).toBeUndefined();
    expect(endpoints["settings.domain.switch"].method).toBe("POST");
  });
});

describe("starting", () => {
  it("records the domain, queues a check and leaves an audit row", async () => {
    const { w, db } = world();
    const s = await call("settings.domain.start", ctxOf(db), { body: { hostname: NEW } });
    expect(s.pending).toMatchObject({ host: NEW, phase: "waiting", requestedBy: "Ana" });
    expect(s.url).toBe(`https://${CURRENT}`);
    expect(w.jobs.map((j) => j.kind)).toEqual(["dashboard_domain"]);
    expect(w.audits[0]).toMatchObject({ action: "dashboard.domain.start", targetLabel: NEW });
  });
  it("refuses the current address, a name an app holds, and a name that can never be public", async () => {
    const { w, db } = world();
    await expect(call("settings.domain.start", ctxOf(db), { body: { hostname: CURRENT } })).rejects.toMatchObject({ code: "SAME_HOSTNAME" });
    w.domains.push({ hostname: "taken.example.com", app: { name: "web" } });
    await expect(call("settings.domain.start", ctxOf(db), { body: { hostname: "taken.example.com" } })).rejects.toMatchObject({ code: "DOMAIN_TAKEN", status: 409 });
    await expect(call("settings.domain.start", ctxOf(db), { body: { hostname: "printer.local" } })).rejects.toMatchObject({ code: "HOSTNAME_NOT_PUBLIC" });
    expect(w.instance.dashboardDomain).toBeNull();
  });
  it("in a tunnel says at once that Cloudflare has to be connected", async () => {
    const { db } = world();
    await expect(call("settings.domain.start", ctxOf(db, { ingress: "cloudflare_tunnel" }), { body: { hostname: NEW } })).rejects.toMatchObject({ code: "NEEDS_CLOUDFLARE" });
  });
  it("does not start over while a switch is under way", async () => {
    const { db } = world({ dashboardDomain: { ...D.freshPendingDomain(NEW, null, new Date()), phase: "switching" } });
    await expect(call("settings.domain.start", ctxOf(db), { body: { hostname: "other.example.com" } })).rejects.toMatchObject({ code: "SWITCHING" });
  });
});

describe("switching", () => {
  it("is refused until the new domain answers and has its certificate", async () => {
    const { w, db } = world({ dashboardDomain: D.freshPendingDomain(NEW, null, new Date()) });
    await expect(call("settings.domain.switch", ctxOf(db), { body: {} })).rejects.toMatchObject({ code: "NOT_READY", status: 409 });
    expect(w.jobs).toEqual([]);
  });
  it("with nothing pending says so", async () => {
    const { db } = world();
    await expect(call("settings.domain.switch", ctxOf(db), { body: {} })).rejects.toMatchObject({ code: "NOT_PENDING" });
  });
  it("hands a ready domain to the worker to check once more, and audits it", async () => {
    const { w, db } = world({ dashboardDomain: { ...D.freshPendingDomain(NEW, null, new Date()), phase: "ready" } });
    await call("settings.domain.switch", ctxOf(db), { body: {} });
    expect(w.jobs).toEqual([expect.objectContaining({ kind: "dashboard_domain", payload: { switch: true } })]);
    expect(w.audits[0]).toMatchObject({ action: "dashboard.domain.switch", targetLabel: NEW, suffix: `from ${CURRENT}` });
  });
});

describe("the address it left", () => {
  it("stops answering only when asked, with its tunnel rules", async () => {
    const { w, db } = world({ dashboardPreviousHosts: ["old.example.com", "older.example.com"] });
    const s = await call("settings.domain.previous.delete", ctxOf(db), { params: { host: "old.example.com" } });
    expect(s.previousHosts).toEqual(["older.example.com"]);
    expect(w.jobs[0]).toMatchObject({ payload: { forget: "old.example.com" } });
    expect(w.audits[0]).toMatchObject({ action: "dashboard.domain.forget" });
  });
  it("404s for an address it never had", async () => {
    const { db } = world();
    await expect(call("settings.domain.previous.delete", ctxOf(db), { params: { host: "old.example.com" } })).rejects.toMatchObject({ status: 404 });
  });
});

describe("a change of address at boot", () => {
  it("keeps the old address answering, finishes the pending domain and records the change", async () => {
    const { w, db } = world({ dashboardDomain: { ...D.freshPendingDomain(NEW, null, new Date()), phase: "switching" } });
    await recordAddressChange(db, `https://${CURRENT}`, `https://${NEW}`);
    expect(w.instance.publicUrl).toBe(`https://${NEW}`);
    expect(w.instance.dashboardPreviousHosts).toEqual([CURRENT]);
    expect(w.instance.dashboardDomain).toBeNull();
    expect(w.instance.dashboardLastChange).toMatchObject({ from: CURRENT, to: NEW, webhook: "none" });
    expect(w.jobs.some((j) => j.kind === "dashboard_domain")).toBe(true);
    expect(w.audits[0]).toMatchObject({ action: "dashboard.address", targetLabel: NEW, suffix: `instead of ${CURRENT}` });
  });
  it("covers a change from the CLI or .env: another pending domain stays pending", async () => {
    const { w, db } = world({ dashboardDomain: D.freshPendingDomain("other.example.com", null, new Date()) });
    await recordAddressChange(db, `https://${CURRENT}`, `https://${NEW}`);
    expect(pendingOf(w)?.host).toBe("other.example.com");
  });
  it("keeps three addresses at most, never the current one, and never a local one", async () => {
    const { w, db } = world({ dashboardPreviousHosts: ["a.example.com", "b.example.com", "c.example.com"] });
    await recordAddressChange(db, "https://d.example.com", "https://a.example.com");
    expect(w.instance.dashboardPreviousHosts).toEqual(["d.example.com", "b.example.com", "c.example.com"]);
    const dev = world();
    await recordAddressChange(dev.db, "http://localhost:3006", `https://${NEW}`);
    expect(dev.w.instance.dashboardPreviousHosts).toEqual([]);
    expect(dev.w.instance.dashboardLastChange).toBeNull();
  });
  it("moves a derived preview domain with it, on both names", async () => {
    const { w, db } = world();
    await recordAddressChange(db, `https://dash.old.example.com`, `https://${NEW}`);
    const dns = w.jobs.filter((j) => j.kind === "preview_dns").map((j) => (j.payload as { domain: string }).domain);
    expect(dns).toEqual(["preview.old.example.com", "preview.new.example.com"]);
  });
});

describe("the pending domain's check path", () => {
  async function ask(db: Db, host: string, token: string) {
    const app = Fastify();
    const ctx = ctxOf(db);
    registerDomainCheckRoute(app, ctx);
    const r = await app.inject({ method: "GET", url: `/.well-known/dockify-check/${token}`, headers: { host } });
    await app.close();
    return r;
  }
  const secret = internalChannelToken(testRing());

  it("answers for the domain being set up, with its own token", async () => {
    const { db } = world({ dashboardDomain: D.freshPendingDomain(NEW, null, new Date()) });
    const token = domainCheckToken(secret, D.DASHBOARD_CHECK_ID, NEW);
    const r = await ask(db, NEW, token);
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe(domainCheckAnswer(secret, NEW, token));
  });
  it("is the same empty 404 for another host, another token or nothing pending", async () => {
    const pending = world({ dashboardDomain: D.freshPendingDomain(NEW, null, new Date()) });
    const none = world();
    const token = domainCheckToken(secret, D.DASHBOARD_CHECK_ID, NEW);
    for (const r of [
      await ask(pending.db, "other.example.com", token),
      await ask(pending.db, NEW, "0".repeat(64)),
      await ask(none.db, NEW, token),
    ]) {
      expect(r.statusCode).toBe(404);
      expect(r.body).toBe("");
    }
  });
});

describe("GitHub", () => {
  const appRow = { id: "gh", status: "connected", secretId: "s", config: { appId: 9, slug: "dockify-x", owner: { login: "acme", type: "Organization" } } };

  it("lists the App's exact values and the right settings page", () => {
    const s = githubSteps({ config: appRow.config }, `https://${NEW}`);
    expect(s).toEqual({
      slug: "dockify-x",
      settingsUrl: "https://github.com/organizations/acme/settings/apps/dockify-x",
      homepageUrl: `https://${NEW}`,
      callbackUrl: `https://${NEW}/api/v1/git/app/callback`,
      setupUrl: `https://${NEW}/api/v1/git/setup`,
      webhookUrl: `https://${NEW}/api/v1/webhooks/github`,
    });
    expect(githubSteps({ config: { slug: "x" } }, `https://${NEW}`).settingsUrl).toBe("https://github.com/settings/apps/x");
  });

  const last = (over: object = {}) => ({ from: CURRENT, to: NEW, at: "2026-11-06T12:00:00.000Z", webhook: "none", webhookError: null, ...over });
  const github = (fail = false) => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    return {
      calls,
      deps: { github: { jwt: async () => "jwt", call: async (method: string, path: string, _a: unknown, body: unknown) => {
        if (fail) throw new Error("GitHub PATCH /app/hook/config returned 403");
        calls.push({ method, path, body });
      } } } as unknown as IntegrationDeps,
    };
  };

  it("moves the webhook through GitHub's API once, after a change of address", async () => {
    const { w, db } = world({ dashboardLastChange: last() }, { github_app: appRow });
    const g = github();
    expect(await followGitHubWebhook(db, testRing(), g.deps, `https://${NEW}`)).toBe("updated");
    expect(g.calls).toEqual([{ method: "PATCH", path: "/app/hook/config", body: { url: `https://${NEW}/api/v1/webhooks/github` } }]);
    expect(w.instance.dashboardLastChange).toMatchObject({ webhook: "updated" });
    // Once: the next boot finds nothing to do.
    expect(await followGitHubWebhook(db, testRing(), g.deps, `https://${NEW}`)).toBe("skipped");
  });
  it("records a refusal for the page, and never throws", async () => {
    const { w, db } = world({ dashboardLastChange: last() }, { github_app: appRow });
    expect(await followGitHubWebhook(db, testRing(), github(true).deps, `https://${NEW}`)).toBe("failed");
    expect(w.instance.dashboardLastChange).toMatchObject({ webhook: "failed", webhookError: expect.stringContaining("403") });
    expect(w.audits[0]).toMatchObject({ failed: true });
  });
  it("does nothing with no App, or when the recorded change is not this address", async () => {
    const none = world({ dashboardLastChange: last() });
    const g = github();
    expect(await followGitHubWebhook(none.db, testRing(), g.deps, `https://${NEW}`)).toBe("skipped");
    const other = world({ dashboardLastChange: last({ to: "x.example.com" }) }, { github_app: appRow });
    expect(await followGitHubWebhook(other.db, testRing(), g.deps, `https://${NEW}`)).toBe("skipped");
    expect(g.calls).toEqual([]);
  });
});

describe("hostProblem", () => {
  it("is the one check the Settings flow and `dockify admin set-domain` share", async () => {
    const { w, db } = world();
    expect(await hostProblem(db, NEW)).toBeNull();
    w.domains.push({ hostname: NEW, app: { name: "web" } });
    expect(await hostProblem(db, NEW)).toMatchObject({ code: "DOMAIN_TAKEN" });
    expect(await hostProblem(db, "nas.lan")).toMatchObject({ code: "HOSTNAME_NOT_PUBLIC" });
  });
});
