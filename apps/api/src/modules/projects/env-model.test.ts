import { describe, expect, it } from "vitest";
import { projects } from "@dockify/contracts";
import {
  affectedApps, diff, EnvPlanError, listedValue, parseSnapshot, plan, refValueFor, refView, resolveFor, resolveValue, restrictTo, serializeSnapshot,
  servicesOf, toSet, type Entry, type RefService, type ResolvedChange,
} from "./env-model.ts";

const ENV = "env-prod";
const APP = "app-web";
const OTHER = "app-api";
const apps = [{ id: APP, environmentId: ENV }, { id: OTHER, environmentId: ENV }];

const e = (key: string, value: string, over: Partial<Entry> = {}): Entry => ({ scope: "environment", scopeId: ENV, key, value, secret: false, target: "both", ...over });
const c = (key: string, op: ResolvedChange["op"], over: Partial<ResolvedChange> = {}): ResolvedChange => ({ scope: "environment", scopeId: ENV, environment: "prod", key, op, ...over });

describe("plan", () => {
  it("adds with secret and both as safe defaults", () => {
    const p = plan(toSet([]), [c("API_KEY", "add", { value: "k" })]);
    expect([...p.next.values()]).toEqual([e("API_KEY", "k", { secret: true })]);
    expect(p.records).toEqual([{ environment: "prod", key: "API_KEY", op: "add", secret: true, target: "both" }]);
    expect(p.touchesSecret).toBe(true);
  });

  it("refuses adding an existing key, changing or removing a missing one, and duplicates", () => {
    const cur = toSet([e("A", "1")]);
    expect(() => plan(cur, [c("A", "add", { value: "2" })])).toThrow(EnvPlanError);
    expect(() => plan(cur, [c("B", "change", { value: "2" })])).toThrow(/not set/);
    expect(() => plan(cur, [c("B", "remove")])).toThrow(/not set/);
    expect(() => plan(cur, [c("A", "remove"), c("A", "remove")])).toThrow(/twice/);
    expect(() => plan(cur, [c("C", "add")])).toThrow(/needs a value/);
  });

  it("refuses a plan that changes nothing", () => {
    expect(() => plan(toSet([e("A", "1")]), [c("A", "change", { value: "1" })])).toThrow(/match/);
  });

  it("refuses to change a value that would not unseal", () => {
    const cur = toSet([{ ...e("A", "x"), value: null }]);
    expect(() => plan(cur, [c("A", "change", { value: "y" })])).toThrow(/unsealed/);
    expect(plan(cur, [c("A", "remove")]).next.size).toBe(0);
  });

  it("plain values need no step-up, any secret does, and so does unmasking one", () => {
    expect(plan(toSet([e("A", "1")]), [c("A", "change", { value: "2" })]).touchesSecret).toBe(false);
    expect(plan(toSet([e("S", "1", { secret: true })]), [c("S", "change", { secret: false })]).touchesSecret).toBe(true);
    expect(plan(toSet([e("S", "1", { secret: true })]), [c("S", "remove")]).touchesSecret).toBe(true);
  });

  it("an app override over an environment secret counts as touching it", () => {
    const cur = toSet([e("STRIPE_KEY", "sk", { secret: true })]);
    const override = c("STRIPE_KEY", "add", { scope: "app", scopeId: APP, appId: APP, value: "attacker", secret: false });
    expect(plan(cur, [override], new Map([[APP, ENV]])).touchesSecret).toBe(true);
    expect(plan(cur, [override], new Map([[APP, "env-dev"]])).touchesSecret).toBe(false);
    // Unknown environment: conservative.
    expect(plan(cur, [override]).touchesSecret).toBe(true);
  });
});

describe("resolution and reach", () => {
  it("app beats environment, and the phase filter applies after precedence", () => {
    const set = toSet([e("URL", "env"), e("URL", "app", { scope: "app", scopeId: APP, target: "runtime" })]);
    expect(resolveFor(set, apps[0]!, "runtime").get("URL")?.value).toBe("app");
    expect(resolveFor(set, apps[0]!, "build").has("URL")).toBe(false);
    expect(resolveFor(set, apps[1]!, "build").get("URL")?.value).toBe("env");
  });

  it("reaches only apps whose effective env changed, and rebuilds only on build values", () => {
    const before = toSet([e("A", "1", { target: "runtime" }), e("A", "o", { scope: "app", scopeId: APP })]);
    const after = toSet([e("A", "2", { target: "runtime" }), e("A", "o", { scope: "app", scopeId: APP })]);
    expect(affectedApps(before, after, apps)).toEqual([{ appId: OTHER, rebuild: false }]);
    const build = toSet([e("A", "1", { target: "build" }), e("A", "o", { scope: "app", scopeId: APP })]);
    expect(affectedApps(before, build, apps)).toEqual([{ appId: OTHER, rebuild: true }]);
  });
});

describe("snapshots and rollback", () => {
  it("round trips and drops unreadable values", () => {
    const set = toSet([e("A", "1"), { ...e("B", "x"), value: null }, e("C", "3", { scope: "app", scopeId: APP, secret: true, target: "build" })]);
    const back = parseSnapshot(serializeSnapshot(set));
    expect([...back.values()].map((x) => x.key).sort()).toEqual(["A", "C"]);
    expect(back.get(`app:${APP}:C`)).toEqual(e("C", "3", { scope: "app", scopeId: APP, secret: true, target: "build" }));
  });

  it("refuses a malformed snapshot", () => {
    expect(() => parseSnapshot(JSON.stringify({ v: 2, entries: [] }))).toThrow();
  });

  it("diff then plan reproduces the target exactly", () => {
    const from = toSet([e("A", "1"), e("B", "2", { secret: true }), e("D", "4")]);
    const to = toSet([e("A", "9"), e("B", "2", { secret: false }), e("C", "3", { target: "build" })]);
    const label = () => ({ environment: "prod" });
    const p = plan(from, diff(from, to, label));
    expect([...p.next.entries()].sort()).toEqual([...to.entries()].sort());
  });

  it("restricts to environments and apps that still exist", () => {
    const set = toSet([e("A", "1"), e("B", "2", { scope: "app", scopeId: "gone" })]);
    expect([...restrictTo(set, new Set([ENV]), new Set([APP])).keys()]).toEqual([`environment:${ENV}:A`]);
  });
});

describe("listing never carries a secret value", () => {
  it("does not unseal a secret for a listing, only plain values", async () => {
    const { listedValue, unsealForListing } = await import("./env-model.ts");
    expect(unsealForListing(true)).toBe(false);
    expect(unsealForListing(false)).toBe(true);
    expect(listedValue({ secret: true, value: "postgres://u:p@db/x" })).toBeNull();
    expect(listedValue({ secret: false, value: "info" })).toBe("info");
  });
});

describe("env references", () => {
  const DB = "11111111-1111-4111-8111-111111111111";
  const CACHE = "22222222-2222-4222-8222-222222222222";
  const FOREIGN = "33333333-3333-4333-8333-333333333333";
  const services: RefService[] = [
    { id: DB, name: "postgres", kind: "postgres", environmentId: ENV },
    { id: CACHE, name: "cache", kind: "redis", environmentId: ENV },
  ];
  const target = async (svc: RefService) => ({
    kind: svc.kind, host: svc.name, port: svc.kind === "postgres" ? 5432 : 6379, user: "dockify", password: "p@ss", database: "horseai",
  });

  it("stores a link to a service in the same project", () => {
    expect(refValueFor({ resourceId: DB, field: "url" }, services)).toBe(projects.encodeEnvRef({ resourceId: DB, field: "url" }));
  });

  it("refuses a link to a service in another project, or a field the kind does not offer", () => {
    expect(() => refValueFor({ resourceId: FOREIGN, field: "url" }, services)).toThrow(/own project/);
    expect(() => refValueFor({ resourceId: CACHE, field: "bucket" }, services)).toThrow(EnvPlanError);
    expect(servicesOf([{ id: APP, name: "web", kind: "frontend", environmentId: ENV }])).toEqual([]);
  });

  it("resolves a link to the service's current credential and passes plain values through", async () => {
    const url = await resolveValue(projects.encodeEnvRef({ resourceId: DB, field: "url" }), services, target);
    expect(url).toBe("postgresql://dockify:p%40ss@postgres:5432/horseai");
    expect(await resolveValue(projects.encodeEnvRef({ resourceId: CACHE, field: "password" }), services, target)).toBe("p@ss");
    expect(await resolveValue("plain", services, target)).toBe("plain");
  });

  it("never resolves a stored link that names another project's service", async () => {
    const stored = projects.encodeEnvRef({ resourceId: FOREIGN, field: "url" });
    await expect(resolveValue(stored, services, target)).rejects.toThrow(/own project/);
  });

  it("counts a link as touching a secret, and lists it without a value", () => {
    const value = projects.encodeEnvRef({ resourceId: DB, field: "url" });
    const p = plan(toSet([]), [c("DATABASE_URL", "add", { value, secret: false })]);
    expect(p.touchesSecret).toBe(true);
    const unlink = plan(p.next, [c("DATABASE_URL", "change", { value: "postgres://x", secret: true })]);
    expect(unlink.touchesSecret).toBe(true);
    expect(listedValue({ secret: false, value })).toBeNull();
  });

  it("marks a link whose service was deleted as missing", () => {
    const value = projects.encodeEnvRef({ resourceId: FOREIGN, field: "url" });
    expect(refView(value, services, () => "production")).toMatchObject({ missing: true, kind: null });
    expect(refView(projects.encodeEnvRef({ resourceId: DB, field: "url" }), services, () => "production")).toEqual({
      resourceId: DB, resourceName: "postgres", kind: "postgres", environment: "production", field: "url",
    });
    expect(refView("plain", services, () => "")).toBeUndefined();
  });

  it("refuses a typed value that imitates a reference", () => {
    expect(projects.EnvChange.safeParse({ environment: "prod", key: "A", op: "add", value: projects.encodeEnvRef({ resourceId: DB, field: "url" }) }).success).toBe(false);
    expect(projects.EnvChange.safeParse({ environment: "prod", key: "A", op: "add", value: "x", ref: { resourceId: DB, field: "url" } }).success).toBe(false);
    expect(projects.EnvChange.safeParse({ environment: "prod", key: "A", op: "add", ref: { resourceId: DB, field: "url" } }).success).toBe(true);
  });
});
