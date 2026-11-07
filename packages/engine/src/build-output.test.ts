/**
 * Regression for the build output format. buildctl must export an OCI archive
 * (`--output type=oci,...`): Docker 28+'s containerd image store rejects the legacy docker-archive
 * ("type=docker") with "unrecognized image format", which silently broke every build and loadImage.
 * buildkit-sandbox.test.ts and units.test.ts cover planBuild's build-args and secrets but assert
 * nothing about the output type, the frontend, or the managed/app labels, so this pins those.
 */
import { describe, expect, it } from "vitest";
import { imageNameFor, planBuild } from "./build.ts";

const plan = (appId = "app-x", deploymentId = "1234567890ab") =>
  planBuild({
    buildkitAddr: "tcp://buildkit:1234",
    contextDir: "/b/repo",
    dockerfileDir: "/b/repo",
    dockerfileName: "Dockerfile",
    imageName: imageNameFor(appId, deploymentId),
    appId,
    deploymentId,
    vars: [],
  });

/** The value buildctl receives for a given flag (flags and values are separate argv entries). */
const flagValue = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

describe("buildctl output format", () => {
  it("exports an OCI archive named after the pinned image, never a legacy docker-archive", () => {
    const p = plan("app-x", "1234567890ab");
    expect(flagValue(p.args, "--output")).toBe(`type=oci,name=${imageNameFor("app-x", "1234567890ab")}`);
    const joined = p.args.join(" ");
    expect(joined).not.toContain("type=docker");
    expect(joined).not.toContain("docker-archive");
  });

  it("drives the official dockerfile frontend", () => {
    expect(flagValue(plan().args, "--frontend")).toBe("dockerfile.v0");
    expect(flagValue(plan().args, "--progress")).toBe("plain");
  });

  it("stamps the managed and app labels so the janitor and reaper can find the image", () => {
    const p = plan("app-7", "deadbeefcafe");
    expect(p.args).toContain("label:dockify.managed=true");
    expect(p.args).toContain("label:dockify.app=app-7");
  });
});

describe("imageNameFor", () => {
  it("tags dockify/app-<appId> with the first eight chars of the deployment id", () => {
    expect(imageNameFor("abc", "1234567890abcdef")).toBe("dockify/app-abc:12345678");
    // Short ids are taken whole; the tag never exceeds eight chars.
    expect(imageNameFor("abc", "1234")).toBe("dockify/app-abc:1234");
  });
});
