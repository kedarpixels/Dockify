/**
 * Removing an environment queues one remove_app per app in it, in the transaction that drops the rows
 * (apps/api projects environments.delete). Run against a small fake Docker that holds the
 * environment's containers, volumes, routes and network, those jobs leave nothing behind: no
 * container, no named volume, no route file, the Cloudflare records Dockify made handed to the edge
 * module, and the environment's network gone once its last app went. The other environment is untouched.
 */
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { fileRouteStore, type DockerApi } from "@dockify/engine";
import { LABEL } from "./deploy/containers.ts";
import { writeRoute } from "./deploy/routes.ts";
import { removeApp } from "./teardown.ts";

const GONE_ENV = "0f0e0d0c-0000-4000-8000-0000000000e1";
const KEPT_ENV = "0f0e0d0c-0000-4000-8000-0000000000e2";
const WEB = "0f0e0d0c-0000-4000-8000-0000000000a1";
const DB = "0f0e0d0c-0000-4000-8000-0000000000a2";
const KEPT = "0f0e0d0c-0000-4000-8000-0000000000a3";
const net = (env: string) => `dockify-env-${env}`;

describe("an environment's removal on the worker", () => {
  it("leaves no container, volume, route or network of it, and keeps the other environment's", async () => {
    const containers = [
      { Id: "web-live", Labels: { [LABEL.app]: WEB, [LABEL.environment]: GONE_ENV } },
      { Id: "web-parked", Labels: { [LABEL.app]: WEB, [LABEL.environment]: GONE_ENV } },
      { Id: "db-live", Labels: { [LABEL.app]: DB, [LABEL.environment]: GONE_ENV } },
      { Id: "kept-live", Labels: { [LABEL.app]: KEPT, [LABEL.environment]: KEPT_ENV } },
    ];
    const volumes = new Set([`dk-${WEB}-uploads`, `dk-${DB}-data`, `dk-${KEPT}-data`]);
    const networks = new Map([
      [net(GONE_ENV), ["dockify-proxy", "dockify-worker"]],
      [net(KEPT_ENV), ["dockify-proxy", "dockify-worker", "kept-live"]],
    ]);
    const matches = (labels: Record<string, string>) => (c: (typeof containers)[number]) =>
      Object.entries(labels).every(([k, v]) => k === "dockify.managed" || (c.Labels as Record<string, string>)[k] === v);
    const docker = {
      listContainers: async (labels: Record<string, string>) => containers.filter(matches(labels)),
      removeContainer: async (id: string) => {
        containers.splice(containers.findIndex((c) => c.Id === id), 1);
        for (const [, attached] of networks) if (attached.includes(id)) attached.splice(attached.indexOf(id), 1);
      },
      listImages: async () => [],
      removeImage: async () => {},
      listEnvNetworks: async () => [...networks.keys()],
      inspectNetwork: async (name: string) => ({ Name: name, Containers: Object.fromEntries((networks.get(name) ?? []).map((c, i) => [`id${i}`, { Name: c }])) }),
      disconnectNetwork: async (name: string, c: string) => {
        const a = networks.get(name)!;
        a.splice(a.indexOf(c), 1);
      },
      removeNetwork: async (name: string) => void networks.delete(name),
    };
    const jobs: Array<{ kind: string; payload: unknown }> = [];
    // The rows are gone: only the kept environment still has an app on this server.
    const db = {
      deployment: { findFirst: async () => null },
      environment: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.filter((id) => id === KEPT_ENV).map((id) => ({ id })) },
      $transaction: async (fn: (tx: unknown) => unknown) =>
        fn({ $executeRaw: async () => 0, job: { findFirst: async () => null, create: async (a: { data: { kind: string; payload: unknown } }) => (jobs.push(a.data), { id: "j" }) } }),
    } as unknown as Db;
    const dir = await mkdtemp(join(tmpdir(), "dk-env-rm-"));
    const routes = fileRouteStore(dir);
    const conf = join(dir, "conf");
    await writeRoute(routes, { appId: WEB, hosts: ["staging.shop.example.com", "web-1-2-3-4.sslip.io"], port: 80, backend: "dk-route-web" }, "dash.example.com", { ingress: "cloudflare_tunnel" });
    await writeRoute(routes, { appId: KEPT, hosts: ["shop.example.com"], port: 80, backend: "dk-route-kept" }, "dash.example.com", { ingress: "cloudflare_tunnel" });
    expect(await readdir(conf)).toEqual(expect.arrayContaining([`${WEB}.yml`, `${KEPT}.yml`]));
    const deps = {
      db,
      docker: docker as unknown as DockerApi,
      routes,
      removeVolume: async (v: string) => void volumes.delete(v),
      networks: { docker: docker as never, ownContainers: ["dockify-proxy", "dockify-worker"] },
    };

    // The two jobs environments.delete queued, as the api builds them (projects/jobs.ts).
    await removeApp(deps, { appId: WEB, volumeNames: [`dk-${WEB}-uploads`], domains: [{ hostname: "staging.shop.example.com", cfZoneId: "z1", cfRecordId: "r1" }, { hostname: "web-1-2-3-4.sslip.io", cfZoneId: null, cfRecordId: null }], imageIds: [] }, "s1");
    await removeApp(deps, { appId: DB, volumeNames: [`dk-${DB}-data`], domains: [], imageIds: [] }, "s1");

    expect(containers.map((c) => c.Id)).toEqual(["kept-live"]);
    expect([...volumes]).toEqual([`dk-${KEPT}-data`]);
    expect([...networks.keys()]).toEqual([net(KEPT_ENV)]);
    expect((await readdir(conf)).filter((f) => f.includes(WEB))).toEqual([]);
    expect(await readdir(conf)).toContain(`${KEPT}.yml`);
    // Only the record Dockify made is handed on; the test domain has nothing to unwire.
    expect(jobs).toEqual([expect.objectContaining({ kind: "edge_cf_unwire", payload: expect.objectContaining({ hostname: "staging.shop.example.com", recordId: "r1" }) })]);
  });
});
