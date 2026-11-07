import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { createDataChannel, handleOp, type ChannelDeps } from "./channel.ts";
import { PassThrough } from "node:stream";
import type { DockerPort } from "./docker-port.ts";

const APP = "0f0f0f0f-0000-4000-8000-000000000001";
const ENV = "0f0f0f0f-0000-4000-8000-0000000000e1";

function deps(over: { kind?: string; labels?: Record<string, string>; running?: boolean } = {}): ChannelDeps & { dialed: string[] } {
  const dialed: string[] = [];
  return {
    dialed,
    token: "t0ken-for-tests",
    db: { app: { findUnique: async () => ({ id: APP, name: "db", kind: over.kind ?? "postgres", environmentId: ENV }) } } as unknown as Db,
    docker: {
      inspect: async () => ({ id: "c", running: over.running ?? true, health: "healthy", labels: over.labels ?? { "dockify.app": APP, "dockify.managed": "true" }, addresses: { [`dockify-env-${ENV}`]: "10.9.0.5" } }),
    } as unknown as DockerPort,
    credentials: async () => ({ user: "dockify", password: "pw", database: "app" }),
    dial: async (t) => {
      if ("proxy" in t) throw new Error("a service is dialled, never the proxy");
      dialed.push(`dial:${t.container}:${t.network}:${t.port}`);
      return new PassThrough();
    },
    connectPg: async (_stream, t) => {
      dialed.push(`pg:${t.user}:${t.database}`);
      return { query: async (text: string) => ({ fields: [], rows: text.startsWith("SELECT current_database") ? [["app"]] : [] }), close: async () => {} };
    },
  };
}

describe("data channel", () => {
  it("dials the service on its environment network only after the label check", async () => {
    const d = deps();
    expect(await handleOp(d, "tables", { appId: APP })).toEqual({ database: "app", tables: [] });
    expect(d.dialed).toEqual([`dial:dk-${APP}:dockify-env-${ENV}:5432`, "pg:dockify:app"]);
  });
  it("refuses a container that is not this app's, a stopped one, and the wrong kind", async () => {
    await expect(handleOp(deps({ labels: { "dockify.app": "someone-else", "dockify.managed": "true" } }), "tables", { appId: APP })).rejects.toMatchObject({ code: "NOT_RUNNING" });
    await expect(handleOp(deps({ running: false }), "tables", { appId: APP })).rejects.toMatchObject({ code: "NOT_RUNNING" });
    await expect(handleOp(deps({ kind: "redis" }), "query", { appId: APP, sql: "select 1" })).rejects.toMatchObject({ code: "WRONG_KIND" });
    await expect(handleOp(deps(), "tables", { appId: "nope" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  describe("over http", () => {
    const server = createDataChannel(deps());
    let base = "";
    beforeAll(async () => {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it("requires the channel token", async () => {
      const res = await fetch(`${base}/data/tables`, { method: "POST", body: JSON.stringify({ appId: APP }) });
      expect(res.status).toBe(401);
      const bad = await fetch(`${base}/data/tables`, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" });
      expect(bad.status).toBe(401);
    });
    it("answers a refused query as a 400 with the reason", async () => {
      const res = await fetch(`${base}/data/query`, { method: "POST", headers: { authorization: "Bearer t0ken-for-tests" }, body: JSON.stringify({ appId: APP, sql: "DROP TABLE x" }) });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "QUERY_REFUSED" });
    });
  });
});
