import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import type { ContainerInput } from "@dockify/engine";
import { DockerError, type ContainerInfo, type DockerApi, type ImageInfo } from "@dockify/engine";
import { DeployLog } from "./log.ts";
import { ensurePreviewDb, FORK_NETWORK, loadPreviewContext, PREVIEW_DB_IMAGE, previewDbImage, previewDbVolume, previewVars, type PreviewContext } from "./preview.ts";

const PROJECT = "0f0f0f0f-0000-4000-8000-0000000000f1";
const DIGEST = `sha256:${"1".repeat(64)}`;
const NEWER = `sha256:${"2".repeat(64)}`;
const ID = `sha256:${"b".repeat(64)}`;

/** A daemon with a registry behind it, enough for the preview database: images, one container, pulls. */
function fakes(tagDigest = DIGEST) {
  const images = new Map<string, ImageInfo>();
  const pulls: string[] = [];
  const created: ContainerInput[] = [];
  const volumes: string[] = [];
  let container: ContainerInfo | null = null;
  const docker = {
    ensureNetwork: async () => {},
    ensureVolume: async (name: string) => void volumes.push(`ensure:${name}`),
    removeVolume: async (name: string) => void volumes.push(`remove:${name}`),
    inspectImage: async (ref: string) => {
      const i = images.get(ref);
      if (!i) throw new DockerError(404, `No such image: ${ref}`);
      return i;
    },
    pullImage: async (ref: string) => {
      pulls.push(ref);
      const digest = ref.includes("@") ? ref.split("@")[1]! : tagDigest;
      const img: ImageInfo = { Id: ID, RepoTags: [ref], RepoDigests: [`postgres@${digest}`], Size: 1, Created: "" };
      images.set(ref, img);
      images.set(`postgres@${digest}`, img);
    },
    inspectContainer: async () => {
      if (!container) throw new DockerError(404, "No such container");
      return container;
    },
    createContainer: async (name: string, input: ContainerInput) => {
      created.push(input);
      container = {
        Id: name, Name: `/${name}`, Image: input.image, RestartCount: 0,
        State: { Status: "running", Running: true, Restarting: false, ExitCode: 0, Health: { Status: "healthy" } },
        Config: { Labels: input.labels ?? {}, Env: Object.entries(input.env ?? {}).map(([k, v]) => `${k}=${v}`) },
        NetworkSettings: { Networks: {} },
      };
      return name;
    },
    startContainer: async () => {},
  } as unknown as DockerApi;
  const project = { previewDbImage: null as string | null };
  const db = {
    project: {
      findUnique: async () => project,
      update: async ({ data }: { data: { previewDbImage: string } }) => Object.assign(project, data),
    },
  } as unknown as Db;
  return { docker, db, project, pulls, created, images, volumes };
}

const log = () => new DeployLog({ write: async () => {} });
const ctx = (envId: string): PreviewContext => ({
  pdId: "pd1", envId, projectId: PROJECT, prNumber: 7, hostname: "pr-7.preview.example", fromFork: false, isolatedDb: true, isolation: "base",
  network: "dockify-env-0f0f0f0f-0000-4000-8000-0000000000e1", limits: { cpu: 0.5, memoryMb: 512, pids: 128 },
});

describe("preview database volume", () => {
  const ENV = "0f0f0f0f-0000-4000-8000-0000000000a2";
  it("keeps its data on a volume named for the preview, so the image's anonymous one is never made", async () => {
    const f = fakes();
    await ensurePreviewDb(f.db, f.docker, ctx(ENV), log(), new AbortController().signal);
    expect(f.created[0]!.volumes).toEqual([{ name: previewDbVolume(ENV), mountPath: "/var/lib/postgresql/data" }]);
    // The socket proxy only lets the worker delete volumes named dk- or dockify-data-.
    expect(previewDbVolume(ENV)).toMatch(/^dk-/);
  });
  it("starts from an empty volume: what a lost container left holds a password nobody has", async () => {
    const f = fakes();
    await ensurePreviewDb(f.db, f.docker, ctx(ENV), log(), new AbortController().signal);
    expect(f.volumes).toEqual([`remove:${previewDbVolume(ENV)}`, `ensure:${previewDbVolume(ENV)}`]);
  });
});

describe("preview database image", () => {
  it("pulls the tag once, records its digest on the project, and creates the database from it", async () => {
    const f = fakes();
    const out = await ensurePreviewDb(f.db, f.docker, ctx("0f0f0f0f-0000-4000-8000-0000000000a1"), log(), new AbortController().signal);
    expect(f.pulls).toEqual([PREVIEW_DB_IMAGE]);
    expect(f.project.previewDbImage).toBe(`${PREVIEW_DB_IMAGE}@${DIGEST}`);
    expect(f.created[0]!.image).toBe(ID);
    expect(out.user).toBe("preview");
  });

  it("every later preview database runs the recorded digest, even when the tag has moved", async () => {
    const f = fakes(NEWER);
    f.project.previewDbImage = `${PREVIEW_DB_IMAGE}@${DIGEST}`;
    // The digest left the server: it is pulled by digest, never by the moved tag.
    expect(await previewDbImage(f.db, f.docker, PROJECT, log(), new AbortController().signal)).toBe(ID);
    expect(f.pulls).toEqual([`postgres@${DIGEST}`]);
    expect(f.project.previewDbImage).toBe(`${PREVIEW_DB_IMAGE}@${DIGEST}`);
    // Now on the server: nothing is pulled at all.
    f.pulls.length = 0;
    await previewDbImage(f.db, f.docker, PROJECT, log(), new AbortController().signal);
    expect(f.pulls).toEqual([]);
  });
});

describe("a fork preview stays isolated", () => {
  const dbFor = (rowFork: boolean, open: Array<{ fromFork: boolean }>) =>
    ({
      previewDeployment: {
        findUnique: async () => ({
          id: "pd", hostname: "pr-7-web.preview.example.com", deployments: open,
          env: { id: "e", prNumber: 7, fromFork: rowFork, isolatedDb: true, status: "building", baseEnvironmentId: "env-prod", baseEnvironment: { name: "production" }, project: { id: "p", previewCpuLimit: 0.5, previewMemoryMb: 256, previewPidsLimit: 64, previewProductionAccess: true, environments: [{ id: "env-prod" }] } },
        }),
      },
    }) as unknown as Db;

  it("runs on the fork network, whatever its base environment is", async () => {
    expect(await loadPreviewContext(dbFor(true, []), "pd")).toMatchObject({ network: FORK_NETWORK, fromFork: true, isolatedDb: true });
  });

  it("a deployment queued for a fork commit stays a fork build after the preview row stops saying so", async () => {
    expect(await loadPreviewContext(dbFor(false, [{ fromFork: true }]), "pd")).toMatchObject({ network: FORK_NETWORK, fromFork: true, isolation: "fork" });
    expect(await loadPreviewContext(dbFor(false, [{ fromFork: false }]), "pd")).toMatchObject({ fromFork: false });
  });

  it("gets no secret and its own database URL", () => {
    const vars = [
      { key: "DATABASE_URL", value: "postgres://real", isSecret: true, target: "both" as const },
      { key: "REDIS_URL", value: "redis://real", isSecret: true, target: "both" as const },
      { key: "API_KEY", value: "real", isSecret: true, target: "both" as const },
      { key: "PUBLIC_NAME", value: "shop", isSecret: false, target: "both" as const },
    ];
    const out = previewVars(vars, { isolation: "fork", prNumber: 7, hostname: "h" }, { url: "postgres://own", host: "o", port: 5432, user: "u", password: "p", database: "d" });
    const by = new Map(out.map((v) => [v.key, v.value]));
    expect(by.get("DATABASE_URL")).toBe("postgres://own");
    expect(by.has("REDIS_URL")).toBe(false);
    expect(by.has("API_KEY")).toBe(false);
    expect(by.get("PUBLIC_NAME")).toBe("shop");
  });
});
