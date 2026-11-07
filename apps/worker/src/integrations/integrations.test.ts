import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NOTIFY_EVENTS } from "@dockify/notify";
import { imageRegistryHost, registryAuthFor, serverAddress, xRegistryAuth } from "./registry-auth.ts";
import { envPayload, mapState, vercelTargetFor } from "./vercel-target.ts";

describe("vercel target", () => {
  it("maps states and targets", () => {
    expect(mapState("READY")).toBe("ready");
    expect(mapState("CANCELED")).toBe("error");
    expect(mapState("BUILDING")).toBe("building");
    expect(vercelTargetFor("production")).toBe("production");
    expect(vercelTargetFor("dev")).toBe("preview");
  });
  it("sends every value encrypted and skips Vercel's own keys", () => {
    expect(envPayload({ A: "1", VERCEL_ENV: "x", "bad-key": "y" }, "preview")).toEqual([{ key: "A", value: "1", type: "encrypted", target: ["preview"] }]);
  });
});

describe("registry auth", () => {
  it("finds the registry an image pulls from", () => {
    expect(imageRegistryHost("nginx:1.27")).toBe("docker.io");
    expect(imageRegistryHost("acme/api:1")).toBe("docker.io");
    expect(imageRegistryHost("ghcr.io/acme/api:1")).toBe("ghcr.io");
    expect(imageRegistryHost("reg.example.com:5000/x")).toBe("reg.example.com:5000");
    expect(serverAddress("docker.io")).toBe("https://index.docker.io/v1/");
  });
  it("never sends credentials to another registry", async () => {
    const db = { integration: { findFirst: async () => ({ id: "r", secretId: "s", config: { host: "ghcr.io", username: "me" } }) } };
    await expect(registryAuthFor(db as never, {} as never, "r", "docker.io/library/nginx")).rejects.toThrow(/not on ghcr.io/);
    expect(await registryAuthFor(db as never, {} as never, null, "nginx")).toBeNull();
  });
  it("encodes X-Registry-Auth", () => {
    const a = { username: "u", password: "p", serveraddress: "ghcr.io" };
    expect(JSON.parse(Buffer.from(xRegistryAuth(a), "base64url").toString())).toEqual(a);
  });
});

describe("event notices", () => {
  it("sends each event under a webhook name the message check accepts", () => {
    const src = readFileSync(new URL("./events.ts", import.meta.url), "utf8");
    const names = [...src.matchAll(/webhook: "([a-z_.]+)"/g)].map((m) => m[1]!);
    expect(names).toContain("job.failed");
    for (const name of names) expect(NOTIFY_EVENTS as readonly string[], name).toContain(name);
  });
});
