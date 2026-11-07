import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GateRefusal, ruleFor } from "./docker-gate.ts";
import { CONTROL_SUBNETS, refusedHost, refusedPull, registryHost } from "./registry-host.ts";

const pull = (ref: string) => `/v1.43/images/create?fromImage=${new URLSearchParams({ x: ref }).toString().slice(2)}`;

/** Every internal spelling, and the shape around it a real reference has. */
const REFUSED = [
  // loopback
  "127.0.0.1:5000/x", "127.0.0.1/x", "127.1.2.3:8000/a/b:1", "localhost:5000/x", "localhost/x", "LOCALHOST:5000/x", "Localhost/x", "localhost.:5000/x",
  "foo.localhost:5000/x", "a.b.localhost/x", "localhost.localdomain:5000/x", "ip6-localhost:5000/x", "ip6-loopback:5000/x",
  // this host
  "0.0.0.0:5000/x", "0.1.2.3/x",
  // other spellings of an address
  "127.1:5000/x", "127.0.1:5000/x", "2130706433:5000/x", "0x7f000001:5000/x", "0x7f.0.0.1:5000/x", "0177.0.0.1:5000/x", "127.0.0.01:5000/x", "017700000001:5000/x", "0:5000/x", "256.0.0.1:5000/x", "1.2.3.4.5:5000/x",
  "169.254.0x1.1/x", "0xA9.0xFE.0xA9.0xFE/x",
  // link-local and metadata
  "169.254.169.254/latest", "169.254.169.254:80/x", "169.254.0.1:5000/x", "100.100.100.200/x", "168.63.129.16/x", "metadata.google.internal/x", "METADATA.GOOGLE.INTERNAL/x", "metadata.goog/x", "metadata:80/x", "instance-data:80/x", "instance-data.ec2.internal/x",
  // Docker's own names for the host
  "host.docker.internal:5000/x", "gateway.docker.internal/x",
  // the control networks
  "172.30.1.10:3001/x", "172.30.2.10:3001/x", "172.30.3.2:5432/x", "172.30.4.2:2375/x", "172.30.5.30:443/x",
];

/** What people really pull, LAN registries included. */
const ALLOWED = [
  "nginx", "nginx:1.27", "library/nginx:1.27", "acme/web:1", `postgres:16-alpine@sha256:${"a".repeat(64)}`,
  "ghcr.io/acme/web:1", "registry.gitlab.com/a/b/c:2", "docker.io/library/nginx", "public.ecr.aws/nginx/nginx",
  "192.168.1.5:5000/x", "10.0.0.7:5000/a/b:1", "172.16.0.5:5000/x", "172.31.0.5/x", "172.30.0.5:5000/x", "172.30.6.5:5000/x", "100.64.0.1:5000/x", "8.8.8.8:5000/x",
  "registry.lan:5000/x", "registry.local/x", "registry.corp.internal:5000/x", "127.example.com/x", "localhost.example.com/x", "metadata.example.com/x", "x.0.example.com/x",
  // Not hosts at all: Docker reads each of these as an image on Docker Hub.
  "metadata/x", "instance-data/x", "ip6-localhost/x", "1234/app", "localhost", "127.0.0.1:8000", "localhostess/x",
];

describe("registry hosts a pull may not name", () => {
  it.each(REFUSED)("refuses %s", (ref) => {
    expect(refusedPull(ref)).not.toBeNull();
    expect(() => ruleFor("POST", pull(ref))).toThrow(GateRefusal);
  });
  it.each(ALLOWED)("allows %s", (ref) => {
    expect(refusedPull(ref)).toBeNull();
    expect(() => ruleFor("POST", pull(ref))).not.toThrow();
  });

  it("says in the refusal what it refused, not just that it did", () => {
    expect(refusedPull("172.30.3.2:5432/x")).toBe("Dockify does not pull from 172.30.3.2: a control network");
    expect(refusedPull("169.254.169.254/x")).toBe("Dockify does not pull from 169.254.169.254: link-local and cloud metadata");
    expect(refusedPull("localhost:5000/x")).toBe("Dockify does not pull from localhost: this host or its metadata service");
    expect(refusedPull("2130706433:5000/x")).toContain("an address not written as four plain numbers");
  });

  it("refuses an IPv6 literal by form: the gate's query takes no bracket", () => {
    for (const ref of ["[::1]:5000/x", "[fd00:ec2::254]/x", "[::ffff:127.0.0.1]:5000/x", "[fe80::1]:5000/x"]) {
      expect(() => ruleFor("POST", pull(ref)), ref).toThrow(GateRefusal);
    }
  });

  it("refuses what would otherwise slip past a parser: a user part in the host", () => {
    expect(refusedPull("user@127.0.0.1:5000/x")).not.toBeNull();
    expect(() => ruleFor("POST", "/v1.43/images/create?fromImage=user%40127.0.0.1%3A5000%2Fx")).toThrow(GateRefusal);
  });

  it("checks the reference only, and leaves the tag's form to the rule", () => {
    expect(() => ruleFor("POST", "/v1.43/images/create?fromImage=ghcr.io%2Fa%2Fb&tag=127.0.0.1")).not.toThrow();
    expect(() => ruleFor("POST", "/v1.43/images/create?fromImage=127.0.0.1%3A5000%2Fb&tag=1")).toThrow(GateRefusal);
  });

  it("does not trust an encoding the rule did not pass: lower case and a double encoding are refused before this", () => {
    for (const q of ["127.0.0.1%3a5000%2fx", "127.0.0.1%253A5000%252Fx", "127%2E0%2E0%2E1%3A5000%2Fx"]) {
      expect(() => ruleFor("POST", `/v1.43/images/create?fromImage=${q}`), q).toThrow(GateRefusal);
    }
  });

  it("reads a reference's registry the way Docker does", () => {
    expect(registryHost("nginx")).toBeNull();
    expect(registryHost("acme/web")).toBeNull();
    expect(registryHost("localhost/web")).toBe("localhost");
    expect(registryHost("LocalHost/web")).toBe("LocalHost");
    expect(registryHost("Upper/web")).toBe("Upper");
    expect(registryHost("a.b/web")).toBe("a.b");
    expect(registryHost("a:1/web")).toBe("a");
  });

  it("treats a trailing dot as no dot", () => {
    expect(refusedHost("localhost.")).not.toBeNull();
    expect(refusedHost("127.0.0.1.")).not.toBeNull();
    expect(refusedHost("metadata.google.internal.")).not.toBeNull();
  });

  it("covers every fixed subnet in the compose file", () => {
    const compose = readFileSync(new URL("../../../deploy/docker-compose.yml", import.meta.url), "utf8");
    const subnets = [...compose.matchAll(/subnet: (\d+\.\d+\.\d+)\.0\/24/g)].map((m) => `${m[1]}.0`);
    expect(subnets.length).toBeGreaterThanOrEqual(5);
    expect([...subnets].sort()).toEqual([...CONTROL_SUBNETS].sort());
    for (const s of subnets) expect(refusedHost(s.replace(/\.0$/, ".9")), s).toContain("control network");
  });
});
