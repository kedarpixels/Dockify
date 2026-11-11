/** One server as the worker sees it: the one seam every module that touches a machine goes through. */
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
  mode: EdgeMode;
  /** Its core count: what a tenant with no CPU limit of its own gets its default from. */
  cpuCores: number;
}
