import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVER_BOUND_KINDS, SERVER_ONLY_LANES, type EnqueueInput } from "./queue.ts";

const CHECK = /ADD CONSTRAINT "jobs_server_bound" CHECK \(\("kind" NOT IN \(([^)]*)\) AND "lane" NOT IN \(([^)]*)\)\) OR "serverId" IS NOT NULL\);/;
const listed = (sql: string) => [...sql.matchAll(/'(\w+)'/g)].map((m) => m[1]!).sort();

describe("the server-bound list", () => {
  it("stays in step with CHECK jobs_server_bound", () => {
    const sql = readFileSync(fileURLToPath(new URL("../prisma/migrations/0022_servers/migration.sql", import.meta.url)), "utf8");
    const m = CHECK.exec(sql);
    expect(m).not.toBeNull();
    expect(listed(m![1]!)).toEqual([...SERVER_BOUND_KINDS].sort());
    expect(listed(m![2]!)).toEqual([...SERVER_ONLY_LANES].sort());
  });

  it("makes the type say what the CHECK says", () => {
    const payload = {};
    const ok: EnqueueInput[] = [
      { kind: "deploy", payload, serverId: "s" },
      { kind: "prune", lane: "maintenance", payload, serverId: "s" },
      { kind: "edge_cf_unwire", lane: "deploy", payload, serverId: "s" },
      { kind: "dns_check", lane: "maintenance", payload },
    ];
    // @ts-expect-error a bound kind names its server
    const noServer: EnqueueInput = { kind: "deploy", payload };
    // @ts-expect-error a server's lane names its server, whatever the kind
    const noServerOnLane: EnqueueInput = { kind: "edge_cf_unwire", lane: "deploy", payload };
    // @ts-expect-error a global job on a global lane names none
    const globalWithServer: EnqueueInput = { kind: "dns_check", lane: "maintenance", payload, serverId: "s" };
    // @ts-expect-error the lane defaults to deploy, so a global kind must say where it goes
    const defaultLane: EnqueueInput = { kind: "dns_check", payload };
    expect([ok, noServer, noServerOnLane, globalWithServer, defaultLane]).toHaveLength(5);
  });
});
