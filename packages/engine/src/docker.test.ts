import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerClient, labelBytes, MAX_IMAGE_LABEL_BYTES } from "./docker.ts";
import { isPermanent } from "./errors.ts";

/** Docker copies an image's labels onto its container, so the budget is held before the create. */
describe("an image's labels are held to a budget before a container is made of it", () => {
  const IMAGES: Record<string, string> = {
    "ghcr.io/acme/ok:1": JSON.stringify({ Id: "sha256:ok", Config: { Labels: { "org.opencontainers.image.source": "https://example.com/acme" } } }),
    "ghcr.io/acme/none:1": JSON.stringify({ Id: "sha256:none", Config: { Labels: null } }),
    "ghcr.io/acme/edge:1": JSON.stringify({ Id: "sha256:edge", Config: { Labels: { k: "v".repeat(MAX_IMAGE_LABEL_BYTES - 1) } } }),
    "ghcr.io/acme/heavy:1": JSON.stringify({ Id: "sha256:heavy", Config: { Labels: Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`junk.${i}`, "x".repeat(60 * 1024)])) } }),
    "ghcr.io/acme/huge:1": JSON.stringify({ Id: "sha256:huge", Config: { Labels: { junk: "x".repeat(9 * 1024 * 1024) } } }),
  };
  const seen: string[] = [];
  let docker: Server;
  let client: DockerClient;
  const input = (image: string) => ({ name: "dk-a", image, network: "dockify-env-acme" });

  beforeAll(async () => {
    docker = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      req.resume();
      const m = /^\/v1\.43\/images\/([^/]+)\/json$/.exec(req.url ?? "");
      const image = m ? IMAGES[decodeURIComponent(m[1]!)] : undefined;
      if (m && !image) {
        res.statusCode = 404;
        return void res.end(JSON.stringify({ message: "No such image" }));
      }
      res.end(image ?? JSON.stringify({ Id: "a".repeat(64) }));
    });
    await new Promise<void>((r) => docker.listen(0, "127.0.0.1", r));
    client = new DockerClient({ host: "127.0.0.1", port: (docker.address() as AddressInfo).port }, { cpuCores: 4 });
  });
  afterAll(() => {
    docker.closeAllConnections();
    docker.close();
  });
  const created = () => seen.filter((s) => s.startsWith("POST /v1.43/containers/create"));

  it("counts keys and values in bytes", () => {
    expect(labelBytes({ ab: "cd", "é": "" })).toBe(6);
    expect(labelBytes(null)).toBe(0);
  });

  it("creates from an image with ordinary labels, none, or exactly the budget", async () => {
    for (const image of ["ghcr.io/acme/ok:1", "ghcr.io/acme/none:1", "ghcr.io/acme/edge:1"]) await expect(client.createContainer("dk-a", input(image))).resolves.toBe("a".repeat(64));
    expect(created()).toHaveLength(3);
  });

  it("refuses one past the budget, for good and in the owner's words, before any create", async () => {
    seen.length = 0;
    const e = await client.createContainer("dk-a", input("ghcr.io/acme/heavy:1")).catch((x: unknown) => x);
    expect(isPermanent(e)).toBe(true);
    expect((e as Error).message).toBe("This image carries 181 KB of labels, and Dockify runs an image with at most 64 KB of them. Remove LABEL lines from its Dockerfile, then deploy again.");
    expect(created()).toEqual([]);
  });

  it("refuses one whose inspect is itself too large to read", async () => {
    seen.length = 0;
    const e = await client.createContainer("dk-a", input("ghcr.io/acme/huge:1")).catch((x: unknown) => x);
    expect(isPermanent(e)).toBe(true);
    expect((e as Error).message).toMatch(/carries megabytes of labels/);
    expect(created()).toEqual([]);
  });

  it("leaves an image that cannot be read for the create to report", async () => {
    seen.length = 0;
    await client.createContainer("dk-a", input("ghcr.io/acme/gone:1"));
    expect(created()).toHaveLength(1);
  });
});
