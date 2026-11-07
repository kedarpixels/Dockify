import { describe, expect, it } from "vitest";
import type { DockerPort, ImageState } from "./docker-port.ts";
import { digestRef, ImageResolveError, pinFits, pinOf, repositoryOf, resolveServiceImage } from "./images.ts";

const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;

/** A daemon with a registry behind it: tags resolve to digests; Docker Hub images report their short name. */
function daemon(tags: Record<string, string>) {
  const images = new Map<string, ImageState>();
  const pulls: string[] = [];
  const docker = {
    inspectImage: async (ref: string) => images.get(ref) ?? null,
    pullImage: async (ref: string) => {
      pulls.push(ref);
      const digest = ref.includes("@") ? ref.split("@")[1]! : tags[ref];
      if (!digest) throw new Error(`Error response from daemon: manifest unknown: manifest unknown`);
      const repo = repositoryOf(ref).replace(/^docker\.io\/library\//, "");
      const img = { id: `sha256:${digest === A ? "1".repeat(64) : "2".repeat(64)}`, repoDigests: [`${repo}@${digest}`] };
      images.set(ref, img);
      images.set(`${repo}@${digest}`, img);
    },
  } as unknown as DockerPort;
  return { docker, pulls, images };
}

describe("service image pinning", () => {
  it("splits references", () => {
    expect(repositoryOf("postgres:16-alpine")).toBe("postgres");
    expect(repositoryOf("ghcr.io/acme/db:1.2@sha256:x")).toBe("ghcr.io/acme/db");
    expect(repositoryOf("registry.local:5000/team/redis")).toBe("registry.local:5000/team/redis");
    expect(pinOf("redis:7.4-alpine", A)).toBe(`redis:7.4-alpine@${A}`);
    expect(digestRef(`redis:7.4-alpine@${A}`)).toBe(`redis@${A}`);
    expect(pinFits(`redis:7.4-alpine@${A}`, "redis:7.4-alpine")).toBe(true);
    expect(pinFits(`redis:7.4-alpine@${A}`, "redis:8.2-alpine")).toBe(false);
    expect(pinFits(null, "redis:7.4-alpine")).toBe(false);
  });

  it("pulls the tag once and pins the digest the registry served", async () => {
    const d = daemon({ "postgres:16-alpine": A });
    const r = await resolveServiceImage(d.docker, "postgres:16-alpine", null, () => {});
    expect(r).toEqual({ imageId: `sha256:${"1".repeat(64)}`, pin: `postgres:16-alpine@${A}`, pulled: true });
    expect(d.pulls).toEqual(["postgres:16-alpine"]);
  });

  it("runs the pin while the digest is on the server, and pulls by digest (never the moved tag) when it is not", async () => {
    const d = daemon({ "postgres:16-alpine": B });
    d.images.set(`postgres@${A}`, { id: "sha256:" + "1".repeat(64), repoDigests: [`postgres@${A}`] });
    expect((await resolveServiceImage(d.docker, "postgres:16-alpine", `postgres:16-alpine@${A}`, () => {})).pulled).toBe(false);
    d.images.clear();
    const r = await resolveServiceImage(d.docker, "postgres:16-alpine", `postgres:16-alpine@${A}`, () => {});
    expect(d.pulls).toEqual([`postgres@${A}`]);
    expect(r.pin).toBe(`postgres:16-alpine@${A}`);
  });

  it("takes an owner's own digest reference as the pin", async () => {
    const d = daemon({});
    const r = await resolveServiceImage(d.docker, `postgres@${A}`, null, () => {});
    expect(r.pin).toBe(`postgres@${A}`);
    expect(d.pulls).toEqual([`postgres@${A}`]);
  });

  it("a tag the registry does not have fails permanently; a network failure does not", async () => {
    const d = daemon({});
    const e = await resolveServiceImage(d.docker, "redis:9.9-alpine", null, () => {}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ImageResolveError);
    expect((e as ImageResolveError).permanent).toBe(true);
    expect((e as Error).message).toMatch(/^Could not pull redis:9.9-alpine: .*manifest unknown/);
    const flaky = { inspectImage: async () => null, pullImage: async () => { throw new Error("connect ETIMEDOUT registry-1.docker.io"); } } as unknown as DockerPort;
    const t = await resolveServiceImage(flaky, "redis:7.4-alpine", null, () => {}).catch((x: unknown) => x);
    expect((t as ImageResolveError).permanent).toBe(false);
  });

  it("pins the exact tag already on this server without asking the registry (Docker Hub's limit on a redeploy)", async () => {
    const d = daemon({});
    d.images.set("postgres:17-alpine", { id: "sha256:" + "1".repeat(64), repoDigests: [`other/copy@${B}`, `postgres@${A}`] });
    const lines: string[] = [];
    const r = await resolveServiceImage(d.docker, "postgres:17-alpine", null, (l) => lines.push(l));
    expect(r).toEqual({ imageId: `sha256:${"1".repeat(64)}`, pin: `postgres:17-alpine@${A}`, pulled: false });
    expect(d.pulls).toEqual([]);
    expect(lines.join(" ")).toMatch(/already on this server/);
    // The pin then holds it: a later redeploy runs that digest, also without a pull.
    d.images.set(`postgres@${A}`, d.images.get("postgres:17-alpine")!);
    expect((await resolveServiceImage(d.docker, "postgres:17-alpine", r.pin, () => {})).pulled).toBe(false);
    expect(d.pulls).toEqual([]);
  });

  it("still pulls a tag that is here without a digest of its own repository", async () => {
    const d = daemon({ "redis:8.2-alpine": A });
    d.images.set("redis:8.2-alpine", { id: "sha256:" + "3".repeat(64), repoDigests: [] });
    const r = await resolveServiceImage(d.docker, "redis:8.2-alpine", null, () => {});
    expect(d.pulls).toEqual(["redis:8.2-alpine"]);
    expect(r.pin).toBe(`redis:8.2-alpine@${A}`);
  });

  it("refuses to pin an image the registry gave no digest for", async () => {
    const d = daemon({ "redis:7.4-alpine": A });
    const local = { inspectImage: async () => ({ id: "sha256:" + "3".repeat(64), repoDigests: [] }), pullImage: async () => {} } as unknown as DockerPort;
    const e = await resolveServiceImage(local, "redis:7.4-alpine", null, () => {}).catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/no digest, so it cannot be pinned/);
    expect(d.pulls).toEqual([]);
  });
});
