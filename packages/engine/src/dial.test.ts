import { createServer, Socket, type AddressInfo, type Server } from "node:net";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerError, type ContainerInfo } from "./docker.ts";
import { createDialer, PROXY_HOST, type DialerDeps } from "./dial.ts";

const NET = "dockify-env-e1";
let server: Server;
let port = 0;
beforeAll(async () => {
  server = createServer((s) => {
    s.on("error", () => {});
    s.on("data", (d) => s.write(d));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.close();
});

const info = (networks: Record<string, { IPAddress: string }>) => ({ NetworkSettings: { Networks: networks } }) as unknown as ContainerInfo;

function fakeDocker(networks: Record<string, { IPAddress: string }> = { [NET]: { IPAddress: "127.0.0.1" } }) {
  const calls: string[] = [];
  const docker: DialerDeps["docker"] & { failJoin: Error | null } = {
    failJoin: null,
    inspectContainer: async () => info(networks),
    connectNetwork: async (network, container) => {
      calls.push(`join ${network} ${container}`);
      if (docker.failJoin) throw docker.failJoin;
    },
    disconnectNetwork: async (network, container) => void calls.push(`leave ${network} ${container}`),
  };
  return { docker, calls };
}

const target = () => ({ container: "c1", network: NET, port });
const closed = async (s: { destroy(): unknown; once(e: string, f: () => void): unknown }) => {
  const done = new Promise<void>((r) => s.once("close", () => r()));
  s.destroy();
  await done;
};
const settled = () => new Promise((r) => setTimeout(r, 15));

describe("dialing a container", () => {
  it("connects to its address on the network, after joining that network", async () => {
    const { docker, calls } = fakeDocker();
    const dial = createDialer({ docker, selfContainer: "worker", leaveAfterMs: 0 });
    const s = await dial(target());
    s.write("hi");
    const [echo] = await once(s, "data");
    expect(echo.toString()).toBe("hi");
    expect(calls).toEqual([`join ${NET} worker`]);
    await closed(s);
    await settled();
    expect(calls).toEqual([`join ${NET} worker`, `leave ${NET} worker`]);
  });

  it("joins once per network however many connections share it, and leaves with the last", async () => {
    const { docker, calls } = fakeDocker();
    const dial = createDialer({ docker, selfContainer: "worker", leaveAfterMs: 0 });
    const [a, b] = await Promise.all([dial(target()), dial(target())]);
    expect(calls.filter((c) => c.startsWith("join"))).toHaveLength(1);
    await closed(a!);
    await settled();
    expect(calls.filter((c) => c.startsWith("leave"))).toHaveLength(0);
    await closed(b!);
    await settled();
    expect(calls.filter((c) => c.startsWith("leave"))).toHaveLength(1);
    // A later connection joins again, after the leave.
    const c = await dial(target());
    expect(calls.filter((x) => x.startsWith("join"))).toHaveLength(2);
    await closed(c);
    await settled();
    expect(calls.filter((x) => x.startsWith("leave"))).toHaveLength(2);
  });

  it("keeps the network between probes that come close together", async () => {
    const { docker, calls } = fakeDocker();
    const dial = createDialer({ docker, selfContainer: "worker", leaveAfterMs: 40 });
    await closed(await dial(target()));
    await settled();
    await closed(await dial(target()));
    await settled();
    expect(calls).toEqual([`join ${NET} worker`]);
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toEqual([`join ${NET} worker`, `leave ${NET} worker`]);
  });

  it("a join waits for a leave in flight, so the two never cross", async () => {
    const { docker, calls } = fakeDocker();
    let finishLeave = () => {};
    docker.disconnectNetwork = (network, container) => new Promise((r) => {
      calls.push(`leave ${network} ${container}`);
      finishLeave = () => {
        calls.push("left");
        r();
      };
    });
    const dial = createDialer({ docker, selfContainer: "worker", leaveAfterMs: 0 });
    await closed(await dial(target()));
    await settled();
    const next = dial(target());
    await settled();
    expect(calls).toEqual([`join ${NET} worker`, `leave ${NET} worker`]);
    finishLeave();
    await closed(await next);
    expect(calls.slice(2, 4)).toEqual(["left", `join ${NET} worker`]);
  });

  it("needs no join without a container of its own", async () => {
    const { docker, calls } = fakeDocker();
    const s = await createDialer({ docker, selfContainer: "" })(target());
    await closed(s);
    expect(calls).toEqual([]);
  });

  it("a failed join fails the dial and holds nothing", async () => {
    const { docker, calls } = fakeDocker();
    docker.failJoin = new DockerError(500, "the network is gone");
    const dial = createDialer({ docker, selfContainer: "worker", leaveAfterMs: 0 });
    await expect(dial(target())).rejects.toThrow(/the network is gone/);
    docker.failJoin = null;
    await closed(await dial(target()));
    await settled();
    expect(calls).toEqual([`join ${NET} worker`, `join ${NET} worker`, `leave ${NET} worker`]);
  });

  it("refuses a container with no address on that network, without joining it", async () => {
    const { docker, calls } = fakeDocker({ other: { IPAddress: "10.0.0.1" } });
    const err = await createDialer({ docker, selfContainer: "worker" })(target()).catch((e: unknown) => e as NodeJS.ErrnoException);
    expect((err as NodeJS.ErrnoException).code).toBe("EHOSTUNREACH");
    expect(calls).toEqual([]);
  });

  it("a refused connection rejects and gives the network back", async () => {
    const { docker, calls } = fakeDocker();
    const dead = createServer();
    dead.listen(0, "127.0.0.1");
    await once(dead, "listening");
    const deadPort = (dead.address() as AddressInfo).port;
    dead.close();
    await once(dead, "close");
    const dial = createDialer({ docker, selfContainer: "worker", leaveAfterMs: 0 });
    await expect(dial({ container: "c1", network: NET, port: deadPort })).rejects.toMatchObject({ code: "ECONNREFUSED" });
    await settled();
    expect(calls).toEqual([`join ${NET} worker`, `leave ${NET} worker`]);
  });

  it("rejects when nothing answers within the timeout, and gives the network back", async () => {
    const { docker, calls } = fakeDocker();
    const silent = new Socket();
    const dial = createDialer({ docker, selfContainer: "worker", leaveAfterMs: 0, connect: () => silent });
    const started = Date.now();
    await expect(dial(target(), { timeoutMs: 30 })).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(silent.destroyed).toBe(true);
    await settled();
    expect(calls).toEqual([`join ${NET} worker`, `leave ${NET} worker`]);
  });

  it("a cancel ends the wait at once", async () => {
    const { docker } = fakeDocker();
    const ac = new AbortController();
    const dial = createDialer({ docker, selfContainer: "", connect: () => new Socket() });
    const p = dial(target(), { timeoutMs: 60_000, signal: ac.signal });
    await settled();
    ac.abort();
    await expect(p).rejects.toThrow(/cancelled/);
    const after = new AbortController();
    after.abort();
    await expect(dial(target(), { signal: after.signal })).rejects.toThrow();
  });

  it("a connection whose owner lets it fail cannot end the process", async () => {
    const { docker } = fakeDocker();
    const s = await createDialer({ docker, selfContainer: "" })(target());
    const gone = new Promise((r) => s.once("close", r));
    s.emit("error", new Error("reset"));
    s.destroy();
    await gone;
  });
});

describe("dialing the proxy", () => {
  it("connects to its reserved name on the port asked for, with no Docker call at all", async () => {
    const { docker, calls } = fakeDocker();
    const seen: Array<{ host: string; port: number }> = [];
    const dial = createDialer({
      docker, selfContainer: "worker",
      connect: (o) => {
        seen.push(o);
        const s = new Socket();
        return s.connect({ host: "127.0.0.1", port });
      },
    });
    await closed(await dial({ proxy: 8082 }));
    expect(seen).toEqual([{ host: PROXY_HOST, port: 8082 }]);
    expect(calls).toEqual([]);
  });
});
