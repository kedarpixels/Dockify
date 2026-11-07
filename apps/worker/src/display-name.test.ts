/**
 * An app's display name is what people read; its name stays the identity. Renaming an app must
 * change nothing the worker builds from the row: container names, network aliases (a linked
 * variable's host), volumes, labels and routes. Each builder is fed the same row with and without a
 * display name, and must answer the same. Alerts read the display name in their text, while a
 * webhook's data keeps naming the app by its identity.
 */
import { describe, expect, it } from "vitest";
import { appContainerInput, labelsFor, mounts, type RunnableApp } from "./deploy/containers.ts";
import { serviceInput, type ServiceApp } from "./data/services.ts";
import { alertMessage, type AlertView } from "./observe/channels.ts";
import { read, type AppView, type World } from "./observe/alerts.ts";

const renamed = <T extends object>(row: T): T => ({ ...row, displayName: "Main database, EU" });

describe("a renamed app runs exactly as before", () => {
  it("keeps a service's container, alias, volume, network and labels", () => {
    const svc: ServiceApp = { id: "0f0e0d0c-0000-4000-8000-0000000000a1", name: "main-db", kind: "postgres", environmentId: "env-1", projectId: "prj-1", image: "postgres:17-alpine" };
    const creds = { user: "app", password: "x".repeat(32), database: "app" };
    const before = serviceInput(svc, creds);
    const after = serviceInput(renamed(svc), creds);
    expect(after).toEqual(before);
    // The alias a linked variable's connection URL dials is the name.
    expect(after.aliases).toEqual(["main-db"]);
    expect(after.name).toBe(`dk-${svc.id}`);
  });

  it("keeps an app container's name, aliases, mounts and labels", () => {
    const app: RunnableApp = {
      id: "0f0e0d0c-0000-4000-8000-0000000000a2", kind: "frontend", environmentId: "env-1", projectId: "prj-1", port: 3000, startCommand: null,
      memoryLimitMb: 512, cpuLimit: null, pidsLimit: null, capAdd: [], sysctls: {}, volumes: [{ id: "v1", name: "dockify-vol-1", mountPath: "/data" }],
    };
    const o = { name: `dk-${app.id}`, imageId: "sha256:abc", env: { PORT: "3000" }, deploymentId: "dep-1", role: "app" as const };
    expect(appContainerInput(renamed(app), o)).toEqual(appContainerInput(app, o));
    expect(labelsFor(renamed(app), "dep-1", "app")).toEqual(labelsFor(app, "dep-1", "app"));
    expect(mounts(renamed(app))).toEqual(mounts(app));
  });
});

describe("alerts about a renamed app", () => {
  it("read the name the alert runner hands them, and keep the identity in a webhook's data", () => {
    // The runner hands the display name to the detail (observe/alert-runner.ts).
    const app: AppView = { id: "a1", name: "Storefront", expectRunning: true, container: { state: "exited", health: null, memBytes: null, memLimitBytes: 0 }, restarts: [] };
    const world = { now: Date.now(), disk: null, services: {}, apps: new Map([["a1", app]]), dockerSeen: true } as unknown as World;
    const rule = { metric: "down", threshold: null, durationMin: 1 } as unknown as Parameters<typeof read>[0];
    expect(read(rule, { key: "app:a1", appId: "a1", service: null }, world, false).detail).toBe("Storefront is exited");

    const view: AlertView = {
      id: "ev1", metric: "down", service: null, detail: "Storefront is exited", href: "/apps/a1", startedAt: new Date("2026-11-07T10:00:00Z"), resolvedAt: null,
      app: { name: "web", shown: "Storefront", projectSlug: "horseai", environment: "production" },
    };
    const m = alertMessage(view, "firing", "https://dash.example.com", "Acme");
    expect(m.fields).toEqual([{ name: "Where", value: "horseai / production / Storefront" }]);
    expect((m.data as { app: unknown }).app).toEqual({ name: "web", projectSlug: "horseai", environment: "production" });
  });
});
