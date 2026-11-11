import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import type { Db } from "@dockify/db";
import type { DiskUsageVolume } from "@dockify/engine";
import type { DockerPort } from "./docker-port.ts";
import { CHECK_SCRIPT, discardRestoreScratch, RESTORE_TEST_NAME, restoreTestContainer, restoreTestVolume, sweepLeftovers } from "./leftovers.ts";
import { generateCredentials } from "./services.ts";

const BACKUP = "0f0e0d0c-0000-4000-8000-0000000000aa";
const LIVE = "0f0e0d0c-0000-4000-8000-0000000000bb";
const anon = (c: string) => c.repeat(64);

interface Setup {
  containers?: Array<{ id: string; names: string[]; labels: Record<string, string> }>;
  volumes?: DiskUsageVolume[];
  /** What each volume's check prints, by name. */
  verdict?: (volume: string) => string;
  liveBackups?: string[];
  localImage?: boolean;
}

function fakes(s: Setup = {}) {
  const log: string[] = [];
  const mounted = new Map<string, string>();
  const docker = {
    cpuCores: 4,
    list: async (labels: Record<string, string>) => (s.containers ?? []).filter((c) => Object.entries(labels).every(([k, v]) => c.labels[k] === v)).map((c) => ({ ...c, running: false })),
    remove: async (id: string, o?: { volumes?: boolean }) => void log.push(`remove:${id}:${o?.volumes ? "with-volumes" : "keep-volumes"}`),
    removeVolume: async (name: string) => void log.push(`removeVolume:${name}`),
    ensureNetwork: async () => {},
    createContainer: async (name: string, spec: { HostConfig: { Mounts: Array<{ Source: string; ReadOnly: boolean }> } }) => {
      const m = spec.HostConfig.Mounts[0]!;
      expect(m.ReadOnly).toBe(true);
      mounted.set(name, m.Source);
      log.push(`create:${name}`);
      return name;
    },
    start: async () => {},
    exec: async (name: string, o: { cmd: string[] }) => {
      expect(o.cmd).toEqual(["sh", "-c", CHECK_SCRIPT]);
      const stdout = new PassThrough();
      stdout.end(`${(s.verdict ?? (() => "keep"))(mounted.get(name)!)}\n`);
      return { stdout, stdin: null, done: Promise.resolve({ exitCode: 0, stderr: "" }), kill: async () => {} };
    },
    inspectImage: async () => (s.localImage === false ? null : { id: `sha256:${"a".repeat(64)}`, repoDigests: [] }),
    pullImage: async (ref: string) => void log.push(`pull:${ref}`),
  } as unknown as DockerPort;
  const db = {
    job: {
      findFirst: async ({ where }: { where: { dedupeKey?: string; payload?: { equals: string } } }) =>
        (s.liveBackups ?? []).some((b) => where.dedupeKey === `restore-test:${b}` || where.payload?.equals === b) ? { id: "j" } : null,
    },
    backup: { findFirst: async ({ where }: { where: { id: string } }) => ((s.liveBackups ?? []).includes(where.id) ? { id: where.id } : null) },
    app: { findMany: async () => [] },
  } as unknown as Db;
  return { docker, db, log, deps: { db, serverId: "s1", docker, volumes: async () => s.volumes ?? [], log: () => {} } };
}

const vol = (Name: string, Size: number, RefCount = 0, Labels: Record<string, string> | null = null): DiskUsageVolume => ({ Name, Labels, UsageData: { Size, RefCount } });

describe("the check that recognises an older restore test's copy", () => {
  it("asks for the database a restore test's credentials name, in the layout it runs", () => {
    // The credentials and the check must agree, or an old copy would never be found.
    expect(generateCredentials("postgres", RESTORE_TEST_NAME).database).toBe(RESTORE_TEST_NAME);
    expect(CHECK_SCRIPT).toContain("/c/pgdata/PG_VERSION");
    expect(CHECK_SCRIPT).toContain(`grep -q ${RESTORE_TEST_NAME} /c/pgdata/global/1262`);
  });
});

describe("discardRestoreScratch", () => {
  it("removes the container with its anonymous volumes, and the named copy", async () => {
    const { docker, log } = fakes();
    await discardRestoreScratch(docker, BACKUP);
    expect(log).toEqual([`remove:${restoreTestContainer(BACKUP)}:with-volumes`, `removeVolume:${restoreTestVolume(BACKUP)}`]);
  });

  it("still removes the copy when the container is already gone, and reports a real failure", async () => {
    const { docker, log } = fakes();
    docker.remove = async () => { throw Object.assign(new Error("gone"), { status: 404 }); };
    await discardRestoreScratch(docker, BACKUP);
    expect(log).toEqual([`removeVolume:${restoreTestVolume(BACKUP)}`]);
    docker.remove = async () => { throw Object.assign(new Error("daemon error"), { status: 500 }); };
    await expect(discardRestoreScratch(docker, BACKUP)).rejects.toThrow(/daemon error/);
    expect(log.filter((l) => l.startsWith("removeVolume"))).toHaveLength(2);
  });
});

describe("sweepLeftovers", () => {
  it("removes what a crashed restore test left, but never one still running", async () => {
    const f = fakes({
      containers: [
        { id: "c1", names: [restoreTestContainer(BACKUP)], labels: { "dockify.role": "restore-test" } },
        { id: "c2", names: [restoreTestContainer(LIVE)], labels: { "dockify.role": "restore-test" } },
      ],
      volumes: [vol(restoreTestVolume(BACKUP), 46_000_000), vol(restoreTestVolume(LIVE), 46_000_000)],
      liveBackups: [LIVE],
    });
    const r = await sweepLeftovers(f.deps);
    expect(r).toMatchObject({ scratchContainers: 1, scratchVolumes: 1 });
    expect(f.log).toContain("remove:c1:with-volumes");
    expect(f.log).toContain(`removeVolume:${restoreTestVolume(BACKUP)}`);
    expect(f.log.join()).not.toContain(LIVE);
    expect(f.log).not.toContain("remove:c2:with-volumes");
  });

  it("never removes a scratch volume a container still uses", async () => {
    const f = fakes({ volumes: [vol(restoreTestVolume(BACKUP), 1, 1)] });
    expect((await sweepLeftovers(f.deps)).scratchVolumes).toBe(0);
    expect(f.log).toEqual([]);
  });

  it("removes empty anonymous volumes, and no volume with data on that account", async () => {
    const f = fakes({ volumes: [vol(anon("a"), 0), vol(anon("b"), 0, 1), vol("dockify-data-x", 0), vol(anon("c"), -1), vol(anon("d"), 500)] });
    const r = await sweepLeftovers(f.deps);
    expect(r.emptyVolumes).toBe(1);
    expect(f.log).toContain(`removeVolume:${anon("a")}`);
    for (const name of [anon("b"), "dockify-data-x", anon("c"), anon("d")]) expect(f.log).not.toContain(`removeVolume:${name}`);
  });

  it("removes an older version's restore copy, keeps any other volume, and does not read a kept one twice", async () => {
    const copy = anon("e");
    const other = anon("f");
    const kept = new Set<string>();
    const f = fakes({ volumes: [vol(copy, 46_000_000), vol(other, 49_000_000)], verdict: (v) => (v === copy ? "scratch" : "keep") });
    const r = await sweepLeftovers({ ...f.deps, kept });
    expect(r.scratchVolumes).toBe(1);
    expect(f.log).toContain(`removeVolume:${copy}`);
    expect(f.log).not.toContain(`removeVolume:${other}`);
    // Each helper goes with its own anonymous volume.
    expect(f.log.filter((l) => l.startsWith("remove:dockify-rt-check-")).every((l) => l.endsWith(":with-volumes"))).toBe(true);
    expect([...kept]).toEqual([other]);
    f.log.length = 0;
    await sweepLeftovers({ ...f.deps, kept, volumes: async () => [vol(other, 49_000_000)] });
    expect(f.log).toEqual([]);
  });

  it("keeps a volume whose check could not run, and looks again next time", async () => {
    const kept = new Set<string>();
    const f = fakes({ volumes: [vol(anon("e"), 10)] });
    f.docker.createContainer = async () => { throw new Error("no room"); };
    expect((await sweepLeftovers({ ...f.deps, kept })).scratchVolumes).toBe(0);
    expect(kept.size).toBe(0);
    expect(f.log.some((l) => l.startsWith("removeVolume"))).toBe(false);
  });

  it("starts no helper and pulls nothing when there is nothing to read", async () => {
    const f = fakes({ volumes: [vol("dockify-data-x", 500)], localImage: false });
    await sweepLeftovers(f.deps);
    expect(f.log).toEqual([]);
  });
});

describe("volume backup helpers", () => {
  it("removes a helper a dead worker left with an app's volumes mounted, never one in use", async () => {
    const f = fakes({
      containers: [
        { id: "bk-dead", names: [`dockify-bk-${BACKUP}`], labels: { "dockify.role": "backup-helper" } },
        { id: "bk-live", names: [`dockify-bk-${LIVE}`], labels: { "dockify.role": "backup-helper" } },
        { id: "rs-dead", names: [`dockify-rs-${BACKUP}`], labels: { "dockify.role": "restore-helper" } },
        { id: "rs-live", names: [`dockify-rs-${LIVE}`], labels: { "dockify.role": "restore-helper" } },
      ],
      liveBackups: [LIVE],
    });
    const r = await sweepLeftovers(f.deps);
    expect(r.scratchContainers).toBe(2);
    expect(f.log).toEqual(["remove:bk-dead:with-volumes", "remove:rs-dead:with-volumes"]);
  });
});
