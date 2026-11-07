/**
 * An image app's pull and the copy already on this server. Found on the test box: with Docker Hub's
 * anonymous limit spent, a redeploy failed although the image it needed was right there.
 */
import { describe, expect, it } from "vitest";
import { DockerError, isPermanent, type DockerApi, type ImageInfo } from "@dockify/engine";
import { DeployLog, type LogLine } from "./log.ts";
import { pullImage } from "./pull.ts";

const A = `sha256:${"a".repeat(64)}`;
const ID = `sha256:${"1".repeat(64)}`;
const RATE = new DockerError(500, "toomanyrequests: You have reached your pull rate limit. You may increase the limit by authenticating and upgrading");

/** A daemon holding `local` (reference to image) whose pulls answer with `pull`. */
function daemon(local: Record<string, ImageInfo>, pull: () => Promise<void>) {
  const pulls: string[] = [];
  const docker = {
    async inspectImage(ref: string) {
      const i = local[ref];
      if (!i) throw new DockerError(404, `No such image: ${ref}`);
      return i;
    },
    async pullImage(ref: string) {
      pulls.push(ref);
      await pull();
    },
  } as unknown as DockerApi;
  return { docker, pulls };
}
const image = (digests: string[]): ImageInfo => ({ Id: ID, RepoTags: [], RepoDigests: digests, Size: 1, Created: "" });

async function run(docker: DockerApi, ref: string, opts?: { localFirst?: boolean }) {
  const lines: LogLine[] = [];
  const log = new DeployLog({ write: async (l) => void lines.push(...l) });
  const out = await pullImage(docker, ref, null, log, new AbortController().signal, opts).catch((e: unknown) => e as Error);
  await log.flush();
  return { out, text: lines.map((l) => l.text).join("\n") };
}

describe("an image app's pull and the copy on this server", () => {
  it("runs a template's pinned digest from this server without asking the registry", async () => {
    const d = daemon({ [`gotify/server@${A}`]: image([`gotify/server@${A}`]) }, async () => { throw RATE; });
    const { out, text } = await run(d.docker, `gotify/server@${A}`, { localFirst: true });
    expect(out).toEqual({ imageId: ID, imageRef: `gotify/server@${A}` });
    expect(d.pulls).toEqual([]);
    expect(text).toContain("is already on this server; no pull");
  });

  it("pulls a pinned digest that is not here", async () => {
    let have: Record<string, ImageInfo> = {};
    const d = daemon(new Proxy({}, { get: (_, k: string) => have[k] }), async () => { have = { [`gotify/server@${A}`]: image([`gotify/server@${A}`]) }; });
    const { out } = await run(d.docker, `gotify/server@${A}`, { localFirst: true });
    expect(d.pulls).toEqual([`gotify/server@${A}`]);
    expect(out).toEqual({ imageId: ID, imageRef: `gotify/server@${A}` });
  });

  it("still pulls a tag on every deploy, so the tag brings what it names now", async () => {
    const d = daemon({ "nginx:latest": image([`nginx@${A}`]) }, async () => {});
    const { out } = await run(d.docker, "nginx:latest");
    expect(d.pulls).toEqual(["nginx:latest"]);
    expect(out).toEqual({ imageId: ID, imageRef: `nginx@${A}` });
  });

  it("runs the copy here when the pull hits a rate limit or an outage, and says so in one line", async () => {
    for (const err of [RATE, new DockerError(500, 'Get "https://registry-1.docker.io/v2/": dial tcp: connection refused')]) {
      const d = daemon({ "nginx:1.27": image([`nginx@${A}`]) }, async () => { throw err; });
      const { out, text } = await run(d.docker, "nginx:1.27");
      expect(out).toEqual({ imageId: ID, imageRef: `nginx@${A}` });
      expect(text).toMatch(/^==> could not pull nginx:1\.27 \(.+\); running the copy already on this server$/m);
    }
  });

  it("fails as before when the pull fails and nothing is here", async () => {
    const d = daemon({}, async () => { throw RATE; });
    const { out } = await run(d.docker, "nginx:1.27");
    expect(out).toBeInstanceOf(Error);
    expect(isPermanent(out)).toBe(false);
    expect((out as Error).message).toContain("toomanyrequests");
  });

  it("never runs a copy here when the registry refused the image or does not know it", async () => {
    const refused = new DockerError(404, "pull access denied for acme/private, repository does not exist or may require 'docker login': denied");
    const unknown = new DockerError(404, "manifest for nginx:nope not found: manifest unknown");
    for (const [ref, err] of [["acme/private:1", refused], ["nginx:nope", unknown]] as const) {
      const d = daemon({ [ref]: image([]) }, async () => { throw err; });
      const { out, text } = await run(d.docker, ref);
      expect(isPermanent(out)).toBe(true);
      expect(text).not.toContain("running the copy");
    }
  });

  it("records the digest of the reference's own repository when the image carries several names", async () => {
    const B = `sha256:${"b".repeat(64)}`;
    const d = daemon({ "ghcr.io/acme/web:2": image([`other/name@${B}`, `ghcr.io/acme/web@${A}`]) }, async () => {});
    const { out } = await run(d.docker, "ghcr.io/acme/web:2");
    expect(out).toEqual({ imageId: ID, imageRef: `ghcr.io/acme/web@${A}` });
  });
});
