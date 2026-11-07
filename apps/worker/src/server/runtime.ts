/**
 * One server as the worker sees it: the one seam every module that touches a machine goes through.
 * Modules keep their own deps shape and take the parts of this they need, so nothing below knows
 * how a call reaches the server. There is one implementation per stage of the build; none of them
 * asks whether a server is the first one.
 */
import type { Builder, Dialer, DockerClient, HostReading, RouteStore } from "@dockify/engine";
import type { EdgeMode } from "../edge/ingress.ts";

export type { Builder, Dialer, DialTarget, RouteChange, RouteStore } from "@dockify/engine";

export interface ServerRuntime {
  serverId: string;
  docker: DockerClient;
  routes: RouteStore;
  host: () => Promise<HostReading>;
  dial: Dialer;
  builder: Builder;
  /** This server's ingress: what shape its route files take. */
  mode: EdgeMode;
  /** Its core count: what a tenant with no CPU limit of its own gets its default from. */
  cpuCores: number;
}
