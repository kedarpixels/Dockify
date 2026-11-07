import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileRouteStore } from "./route-store.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dk-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const conf = (name = "") => join(dir, "conf", name);
const staging = () => join(dir, ".staging");

describe("the route store on a disk", () => {
  it("writes into the watched folder through staging, and leaves no temp behind", async () => {
    const s = fileRouteStore(dir);
    await s.apply({ writes: { "a.yml": "one", "__edge.yml": "two" } });
    expect(await readFile(conf("a.yml"), "utf8")).toBe("one");
    expect(await s.read("a.yml")).toBe("one");
    expect(await s.read("gone.yml")).toBeNull();
    expect(await readdir(staging())).toEqual([]);
    expect(await s.snapshot()).toEqual({ "a.yml": "one", "__edge.yml": "two" });
  });

  it("makes the folder Traefik watches even with nothing to change", async () => {
    await fileRouteStore(dir).apply({});
    expect(await readdir(conf())).toEqual([]);
  });

  it("removes, and a file already gone is fine", async () => {
    const s = fileRouteStore(dir);
    await s.apply({ writes: { "a.yml": "one" } });
    await s.apply({ removes: ["a.yml", "never.yml"] });
    expect(await readdir(conf())).toEqual([]);
  });

  it("takes a bare *.yml name and nothing else, in every call", async () => {
    const s = fileRouteStore(dir);
    for (const bad of ["../a.yml", "a/b.yml", "a\\b.yml", "a.yaml", "a", ".hidden.yml", ".yml", "", "/etc/a.yml"]) {
      await expect(s.read(bad), bad).rejects.toThrow(/bare/);
      await expect(s.apply({ writes: { [bad]: "x" } }), bad).rejects.toThrow(/bare/);
      await expect(s.apply({ removes: [bad] }), bad).rejects.toThrow(/bare/);
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it("leaves anything else in the folder out of a snapshot", async () => {
    await mkdir(conf(), { recursive: true });
    await writeFile(conf("a.yml"), "one");
    await writeFile(conf("notes.txt"), "two");
    expect(await fileRouteStore(dir).snapshot()).toEqual({ "a.yml": "one" });
  });

  it("removes land before the writes, and a write that cannot land leaves no temp", async () => {
    const s = fileRouteStore(dir);
    await s.apply({ writes: { "old.yml": "kept" } });
    // A folder where the file goes: its rename cannot succeed.
    await mkdir(conf("blocked.yml"));
    await expect(s.apply({ writes: { "blocked.yml": "x" }, removes: ["old.yml"] })).rejects.toThrow();
    await expect(readFile(conf("old.yml"), "utf8")).rejects.toThrow();
    expect(await readdir(staging())).toEqual([]);
  });

  it("clears a temp a crash left, once it is old, inside any apply", async () => {
    const t0 = Date.now();
    let now = t0;
    const s = fileRouteStore(dir, { now: () => now });
    await s.apply({});
    const temp = join(staging(), "a.yml.dead.tmp");
    await writeFile(temp, "half");
    await utimes(temp, new Date(t0), new Date(t0));
    // Still young: it may belong to a write in flight.
    now = t0 + 30 * 60_000;
    await s.apply({});
    expect(await readdir(staging())).toEqual(["a.yml.dead.tmp"]);
    now = t0 + 61 * 60_000;
    await s.apply({});
    expect(await readdir(staging())).toEqual([]);
  });
});
