/** An app going away mid-tick must stay quiet, and must not cost other apps their data. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DockerError, isNotFound } from "@dockify/engine";
import { createDockerReader } from "./docker.ts";
import { insertLiveLogRows } from "./logs.ts";
import { insertSamples } from "./sampler.ts";

describe("a container gone from Docker", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  const reader = async (status: number) => {
    server = createServer((_req, res) => {
      res.statusCode = status;
      res.end("{}");
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return createDockerReader({ host: "127.0.0.1", port: (server.address() as AddressInfo).port });
  };

  it("answers 404 as not found on every read, so the sampler and the log follower say nothing", async () => {
    const d = await reader(404);
    const id = "a".repeat(64);
    for (const read of [() => d.inspect(id), () => d.stats(id), () => d.followLogs(id, 0, new AbortController().signal)]) {
      const e = await read().catch((x: unknown) => x);
      expect(isNotFound(e)).toBe(true);
    }
  });

  it("reads an empty body, as Docker sends when the container goes during a read, as gone", async () => {
    server = createServer((_req, res) => res.end());
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const d = createDockerReader({ host: "127.0.0.1", port: (server.address() as AddressInfo).port });
    expect(isNotFound(await d.stats("a".repeat(64)).catch((x: unknown) => x))).toBe(true);
  });

  it("keeps the status of a container being removed, so the log follower can tell it apart", async () => {
    const e = await (await reader(409)).followLogs("a".repeat(64), 0, new AbortController().signal).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DockerError);
    expect((e as DockerError).status).toBe(409);
  });

  it("does not read any other status as gone", async () => {
    const e = await (await reader(500)).inspect("a".repeat(64)).catch((x: unknown) => x);
    expect(isNotFound(e)).toBe(false);
  });
});

const line = (appId: string) => ({ appId, ts: new Date(0), stream: "stdout", level: "info", text: "x" }) as never;
const fk = () => new Error("Raw query failed. Code: `23503`. Message: `violates foreign key constraint`");
const appsOf = (values: unknown[]) => values[0] as string[];

describe("log lines of a deleted app", () => {
  it("are left out before the insert, so the other app keeps its lines and nothing is refused", async () => {
    const written: string[][] = [];
    const db = {
      app: { findMany: async () => [{ id: "a" }] },
      $executeRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => {
        written.push(appsOf(values));
        return 1;
      },
    } as never;
    await insertLiveLogRows(db, [line("a"), line("gone"), line("a")]);
    expect(written).toEqual([["a", "a"]]);
  });

  it("are dropped on a retry when a delete wins the race after the check", async () => {
    let live = ["a", "b"];
    const written: string[][] = [];
    const db = {
      app: { findMany: async () => live.map((id) => ({ id })) },
      $executeRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => {
        if (live.length === 2) {
          live = ["a"];
          throw fk();
        }
        written.push(appsOf(values));
        return 1;
      },
    } as never;
    await insertLiveLogRows(db, [line("a"), line("b")]);
    expect(written).toEqual([["a"]]);
  });

  it("still throws anything else", async () => {
    const db = { app: { findMany: async () => [{ id: "a" }] }, $executeRaw: async () => { throw new Error("connection lost"); } } as never;
    await expect(insertLiveLogRows(db, [line("a")])).rejects.toThrow(/connection lost/);
  });
});

describe("metric samples of a deleted app", () => {
  it("are left out before the insert, so Prisma has nothing to print", async () => {
    const calls: string[][] = [];
    const db = {
      app: { findMany: async () => [{ id: "a" }] },
      metricSample: { createMany: async ({ data }: { data: Array<{ appId: string }> }) => {
        calls.push(data.map((d) => d.appId));
        return { count: data.length };
      } },
    } as never;
    await insertSamples(db, [{ appId: "a" }, { appId: "gone" }] as never);
    expect(calls).toEqual([["a"]]);
  });
});
