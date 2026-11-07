import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import type { DiskUsageVolume } from "@dockify/engine";
import { reportUnusedVolumes, UNUSED_VOLUMES_ACTION, unusedAnonymousVolumes } from "./volumes.ts";

const anon = (c: string) => c.repeat(64);
const v = (Name: string, RefCount: number, Size = 1024 ** 2, Labels: Record<string, string> | null = null): DiskUsageVolume => ({ Name, Labels, UsageData: { Size, RefCount } });

function fakeDb() {
  const rows: Array<Record<string, any>> = [];
  const db = {
    activityLog: {
      findFirst: async () => rows.at(-1) ?? null,
      create: async ({ data }: { data: Record<string, any> }) => (rows.push(data), data),
    },
  };
  return { db: db as unknown as Db, rows };
}

describe("unused anonymous volumes", () => {
  it("lists anonymous volumes no container uses, never named or in-use ones", () => {
    const list = unusedAnonymousVolumes([
      v(anon("b"), 0, 2048),
      v(anon("a"), 0, -1),
      v(anon("c"), 1),
      v("dockify-data-1234", 0),
      v("other", 0, 10, { "com.docker.volume.anonymous": "" }),
    ]);
    expect(list).toEqual([
      { name: anon("a"), sizeBytes: null },
      { name: anon("b"), sizeBytes: 2048 },
      { name: "other", sizeBytes: 10 },
    ]);
  });

  it("reports in Activity once per change, names each volume, and says Dockify leaves them", async () => {
    const { db, rows } = fakeDb();
    const five = ["1", "2", "3", "4", "5"].map((c) => v(anon(c), 0));
    await reportUnusedVolumes(db, five);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: UNUSED_VOLUMES_ACTION, category: "system", actorType: "system", verb: "found 5 unused anonymous volumes on", targetLabel: "this server" });
    expect(rows[0]!.suffix).toMatch(/Dockify leaves them/);
    expect(rows[0]!.changes.map((c: { key: string }) => c.key)).toEqual(five.map((x) => x.Name));
    // The same set again says nothing new.
    await reportUnusedVolumes(db, five);
    expect(rows).toHaveLength(1);
    // Once they are gone, one line says so; then quiet.
    await reportUnusedVolumes(db, []);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.verb).toBe("found no unused anonymous volumes left on");
    await reportUnusedVolumes(db, []);
    expect(rows).toHaveLength(2);
  });

  it("writes nothing on a clean server that never had any", async () => {
    const { db, rows } = fakeDb();
    await reportUnusedVolumes(db, [v("dockify-data-x", 1)]);
    expect(rows).toEqual([]);
  });
});
