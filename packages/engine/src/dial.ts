/**
 * A connection to something on one server's own networks, made from a process on that server. A
 * container is dialled at its address on the network asked for, which is why the process joins that
 * network for as long as a connection needs it. The proxy is dialled by its reserved alias, on the
 * network every Dockify service shares with it. Depends on a Docker client and nothing else.
 */
import { connect as netConnect, type Socket } from "node:net";
import type { ContainerInfo } from "./docker.ts";
import type { Dialer, DialTarget } from "./seam.ts";

/** The proxy's name on the deploy network, in the prefix no tenant can hold (deploy/docker-compose.yml). */
export const PROXY_HOST = "dk-proxy";
const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * How long a network is kept after its last connection closes. Longer than the gap between two
 * readiness probes, so a whole readiness gate is one join and one leave, not one per probe: each join
 * rewrites this process's routes.
 */
const LEAVE_AFTER_MS = 5_000;

export interface DialerDeps {
  docker: {
    inspectContainer(id: string): Promise<ContainerInfo>;
    connectNetwork(network: string, container: string): Promise<void>;
    disconnectNetwork(network: string, container: string): Promise<void>;
  };
  /** This process's own container. Empty when it needs no join (a process outside Docker, in dev). */
  selfContainer: string;
  /** Refuse a container that is not a tenant's. The agent always asks for this. */
  onlyManaged?: boolean;
  /** Tests pass a socket that never answers. */
  connect?: (o: { host: string; port: number }) => Socket;
  leaveAfterMs?: number;
}

interface Membership {
  refs: number;
  /** Settles when this process is on the network. Null when it is not, or is on its way off. */
  joined: Promise<void> | null;
  /** The leave in flight: a join waits for it, so the two can never cross. */
  leaving: Promise<void> | null;
  timer: NodeJS.Timeout | null;
}

const timedOut = (what: string, ms: number) => Object.assign(new Error(`${what} did not answer within ${ms} ms`), { code: "ETIMEDOUT" });

export function createDialer(deps: DialerDeps): Dialer {
  const { docker, selfContainer } = deps;
  const connect = deps.connect ?? ((o: { host: string; port: number }) => netConnect(o));
  const leaveAfterMs = deps.leaveAfterMs ?? LEAVE_AFTER_MS;
  const networks = new Map<string, Membership>();

  const forget = (network: string, m: Membership): void => {
    if (!m.refs && !m.joined && !m.leaving && networks.get(network) === m) networks.delete(network);
  };

  const leave = (network: string, m: Membership): void => {
    m.timer = null;
    if (m.refs || !m.joined) return;
    const joined = m.joined;
    m.joined = null;
    const leaving: Promise<void> = joined
      .then(() => docker.disconnectNetwork(network, selfContainer))
      .catch(() => {})
      .finally(() => {
        if (m.leaving === leaving) m.leaving = null;
        forget(network, m);
      });
    m.leaving = leaving;
  };

  const release = (network: string, m: Membership): void => {
    m.refs -= 1;
    if (m.refs) return;
    if (!leaveAfterMs) return leave(network, m);
    m.timer = setTimeout(() => leave(network, m), leaveAfterMs);
    m.timer.unref();
  };

  const acquire = async (network: string): Promise<Membership> => {
    const m = networks.get(network) ?? { refs: 0, joined: null, leaving: null, timer: null };
    networks.set(network, m);
    m.refs += 1;
    if (m.timer) clearTimeout(m.timer);
    m.timer = null;
    const joined = (m.joined ??= (m.leaving ?? Promise.resolve()).then(() => docker.connectNetwork(network, selfContainer)));
    try {
      await joined;
      return m;
    } catch (e) {
      if (m.joined === joined) m.joined = null;
      m.refs -= 1;
      forget(network, m);
      throw e;
    }
  };

  const open = (host: string, port: number, what: string, timeoutMs: number, signal?: AbortSignal): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = connect({ host, port });
      const settle = (e: Error | null): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        socket.removeListener("connect", onConnect);
        socket.removeListener("error", settle);
        if (!e) return resolve(socket);
        socket.destroy();
        reject(e);
      };
      const onConnect = (): void => settle(null);
      const onAbort = (): void => settle(new Error(`the connection to ${what} was cancelled`));
      const timer = setTimeout(() => settle(timedOut(what, timeoutMs)), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.once("connect", onConnect);
      socket.once("error", settle);
    });

  /** A connection whose owner has not attached yet, or has let go, must not be able to end the process. */
  const handOver = (socket: Socket, onClose?: () => void): Socket => {
    socket.on("error", () => {});
    if (onClose) socket.once("close", onClose);
    return socket;
  };

  return async (target: DialTarget, opts = {}) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const signal = opts.signal;
    signal?.throwIfAborted();
    if ("proxy" in target) return handOver(await open(PROXY_HOST, target.proxy, `the proxy on port ${target.proxy}`, timeoutMs, signal));

    const what = `port ${target.port} of ${target.container}`;
    const info = await docker.inspectContainer(target.container);
    if (deps.onlyManaged && info.Config?.Labels?.["dockify.managed"] !== "true") throw Object.assign(new Error(`${target.container} is not a tenant's container`), { code: "EACCES" });
    const address = info.NetworkSettings.Networks[target.network]?.IPAddress;
    if (!address) throw Object.assign(new Error(`${target.container} has no address on ${target.network}`), { code: "EHOSTUNREACH" });
    const m = selfContainer ? await acquire(target.network) : null;
    const done = m ? () => release(target.network, m) : undefined;
    try {
      signal?.throwIfAborted();
      return handOver(await open(address, target.port, what, timeoutMs, signal), done);
    } catch (e) {
      done?.();
      throw e;
    }
  };
}
