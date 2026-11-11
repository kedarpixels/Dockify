import { describe, expect, it } from "vitest";
import { withRouteLock } from "./route-lock.ts";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("withRouteLock", () => {
  it("runs one holder at a time per app, in the order they asked", async () => {
    const seen: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const first = withRouteLock("a", async () => {
      seen.push("first in");
      await gate;
      seen.push("first out");
    });
    const second = withRouteLock("a", async () => void seen.push("second"));
    const third = withRouteLock("a", async () => void seen.push("third"));
    await tick();
    expect(seen).toEqual(["first in"]);
    open();
    await Promise.all([first, second, third]);
    expect(seen).toEqual(["first in", "first out", "second", "third"]);
  });

  it("never makes one app wait for another", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const held = withRouteLock("a", () => gate);
    expect(await withRouteLock("b", async () => "ran")).toBe("ran");
    open();
    await held;
  });

  it("lets the next holder in after one throws, and hands back the result", async () => {
    await expect(withRouteLock("a", async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
    expect(await withRouteLock("a", async () => 7)).toBe(7);
  });
});
