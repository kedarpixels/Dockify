import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpointIds, endpoints, removedEndpoints } from "@dockify/contracts";
import { buildApp, moduleHandlers, PLUGIN_OWNED, type RegisteredRoute } from "./app.ts";
import { INFRA_POLICIES, POLICIES, type Policy } from "./policy.ts";
import { noDb, testConfig, testRing } from "./test-helpers.ts";

let app: Awaited<ReturnType<typeof buildApp>>["app"];
let routes: RegisteredRoute[];

beforeAll(async () => {
  ({ app, routes } = await buildApp({ db: noDb(), ring: testRing(), config: testConfig(), logger: false }));
  await app.ready();
});
afterAll(() => app.close());

const policies = POLICIES as Record<string, Policy>;

describe("route policy table", () => {
  it("has exactly one policy per contract endpoint", () => {
    expect(Object.keys(POLICIES).sort()).toEqual([...endpointIds].sort());
  });

  it("registers every contract endpoint, and every registered route carries a policy", () => {
    for (const r of routes) expect(r.policy, `${r.method} ${r.url}`).toBeTruthy();
    const registered = new Set(routes.map((r) => `${r.method} ${r.url}`));
    for (const id of endpointIds) {
      const d = endpoints[id];
      expect(registered.has(`${d.method} ${d.path}`), id).toBe(true);
    }
    expect(routes.length).toBe(endpointIds.length + Object.keys(INFRA_POLICIES).length);
  });

  it("has a handler for every endpoint except the reviewed unbuilt list", () => {
    // Shrinks as modules land. Adding an endpoint without a handler must be a deliberate edit here.
    const UNBUILT: string[] = [];
    const handled = moduleHandlers() as Record<string, unknown>;
    const missing = endpointIds.filter((id) => !handled[id] && !PLUGIN_OWNED.has(id)).sort();
    expect(missing).toEqual(UNBUILT);
  });

  it("refuses to register a route without a policy", async () => {
    const { app: other } = await buildApp({ db: noDb(), ring: testRing(), config: testConfig(), logger: false });
    expect(() => other.get("/api/v1/sneaky", async () => ({}))).toThrow(/no policy/);
    await other.close();
  });

  it("lets a token reach an elevated route only with an explicit grant, and only the env writes", () => {
    const withToken = Object.entries(policies).filter(([, p]) => p.access === "elevated" && p.token).map(([id, p]) => [id, p] as const);
    for (const [id, p] of withToken) {
      expect(p.grant, id).toBe("env:write");
      expect(p.token, id).toBe("admin");
    }
    expect(withToken.map(([id]) => id).sort()).toEqual(["env.apply", "env.delete", "env.put", "env.rollback"]);
  });

  it("keeps anonymous routes to a reviewed list", () => {
    const anon = Object.entries(policies).filter(([, p]) => p.access === "anonymous").map(([id]) => id).sort();
    expect(anon).toEqual([
      "auth.forgot", "auth.invite.accept", "auth.invite.get", "auth.login", "auth.logout", "auth.reset",
      "auth.reset.get", "auth.setup", "auth.setupStatus", "auth.verify", "git.app.callback", "git.setup", "icons.mail.get", "public.status", "webhooks.github", "webhooks.vercel",
    ]);
  });

  it("puts every privilege-changing or destructive route behind step-up", () => {
    const mustElevate = [
      "apps.version.change", "apps.version.switch", "apps.version.back", "apps.patch", "apps.delete", "apps.stop", "apps.restart", "apps.config.patch", "apps.terminal.ticket", "apps.data.query",
      "projects.delete", "projects.apps.create", "projects.apps.import", "projects.apps.template", "environments.patch", "environments.delete",
      "resources.create", "domains.delete", "backups.restore",
      "backups.download", "backups.schedules.patch", "backups.orphans.delete", "server.updates.apply",
      "settings.patch", "team.change", "tokens.create", "integrations.storage.create", "integrations.storage.patch",
      "integrations.cloudflare.connect", "integrations.registries.create",
      "me.2fa.setup", "me.2fa.verify", "apps.data.rows", "integrations.vercel.import",
      "env.put", "env.apply", "env.rollback", "env.delete", "integrations.email.connect", "integrations.email.delete",
      "git.app.manifest", "git.app.delete",
      "integrations.webhooks.create", "integrations.webhooks.patch", "integrations.webhooks.delete",
      "team.invites.create", "projects.patch", "previews.settings", "previews.delete", "git.installations.delete",
      "integrations.vercel.connect", "integrations.vercel.delete", "integrations.cloudflare.delete",
      "integrations.registries.patch", "integrations.registries.delete", "integrations.storage.delete",
      "server.updates.rollback", "server.updates.policy", "server.updates.skip", "server.updates.pause", "integrations.cloudflare.zone",
    ];
    for (const id of mustElevate) expect(policies[id]?.access, id).toBe("elevated");
  });
});

describe("enforcement", () => {
  it("answers 401 without a session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/overview" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("refuses a bearer token on a route that takes none, before any lookup", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/projects/demo/env", headers: { authorization: "Bearer abc" } });
    expect(res.statusCode).toBe(403);
  });

  it("answers 501 for a registered but unbuilt anonymous route", async () => {
    const { app: bare } = await buildApp({ db: noDb(), ring: testRing(), config: testConfig(), logger: false, handlers: {}, integrations: false });
    const res = await bare.inject({ method: "GET", url: "/api/v1/public/status/demo" });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ code: "NOT_IMPLEMENTED" });
    await bare.close();
  });

  it("validates bodies with the contract schema and names the field", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "nope", password: "x" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ field: "email" });
  });

  it("rejects unknown body keys (no mass assignment)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "a@b.co", password: "x", role: "admin" } });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a cross-origin write", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: "https://evil.example" },
      payload: { email: "a@b.co", password: "x" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "CROSS_ORIGIN" });
  });

  describe("the SSH tunnel's origin", () => {
    // Each from its own address: the login bucket answers before the origin check.
    let peer = 0;
    const login = (headers: Record<string, string>) => app.inject({ method: "POST", url: "/api/v1/auth/login", remoteAddress: `10.77.0.${++peer}`, headers, payload: { email: "a@b.co", password: "x" } });
    const TUNNEL = "http://127.0.0.1:3000";

    it("is admitted only with the web's word that the browser's Host is that address", async () => {
      expect((await login({ origin: TUNNEL, "x-dockify-loopback-host": "127.0.0.1:3000", "sec-fetch-site": "same-origin" })).json()).not.toMatchObject({ code: "CROSS_ORIGIN" });
    });
    it("is refused without it: a local page posting to the public address", async () => {
      expect((await login({ origin: TUNNEL })).json()).toMatchObject({ code: "CROSS_ORIGIN" });
    });
    it("is refused on any other port, and any other loopback spelling", async () => {
      expect((await login({ origin: "http://127.0.0.1:8080", "x-dockify-loopback-host": "127.0.0.1:3000" })).json()).toMatchObject({ code: "CROSS_ORIGIN" });
      expect((await login({ origin: "http://127.0.0.1:8080", "x-dockify-loopback-host": "127.0.0.1:8080" })).json()).toMatchObject({ code: "CROSS_ORIGIN" });
      expect((await login({ origin: "http://localhost:3000", "x-dockify-loopback-host": "localhost:3000" })).json()).toMatchObject({ code: "CROSS_ORIGIN" });
      expect((await login({ origin: "https://127.0.0.1:3000", "x-dockify-loopback-host": "127.0.0.1:3000" })).json()).toMatchObject({ code: "CROSS_ORIGIN" });
    });
    it("does not open a door for anyone else: a foreign origin or a cross-site fetch with the header stays refused", async () => {
      expect((await login({ origin: "https://evil.example", "x-dockify-loopback-host": "127.0.0.1:3000" })).json()).toMatchObject({ code: "CROSS_ORIGIN" });
      expect((await login({ origin: TUNNEL, "x-dockify-loopback-host": "127.0.0.1:3000", "sec-fetch-site": "cross-site" })).json()).toMatchObject({ code: "CROSS_ORIGIN" });
      expect((await login({ origin: TUNNEL, "x-dockify-loopback-host": "127.0.0.1:3000", "sec-fetch-site": "same-site" })).json()).toMatchObject({ code: "CROSS_ORIGIN" });
    });
    it("the public origin keeps working with no header", async () => {
      expect((await login({ origin: testConfig().publicUrl.origin })).json()).not.toMatchObject({ code: "CROSS_ORIGIN" });
    });
  });

  it("refuses a same-site write from a sibling subdomain", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { "sec-fetch-site": "same-site" },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it("registers no removed endpoint and 404s the old resources connection read", async () => {
    const registered = new Set(routes.map((r) => `${r.method} ${r.url}`));
    for (const r of removedEndpoints) expect(registered.has(`${r.method} ${r.path}`), r.id).toBe(false);
    expect(Object.keys(POLICIES)).not.toContain("resources.connection");
    const res = await app.inject({ method: "GET", url: "/api/v1/resources/00000000-0000-4000-8000-000000000000/connection" });
    expect(res.statusCode).toBe(404);
  });

  it("sends the security headers and 404s unknown paths without detail", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/nothing-here" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  it("keeps /readyz to a single boolean", async () => {
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(Object.keys(res.json())).toEqual(["ok"]);
  });

  it("stays ready after a key rotation while the old key is loaded as a previous key, and not with a stranger's key", async () => {
    const { keyFingerprint, loadKeyring } = await import("@dockify/crypto");
    const oldKey = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 29 + 11) % 251)).toString("base64");
    const rotated = loadKeyring({ DOCKIFY_MASTER_KEY: testRing().keys.get(testRing().active)!.toString("base64"), DOCKIFY_MASTER_KEY_PREVIOUS: oldKey } as NodeJS.ProcessEnv);
    const oldFp = keyFingerprint(Buffer.from(oldKey, "base64"));
    const db = (fp: string) => ({ instance: { findUnique: async () => ({ masterKeyFingerprint: fp }) } }) as never;
    for (const [fp, ring, code] of [[oldFp, rotated, 200], [oldFp, testRing(), 503]] as const) {
      const { app: a } = await buildApp({ db: db(fp), ring, config: testConfig(), logger: false, handlers: {}, integrations: false });
      expect((await a.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(code);
      await a.close();
    }
  });

  it("rate limits the auth routes per client address", async () => {
    const { app: fresh } = await buildApp({ db: noDb(), ring: testRing(), config: testConfig(), logger: false });
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await fresh.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "bad" } });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 400)).toBe(true);
    expect(codes[10]).toBe(429);
    await fresh.close();
  });
});

describe("fastify sanity", () => {
  it("is Fastify 5", () => {
    expect(Fastify().version.startsWith("5.")).toBe(true);
  });
});
