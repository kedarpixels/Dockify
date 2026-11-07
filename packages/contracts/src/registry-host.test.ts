import { describe, expect, it } from "vitest";
import { refusedHost, refusedPull, registryHost } from "./registry-host.ts";

/** The rule's own cases live with the gate (apps/agent/src/registry-host.test.ts), which reads this copy. */
describe("the registry rule", () => {
  it("takes every RFC 1918 range, a LAN name and any port", () => {
    for (const ref of ["10.0.0.7:5000/x", "172.16.0.1:5000/x", "172.31.255.1/x", "192.168.1.5:5000/a/b:1", "registry.lan:5000/x", "registry:5000/x", "ghcr.io/o/r:1", "reg.example.com:8443/x"]) {
      expect(refusedPull(ref), ref).toBeNull();
    }
  });

  it("refuses an IPv6 literal, with or without a port", () => {
    expect(refusedPull("[::1]:5000/x")).toContain("does not pull");
    expect(refusedPull("[fd00:ec2::254]/x")).toContain("does not pull");
    expect(refusedHost("::1")).toBe("an IPv6 address");
  });

  it("reads Docker Hub as no registry at all", () => {
    for (const ref of ["nginx:1.27", "library/nginx", "metadata/x", "1234/app", "127.0.0.1:8000"]) {
      expect(registryHost(ref), ref).toBeNull();
      expect(refusedPull(ref), ref).toBeNull();
    }
  });
});
