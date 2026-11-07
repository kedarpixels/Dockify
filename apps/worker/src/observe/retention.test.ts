/**
 * The Log retention value in Settings is applied: the worker's prune pass reads it every time.
 */
import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { Readable } from "node:stream";
import type { DockerReader } from "./docker.ts";
import { createLogCollector, logRetentionDays, pruneLogs, SECRETS_TTL_MS } from "./logs.ts";
import { newSamplerState } from "./sampler.ts";

const dbWith = (row: Record<string, unknown> | null) => ({ instance: { findUnique: async () => row } }) as unknown as Db;

describe("logRetentionDays", () => {
  it("uses the owner's setting, up to 365 days", async () => {
    expect(await logRetentionDays(dbWith({ logRetentionDays: 30 }), 7)).toBe(30);
    expect(await logRetentionDays(dbWith({ logRetentionDays: 365 }), 7)).toBe(365);
    expect(await logRetentionDays(dbWith({ logRetentionDays: 9999 }), 7)).toBe(365);
  });

  it("falls back to the environment's value only without a usable row", async () => {
    expect(await logRetentionDays(dbWith(null), 7)).toBe(7);
    expect(await logRetentionDays(dbWith({ logRetentionDays: 0 }), 7)).toBe(7);
    expect(await logRetentionDays(dbWith({ logRetentionDays: 2.5 }), 7)).toBe(7);
  });

  it("prunes runtime lines older than that many days", async () => {
    const cutoffs: Date[] = [];
    const db = {
      $executeRaw: async (_s: TemplateStringsArray, cutoff: Date) => {
        cutoffs.push(cutoff);
        return 0;
      },
    } as unknown as Db;
    const now = Date.parse("2026-11-06T00:00:00Z");
    await pruneLogs(db, await logRetentionDays(dbWith({ logRetentionDays: 30 }), 7), now);
    expect(cutoffs[0]?.toISOString()).toBe("2026-10-07T00:00:00.000Z");
  });
});

describe("secret values for one container's logs", () => {
  const reader = (bodies: number) => {
    let follows = 0;
    return {
      followLogs: async () => {
        follows++;
        // The container stopped at once, as a crash-looping one does: the follow ends.
        return Readable.from(follows <= bodies ? [] : []);
      },
    } as unknown as DockerReader;
  };
  const db = { $queryRaw: async () => [{ ts: null }], $executeRaw: async () => 0 } as unknown as Db;
  const state = (containerId: string) => {
    const s = newSamplerState();
    s.apps.set("a", { containerId, state: "restarting" } as never);
    return s;
  };
  const settle = () => new Promise((r) => setTimeout(r, 5));

  it("opens them once for a crash-looping container, however often its follow restarts", async () => {
    let opens = 0;
    const c = createLogCollector(db, reader(5), async () => { opens++; return ["a-secret-value"]; }, () => {});
    for (let i = 0; i < 5; i++) {
      await c.sync(state("c1"));
      await settle();
    }
    await c.close();
    expect(opens).toBe(1);
  });

  it("opens them again for a new container: a redeploy is a real new access", async () => {
    let opens = 0;
    const c = createLogCollector(db, reader(5), async () => { opens++; return ["a-secret-value"]; }, () => {});
    await c.sync(state("c1"));
    await settle();
    await c.sync(state("c2"));
    await settle();
    await c.close();
    expect(opens).toBe(2);
  });

  it("does not remember a read that found nothing, so a failed open is tried again", async () => {
    let opens = 0;
    const c = createLogCollector(db, reader(5), async () => { opens++; return []; }, () => {});
    for (let i = 0; i < 3; i++) {
      await c.sync(state("c1"));
      await settle();
    }
    await c.close();
    expect(opens).toBe(3);
  });

  it("forgets a container the listing no longer shows", async () => {
    let opens = 0;
    const c = createLogCollector(db, reader(5), async () => { opens++; return ["a-secret-value"]; }, () => {});
    await c.sync(state("c1"));
    await settle();
    await c.sync(newSamplerState());
    await c.sync(state("c1"));
    await settle();
    await c.close();
    expect(opens).toBe(2);
    expect(SECRETS_TTL_MS).toBeGreaterThan(0);
  });
});
