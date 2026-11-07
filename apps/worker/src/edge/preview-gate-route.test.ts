/** A preview's route file carries its gate in both ingress modes, and an ordinary app's never does. */
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { gateOlderRoutes } from "../integrations/previews.ts";
import { commentFor, type FeedbackView } from "../integrations/preview-feedback.ts";
import { assertNoEmptyValues, GATE_PRIORITY, CHECK_PRIORITY, renderAsleepRouteFile, renderRouteFile, routeFileName, type RouteFile, writeRoute } from "./routes.ts";
import { API_UPSTREAM } from "./ingress.ts";
import { fileRouteStore } from "@dockify/engine";

const PD = "0f0f0f0f-0000-4000-8000-0000000000a1";
const gateFile = (root: string, id: string) => join(root, "conf", routeFileName(id));
const RID = `pv-${PD}`;
const HOST = "pr-1-web.preview.example.com";
const BACKEND = "dk-pv-abc";
const tunnel = { ingress: "cloudflare_tunnel" } as const;
const direct = { ingress: "direct_tls", certResolver: "le" } as const;
const app = { id: RID, port: 3000, hosts: [HOST], gateId: PD };

const render = (mode: typeof tunnel | typeof direct, a = app): RouteFile => JSON.parse(renderRouteFile(a, BACKEND, mode, new Set())!) as RouteFile;

describe("a preview's route", () => {
  it.each([["tunnel", tunnel], ["direct", direct]] as const)("in %s mode, every request to the app asks the gate first", (_n, mode) => {
    const f = render(mode);
    assertNoEmptyValues(f);
    const router = f.http.routers![RID]!;
    expect(router.service).toBe(RID);
    expect(router.middlewares).toContain(`${RID}-gate-auth`);
    const auth = f.http.middlewares![`${RID}-gate-auth`] as { forwardAuth: { address: string; trustForwardHeader: boolean; authResponseHeaders: string[] } };
    expect(auth.forwardAuth.address).toBe(`${API_UPSTREAM}/internal/preview-gate/${PD}`);
    // Never believe a client's X-Forwarded-*, and hand the app the Cookie header with the gate's removed.
    expect(auth.forwardAuth.trustForwardHeader).toBe(false);
    expect(auth.forwardAuth.authResponseHeaders).toEqual(["Cookie"]);
  });

  it.each([["tunnel", tunnel], ["direct", direct]] as const)("in %s mode, the form has its own router with the id fixed, above the app", (_n, mode) => {
    const f = render(mode);
    const form = f.http.routers![`${RID}-gate`]!;
    expect(form.rule).toBe(`(Host(\`${HOST}\`)) && Path(\`/.well-known/dockify-preview-gate\`)`);
    expect(form.priority).toBe(GATE_PRIORITY);
    expect(GATE_PRIORITY).toBeLessThan(CHECK_PRIORITY);
    expect(form.middlewares).toContain(`${RID}-gate-path`);
    expect(f.http.middlewares![`${RID}-gate-path`]).toEqual({ replacePath: { path: `/.well-known/dockify-preview-gate/${PD}` } });
    expect(f.http.services![`${RID}-gate`]!.loadBalancer.servers[0]!.url).toBe(API_UPSTREAM);
  });

  it("direct mode keeps TLS and the client address middleware on both routers", () => {
    const f = render(direct);
    for (const name of [RID, `${RID}-gate`]) {
      expect(f.http.routers![name]!.tls).toEqual({ certResolver: "le" });
      expect(f.http.routers![name]!.middlewares![0]).toBe("dockify-client-ip@file");
    }
  });

  it("asks crawlers to stay out, on refusals too, by running that first", () => {
    const f = render(tunnel);
    expect(f.http.routers![RID]!.middlewares![0]).toBe(`${RID}-noindex`);
    expect(f.http.middlewares![`${RID}-noindex`]).toEqual({ headers: { customResponseHeaders: { "X-Robots-Tag": "noindex, nofollow" } } });
  });

  it("the counter that keeps a preview awake is only the app's service: a refused bot does not reach it", () => {
    const f = render(tunnel);
    expect(Object.keys(f.http.services!)).toEqual([RID, `${RID}-gate`]);
    expect(/service="(pv-[0-9a-f-]{36})@file"/.test(`service="${RID}-gate@file"`)).toBe(false);
  });

  it("an ordinary app gets none of it, and a sleeping preview's page stays static", () => {
    const plain = render(tunnel, { id: "a", port: 80, hosts: ["x.example.com"] } as never);
    expect(plain.http.middlewares).toBeUndefined();
    expect(plain.http.routers!.a!.middlewares).toBeUndefined();
    const asleep = renderAsleepRouteFile({ id: RID, port: 3000, hosts: [HOST] }, tunnel, new Set())!;
    expect(asleep).not.toContain("forwardAuth");
  });

  it("a moved host takes the form router with it, and the file goes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gate-"));
    await writeRoute(fileRouteStore(dir), app, BACKEND, tunnel, new Set());
    await writeRoute(fileRouteStore(dir), { id: "other", port: 80, hosts: [HOST] }, "dk-x", tunnel, new Set());
    await expect(readFile(gateFile(dir, RID), "utf8")).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("routes written before the gate", () => {
  it("get it on the reconcile, keeping their backend, and an address or a sleeping route is left alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gate-"));
    const old = renderRouteFile({ id: RID, port: 3000, hosts: [HOST] }, BACKEND, tunnel, new Set())!;
    expect(old).not.toContain("forwardAuth");
    await mkdir(join(dir, "conf"), { recursive: true });
    await writeFile(gateFile(dir, RID), old);
    const byAddress = "0f0f0f0f-0000-4000-8000-0000000000a2";
    const pinned = renderRouteFile({ id: `pv-${byAddress}`, port: 3000, hosts: ["b.example.com"] }, "10.0.0.5", tunnel, new Set())!;
    await writeFile(gateFile(dir, `pv-${byAddress}`), pinned);
    const db = {
      previewDeployment: {
        findMany: async () => [
          { id: PD, hostname: HOST, app: { port: 3000 } },
          { id: byAddress, hostname: "b.example.com", app: { port: 3000 } },
          { id: "0f0f0f0f-0000-4000-8000-0000000000a3", hostname: "c.example.com", app: { port: null } },
        ],
      },
    } as unknown as Db;
    await gateOlderRoutes({ db, serverId: "s1", routes: fileRouteStore(dir), mode: tunnel, dashboardHost: "" });
    const now = JSON.parse(await readFile(gateFile(dir, RID), "utf8")) as RouteFile;
    expect(now.http.routers![RID]!.middlewares).toContain(`${RID}-gate-auth`);
    expect(now.http.services![RID]!.loadBalancer.servers[0]!.url).toBe(`http://${BACKEND}.:3000`);
    expect(await readFile(gateFile(dir, `pv-${byAddress}`), "utf8")).toBe(pinned);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("the PR comment", () => {
  const view: FeedbackView = {
    prNumber: 1, status: "ready", reason: null, error: null, lines: [], updatedAt: new Date(0), fromFork: false, isolatedDb: true, isolation: "base", baseEnvironment: "development",
    apps: [{ name: "web", url: `https://${HOST}` }], dashboardUrl: null, idleMinutes: 30, ttlHours: 72,
  };
  it("says a URL is protected, without holding the password", () => {
    expect(commentFor({ ...view, passwordProtected: true })).toContain("Password protected");
    expect(commentFor({ ...view, passwordProtected: false })).not.toContain("Password protected");
  });
  it("says nothing when there is no URL to protect", () => {
    expect(commentFor({ ...view, passwordProtected: true, apps: [{ name: "web", url: null }] })).not.toContain("Password protected");
  });
});
