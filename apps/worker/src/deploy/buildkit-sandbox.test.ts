import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { checkSyntaxDirective, planBuild } from "@dockify/engine";
import { PermanentDeployError } from "@dockify/engine";

/** The `buildkit:` service block of the production compose file, up to the next service. */
async function buildkitService(): Promise<string> {
  const compose = await readFile(new URL("../../../../deploy/docker-compose.yml", import.meta.url), "utf8");
  const m = /^ {2}buildkit:\n([\s\S]*?)(?=^ {2}\S|^\S)/m.exec(compose);
  expect(m, "deploy/docker-compose.yml has a buildkit service").not.toBeNull();
  return m?.[1] ?? "";
}

const plan = (appId: string, vars: Parameters<typeof planBuild>[0]["vars"] = []) =>
  planBuild({
    buildkitAddr: "tcp://buildkit:1234",
    contextDir: "/b/repo",
    dockerfileDir: "/b/repo",
    dockerfileName: "Dockerfile",
    imageName: `dockify/app-${appId}:12345678`,
    appId,
    deploymentId: "12345678",
    vars,
  });

describe("buildkit daemon sandbox", () => {
  it("never disables the process sandbox for tenant RUN steps", async () => {
    const svc = await buildkitService();
    const config = svc.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(config).not.toMatch(/no-process-sandbox/);
    expect(config).not.toMatch(/BUILDKITD_FLAGS/);
    expect(config).not.toMatch(/privileged:\s*true/);
    expect(config).not.toMatch(/cap_add/);
  });

  it("keeps the options rootless BuildKit needs to run its sandbox", async () => {
    const svc = await buildkitService();
    // AppArmor: unconfined, or the installer's dockify-buildkit profile (unconfined plus userns) where the
    // kernel restricts user namespaces (installer-apparmor.test.ts in the api).
    for (const opt of ["seccomp=unconfined", "apparmor=${DOCKIFY_BUILDKIT_APPARMOR:-unconfined}", "systempaths=unconfined"]) expect(svc).toContain(opt);
    expect(svc).toMatch(/image: moby\/buildkit:[^\s@]*-rootless@sha256:[a-f0-9]{64}/);
  });

  it("drives the daemon over a unix socket, never a tcp listener a tenant RUN step could reach", async () => {
    const svc = await buildkitService();
    const config = svc.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(config).toMatch(/--addr["\s,]+unix:\/\//);
    expect(config).not.toMatch(/tcp:\/\//);
    // The build network is gone; the worker reaches the daemon only over the shared socket volume.
    expect(config).not.toMatch(/networks:\s*\[\s*build/);
  });
});

describe("cross-tenant build cache", () => {
  it("namespaces RUN cache mounts by app", () => {
    expect(plan("a").args).toContain("build-arg:BUILDKIT_CACHE_MOUNT_NS=dockify-app-a");
    expect(plan("b").args).toContain("build-arg:BUILDKIT_CACHE_MOUNT_NS=dockify-app-b");
  });

  it("never lets a tenant variable set a BuildKit control arg", () => {
    const p = plan("a", [
      { key: "BUILDKIT_CACHE_MOUNT_NS", value: "dockify-app-b", isSecret: false, target: "build" },
      { key: "buildkit_syntax", value: "evil/frontend", isSecret: false, target: "both" },
      { key: "OK", value: "1", isSecret: false, target: "build" },
    ]);
    const buildArgs = p.args.filter((a) => a.startsWith("build-arg:"));
    expect(buildArgs).toEqual(["build-arg:BUILDKIT_CACHE_MOUNT_NS=dockify-app-a", "build-arg:OK=1"]);
    expect(p.buildArgKeys).toEqual(["OK"]);
  });
});

describe("dockerfile frontend directive", () => {
  it("allows the official frontend and plain Dockerfiles", () => {
    for (const df of [
      "FROM node:22\n",
      "# syntax=docker/dockerfile:1\nFROM node:22\n",
      "﻿#syntax=docker/dockerfile:1.9\nFROM node:22\n",
      "# escape=`\n# syntax = docker.io/docker/dockerfile:1@sha256:" + "a".repeat(64) + "\nFROM x\n",
      "FROM x\n# syntax=evil/frontend\n",
    ]) expect(() => checkSyntaxDirective(df), df).not.toThrow();
  });

  it("refuses any other frontend image", () => {
    for (const df of [
      "# syntax=evil/frontend:latest\nFROM node:22\n",
      "\r\n#   SYNTAX = ghcr.io/x/dockerfile:1\r\nFROM x\n",
      "# comment\n\n# syntax=docker/dockerfile-upstream:master\nFROM x\n",
      "// syntax=registry.example/docker/dockerfile:1\nFROM x\n",
      "# syntax=docker/dockerfile:1 extra\n# syntax=evil/x\nFROM x\n",
    ]) expect(() => checkSyntaxDirective(df), df).toThrow(PermanentDeployError);
  });
});
