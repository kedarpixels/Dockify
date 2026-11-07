/**
 * A Cancel pressed in the last seconds of a build (found on the test box): the activity said cancelled,
 * and the deploy went on to serve, because the cancel poll runs every two seconds and the swap started
 * in between. The row is now read at the last point a cancel can win, and a cancel the swap overruled
 * is said in the log.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { cancelAsked, LATE_CANCEL } from "./pipeline.ts";

const db = (status: string | null) => ({ deployment: { findUnique: async () => (status ? { status } : null) } }) as unknown as Pick<Db, "deployment">;

describe("a cancel at the end of a build", () => {
  it("is read from the row itself", async () => {
    expect(await cancelAsked(db("cancelling"), "d")).toBe(true);
    expect(await cancelAsked(db("building"), "d")).toBe(false);
    expect(await cancelAsked(db(null), "d")).toBe(false);
  });

  it("is checked right before the deploy starts, after the release command, with no poll in between", () => {
    const src = readFileSync(new URL("./pipeline.ts", import.meta.url), "utf8");
    const at = src.indexOf('data: { status: "deploying" }');
    const before = src.slice(0, at);
    expect(before.trimEnd().endsWith('await db.deployment.updateMany({ where: { id: deploymentId, status: "building" },')).toBe(true);
    expect(before.lastIndexOf("await checkCancelNow();")).toBeGreaterThan(before.lastIndexOf('await track.set("release"'));
    expect(src).toContain("throw new DeployCancelled();\n    }\n  };");
  });

  it("one that came once the new version served is said in the log, for the app and for a preview", () => {
    const src = readFileSync(new URL("./pipeline.ts", import.meta.url), "utf8");
    expect(src.match(/await noteLateCancel\(\);\n\s+await log\.flush\(\);\n\s+await settle\(db, deploymentId, "ready"/g)).toHaveLength(2);
    expect(LATE_CANCEL).toMatch(/stays live/);
  });
});
