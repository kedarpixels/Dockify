/** An image app's registry login reaches its pull. Found on the box: a login was stored and never sent. */
import { PermanentDeployError } from "@dockify/engine";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@dockify/db", async (original) => ({ ...(await original<object>()), readSecretValue: async () => "the-token" }));
const { pullAuth } = await import("./pull.ts");

const db = (row: unknown) => ({ integration: { findFirst: async () => row } }) as never;
const row = { id: "r", secretId: "s", config: { host: "reg.example.com", username: "me" } };

describe("pullAuth", () => {
  it("is null for a public image", async () => {
    expect(await pullAuth(db(null), {} as never, null, "nginx:1")).toBeNull();
  });
  it("is the header Docker reads, with the login for that image's registry", async () => {
    const out = await pullAuth(db(row), {} as never, "r", "reg.example.com/a/b:1");
    expect(JSON.parse(Buffer.from(out as string, "base64url").toString())).toEqual({ username: "me", password: "the-token", serveraddress: "reg.example.com" });
  });
  it("fails the deploy with its reason when the login cannot apply, and never retries that", async () => {
    await expect(pullAuth(db(row), {} as never, "r", "other.example.com/a/b:1")).rejects.toBeInstanceOf(PermanentDeployError);
    await expect(pullAuth(db(null), {} as never, "r", "reg.example.com/a/b:1")).rejects.toThrow(/removed/);
  });
  it("is what the pipeline hands an image app's pull", () => {
    const src = readFileSync(new URL("./pipeline.ts", import.meta.url), "utf8");
    expect(src).toContain("pullAuth(db, vault, app.registryId, app.image)");
    expect(src).not.toMatch(/pullImage\(docker, [^,]+, null,/);
  });
});
