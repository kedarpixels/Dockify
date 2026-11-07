import { describe, expect, it } from "vitest";
import { z } from "zod";
import { endpointIds, endpoints, removedEndpoints, type EndpointDef } from "./endpoints.ts";
import { isAllowedSysctl, Sysctls, Capability } from "./common.ts";
import { AppSpec } from "./projects.ts";

const all = endpointIds.map((id) => [id, endpoints[id] as EndpointDef] as const);

describe("endpoint catalog", () => {
  it("has a unique method and path per endpoint", () => {
    const seen = new Set<string>();
    for (const [, d] of all) {
      const key = `${d.method} ${d.path}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it("keeps every route under /api/v1", () => {
    for (const [id, d] of all) expect(d.path.startsWith("/api/v1/"), id).toBe(true);
  });

  it("declares a params schema whose keys match the path parameters exactly", () => {
    for (const [id, d] of all) {
      const names = [...d.path.matchAll(/:(\w+)/g)].map((m) => m[1]).sort();
      if (names.length === 0) {
        expect(d.params, id).toBeUndefined();
        continue;
      }
      expect(d.params, id).toBeDefined();
      const shape = (d.params as z.ZodObject).shape;
      expect(Object.keys(shape).sort(), id).toEqual(names);
    }
  });

  it("never takes a body on GET", () => {
    for (const [id, d] of all) if (d.method === "GET") expect(d.body, id).toBeUndefined();
  });

  it("gives every json endpoint a response schema", () => {
    for (const [id, d] of all) if ((d.kind ?? "json") === "json") expect(d.response, id).toBeDefined();
  });
});

describe("removed endpoints", () => {
  it("keeps every removed endpoint out of the catalog, by id and by route", () => {
    const routes = new Set(all.map(([, d]) => `${d.method} ${d.path}`));
    for (const r of removedEndpoints) {
      expect(endpointIds as readonly string[], r.id).not.toContain(r.id);
      expect(routes.has(`${r.method} ${r.path}`), r.id).toBe(false);
    }
  });

  it("has no resource route that hands out connection details", () => {
    for (const [id, d] of all) expect(/\/resources\/.*connection/.test(d.path), id).toBe(false);
  });
});

describe("privilege allowlist", () => {
  it("accepts only the two allowlisted capabilities", () => {
    expect(Capability.safeParse("NET_ADMIN").success).toBe(true);
    for (const bad of ["SYS_ADMIN", "ALL", "net_admin", "SYS_PTRACE"]) expect(Capability.safeParse(bad).success).toBe(false);
  });

  it("accepts only net.ipv4.* and net.ipv6.conf.* sysctls", () => {
    expect(isAllowedSysctl("net.ipv4.conf.all.src_valid_mark")).toBe(true);
    expect(isAllowedSysctl("net.ipv6.conf.all.disable_ipv6")).toBe(true);
    for (const bad of ["kernel.core_pattern", "net.core.somaxconn", "net.ipv6.route.flush", "vm.overcommit_memory", "net.ipv4."]) {
      expect(isAllowedSysctl(bad), bad).toBe(false);
    }
    expect(Sysctls.safeParse({ "kernel.core_pattern": "|/tmp/x" }).success).toBe(false);
  });

  it("has no field for privileged mode, host ports or bind mounts in an app spec", () => {
    const base = { name: "web", kind: "backend", target: "server", source: { type: "image", image: "nginx:1.27", registryId: null } };
    expect(AppSpec.safeParse(base).success).toBe(true);
    for (const extra of [{ privileged: true }, { ports: [{ host: 80 }] }, { binds: ["/:/host"] }, { capAdd: ["SYS_ADMIN"] }]) {
      expect(AppSpec.safeParse({ ...base, ...extra }).success).toBe(false);
    }
  });
});
