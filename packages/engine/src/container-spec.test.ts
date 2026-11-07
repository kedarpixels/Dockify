import { describe, expect, it } from "vitest";
import { assertSafeSpec, BASE_CAPABILITIES, containerSpec, ContainerPolicyError, type ContainerInput } from "./container-spec.ts";

const base: ContainerInput = { name: "dk-app-web", image: "ghcr.io/acme/web:1.4.2", network: "dockify-env-acme" };

/** Every caller the worker will have: a plain app, a managed database, a WARP-style egress proxy. */
const callers: Record<string, ContainerInput> = {
  app: { ...base, port: 3000, env: { NODE_ENV: "production" } },
  postgres: {
    ...base,
    name: "dk-db",
    image: `postgres@sha256:${"a".repeat(64)}`,
    volumes: [{ name: "dk-db-data", mountPath: "/var/lib/postgresql/data" }],
    memoryMb: 1024,
  },
  egress: { ...base, name: "dk-warp", capAdd: ["NET_ADMIN"], sysctls: { "net.ipv4.conf.all.src_valid_mark": "1" } },
  release: { ...base, name: "dk-release-1", cmd: ["npx", "prisma", "migrate", "deploy"], restart: "no", readOnlyRootfs: true },
};

describe("containerSpec invariants hold for every caller", () => {
  for (const [label, input] of Object.entries(callers)) {
    it(label, () => {
      const spec = containerSpec(input, 8);
      const hc = spec.HostConfig;
      expect(hc.CapDrop).toEqual(["ALL"]);
      expect(hc.SecurityOpt).toContain("no-new-privileges:true");
      expect(hc.Privileged).toBe(false);
      expect(hc.Memory).toBeGreaterThan(0);
      expect(hc.MemorySwap).toBe(hc.Memory);
      expect(hc.PidsLimit).toBeGreaterThan(0);
      expect(hc.LogConfig.Config["max-size"]).toBeTruthy();
      expect(hc.NetworkMode).toMatch(/^dockify[-_]/);
      expect(hc.PortBindings).toEqual({});
      expect(hc.PublishAllPorts).toBe(false);
      expect(hc.Mounts.every((m) => m.Type === "volume")).toBe(true);
      for (const cap of hc.CapAdd) expect([...BASE_CAPABILITIES, "NET_ADMIN", "NET_RAW"]).toContain(cap);
      expect(Object.keys(hc)).not.toEqual(expect.arrayContaining(["Binds", "Devices", "PidMode", "UsernsMode"]));
      expect(spec.Labels["dockify.managed"]).toBe("true");
      expect(() => assertSafeSpec(spec)).not.toThrow();
    });
  }

  it("never hands back SYS_ADMIN or the other dangerous capabilities", () => {
    for (const cap of ["SYS_ADMIN", "SYS_PTRACE", "SYS_MODULE", "DAC_READ_SEARCH", "NET_RAW", "MKNOD", "SYS_CHROOT"]) {
      expect(BASE_CAPABILITIES as readonly string[]).not.toContain(cap);
    }
  });
});

describe("containerSpec refuses", () => {
  const refuses = (over: Partial<ContainerInput>) => expect(() => containerSpec({ ...base, ...over }, 8)).toThrow(ContainerPolicyError);

  it("capabilities off the allowlist", () => {
    for (const cap of ["SYS_ADMIN", "ALL", "SYS_PTRACE", "CAP_SYS_ADMIN", "net_admin"]) refuses({ capAdd: [cap] });
  });
  it("sysctls off the allowlist", () => {
    refuses({ sysctls: { "kernel.core_pattern": "|/bin/sh" } });
    refuses({ sysctls: { "net.core.somaxconn": "1024" } });
    refuses({ sysctls: { "net.ipv4.ip_forward": "1; rm -rf /" } });
  });
  it("host and shared namespaces", () => {
    refuses({ network: "host" });
    refuses({ network: "bridge" });
    refuses({ network: "container:abc" });
  });
  it("host paths in any form", () => {
    refuses({ volumes: [{ name: "/etc", mountPath: "/data" }] });
    refuses({ volumes: [{ name: "../x", mountPath: "/data" }] });
    refuses({ volumes: [{ name: "dk-ok", mountPath: "/" }] });
    refuses({ volumes: [{ name: "dk-ok", mountPath: "/proc/self" }] });
    refuses({ volumes: [{ name: "dk-ok", mountPath: "/data/../etc" }] });
    refuses({ volumes: [{ name: "dk-ok", mountPath: "relative" }] });
  });
  it("limits out of range and bad identifiers", () => {
    refuses({ memoryMb: 0 });
    refuses({ memoryMb: 10_000_000 });
    refuses({ pidsLimit: -1 });
    refuses({ cpuCores: 1000 });
    refuses({ name: "Bad Name" });
    refuses({ image: "UPPER/case" });
    refuses({ env: { "BAD-KEY": "x" } });
    refuses({ env: { OK: "a\0b" } });
    refuses({ user: "root; id" });
  });
});

describe("assertSafeSpec catches a hand-built or tampered body", () => {
  const good = () => containerSpec(callers.app!, 8) as unknown as { HostConfig: Record<string, unknown> };
  const tampered: Array<[string, (s: { HostConfig: Record<string, unknown> }) => void]> = [
    ["privileged", (s) => { s.HostConfig.Privileged = true; }],
    ["CapDrop removed", (s) => { s.HostConfig.CapDrop = []; }],
    ["SYS_ADMIN added", (s) => { (s.HostConfig.CapAdd as string[]).push("SYS_ADMIN"); }],
    ["host network", (s) => { s.HostConfig.NetworkMode = "host"; }],
    ["host pid", (s) => { s.HostConfig.PidMode = "host"; }],
    ["host ipc", (s) => { s.HostConfig.IpcMode = "host"; }],
    ["host userns", (s) => { s.HostConfig.UsernsMode = "host"; }],
    ["bind mount via Binds", (s) => { s.HostConfig.Binds = ["/:/host"]; }],
    ["bind mount via Mounts", (s) => { s.HostConfig.Mounts = [{ Type: "bind", Source: "/", Target: "/host" }]; }],
    ["docker socket", (s) => { s.HostConfig.Mounts = [{ Type: "volume", Source: "/var/run/docker.sock", Target: "/s" }]; }],
    ["devices", (s) => { s.HostConfig.Devices = [{ PathOnHost: "/dev/sda" }]; }],
    ["gpu requests", (s) => { s.HostConfig.DeviceRequests = [{ Count: -1 }]; }],
    ["host port", (s) => { s.HostConfig.PortBindings = { "22/tcp": [{ HostPort: "22" }] }; }],
    ["publish all", (s) => { s.HostConfig.PublishAllPorts = true; }],
    ["seccomp off", (s) => { (s.HostConfig.SecurityOpt as string[]).push("seccomp=unconfined"); }],
    ["no-new-privileges off", (s) => { s.HostConfig.SecurityOpt = []; }],
    ["a seccomp profile as JSON", (s) => { (s.HostConfig.SecurityOpt as string[]).push('seccomp={"defaultAction":"SCMP_ACT_ALLOW"}'); }],
    ["an apparmor profile", (s) => { (s.HostConfig.SecurityOpt as string[]).push("apparmor=some-profile"); }],
    ["no-new-privileges in another spelling", (s) => { s.HostConfig.SecurityOpt = ["no-new-privileges"]; }],
    ["the control network", (s) => { s.HostConfig.NetworkMode = "dockify_control"; }],
    ["the database network", (s) => { s.HostConfig.NetworkMode = "dockify_data"; }],
    ["the socket proxy's network", (s) => { s.HostConfig.NetworkMode = "dockify_docker-api"; }],
    ["the deploy network", (s) => { s.HostConfig.NetworkMode = "dockify-deploy"; }],
    ["the control plane's database volume", (s) => { s.HostConfig.Mounts = [{ Type: "volume", Source: "dockify_dockify-db", Target: "/d", ReadOnly: true }]; }],
    ["the backups volume", (s) => { s.HostConfig.Mounts = [{ Type: "volume", Source: "dockify_dockify-backups", Target: "/d", ReadOnly: true }]; }],
    ["a bare volume name", (s) => { s.HostConfig.Mounts = [{ Type: "volume", Source: "dockify-db", Target: "/d", ReadOnly: true }]; }],
    ["no memory cap", (s) => { s.HostConfig.Memory = 0; }],
    ["unlimited swap", (s) => { s.HostConfig.MemorySwap = -1; }],
    ["no pids cap", (s) => { s.HostConfig.PidsLimit = 0; }],
    ["host-gateway", (s) => { s.HostConfig.ExtraHosts = ["host.docker.internal:host-gateway"]; }],
    ["kernel sysctl", (s) => { s.HostConfig.Sysctls = { "kernel.shm_rmid_forced": "1" }; }],
    ["custom runtime", (s) => { s.HostConfig.Runtime = "runc-unsafe"; }],
    ["no log cap", (s) => { s.HostConfig.LogConfig = { Type: "json-file", Config: {} }; }],
  ];
  for (const [label, mutate] of tampered) {
    it(label, () => {
      const s = good();
      mutate(s);
      expect(() => assertSafeSpec(s)).toThrow(ContainerPolicyError);
    });
  }
});
