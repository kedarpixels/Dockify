import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { DockerError } from "@dockify/engine";
import { sweepEnvNetworks } from "./networks.ts";

const GONE = "0f0e0d0c-0000-4000-8000-0000000000aa";
const LIVE = "0f0e0d0c-0000-4000-8000-0000000000bb";
const net = (id: string) => `dockify-env-${id}`;

function fakes(o: { names: string[]; attached?: Record<string, string[]>; stopped?: string[]; removeError?: Error }) {
  const log: string[] = [];
  const docker = {
    listEnvNetworks: async () => o.names,
    inspectNetwork: async (name: string) => ({ Name: name, Containers: Object.fromEntries((o.attached?.[name] ?? []).map((c, i) => [`id${i}`, { Name: c }])) }),
    disconnectNetwork: async (name: string, c: string) => void log.push(`disconnect:${name}:${c}`),
    removeNetwork: async (name: string) => {
      if (o.removeError) throw o.removeError;
      log.push(`remove:${name}`);
    },
    listContainers: async (labels: Record<string, string>) => (o.stopped ?? []).filter((id) => labels["dockify.environment"] === id).map((id) => ({ Id: id })),
  };
  const db = { environment: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.filter((id) => id === LIVE).map((id) => ({ id })) } } as unknown as Db;
  return { log, deps: { db, serverId: "s1", docker: docker as never, ownContainers: ["dockify-proxy", "dockify-worker"] } };
}

describe("sweepEnvNetworks", () => {
  it("removes an orphaned network, detaching only the proxy and the worker first", async () => {
    const f = fakes({ names: [net(GONE)], attached: { [net(GONE)]: ["dockify-proxy", "dockify-worker"] } });
    expect(await sweepEnvNetworks(f.deps)).toBe(1);
    expect(f.log).toEqual([`disconnect:${net(GONE)}:dockify-proxy`, `disconnect:${net(GONE)}:dockify-worker`, `remove:${net(GONE)}`]);
  });

  it("keeps the network of an environment that exists, whatever is attached", async () => {
    const f = fakes({ names: [net(LIVE)] });
    expect(await sweepEnvNetworks(f.deps)).toBe(0);
    expect(f.log).toEqual([]);
  });

  it("never removes a network with a live container, and detaches nothing from it", async () => {
    const f = fakes({ names: [net(GONE)], attached: { [net(GONE)]: ["dockify-proxy", "dk-someapp"] } });
    expect(await sweepEnvNetworks(f.deps)).toBe(0);
    expect(f.log).toEqual([]);
  });

  it("keeps a network a stopped container of that environment still names", async () => {
    const f = fakes({ names: [net(GONE)], stopped: [GONE] });
    expect(await sweepEnvNetworks(f.deps)).toBe(0);
    expect(f.log).toEqual([]);
  });

  it("ignores any other name the filter let through", async () => {
    const f = fakes({ names: ["dockify-env-notauuid", "dockify-env-"] });
    expect(await sweepEnvNetworks(f.deps)).toBe(0);
    expect(f.log).toEqual([]);
  });

  it("leaves one that gained an endpoint in between for the next pass, without failing the sweep", async () => {
    const f = fakes({ names: [net(GONE)], removeError: new DockerError(403, "has active endpoints") });
    expect(await sweepEnvNetworks(f.deps)).toBe(0);
  });

  it("reports any other failure and carries on", async () => {
    const seen: string[] = [];
    const f = fakes({ names: [net(GONE)], removeError: new DockerError(500, "boom") });
    expect(await sweepEnvNetworks({ ...f.deps, log: (m) => void seen.push(m) })).toBe(0);
    expect(seen[0]).toContain(net(GONE));
  });
});
