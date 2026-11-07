/**
 * Zero-downtime or stop-then-start, decided once per deploy and always explained. Never a silent
 * fallback: the reasons go into the deploy log, and the same function can tell the UI before a
 * deploy why an app cannot get zero downtime.
 */
export type SwapMode = "zero_downtime" | "stop_then_start";

export interface StrategyInput {
  kind: string;
  volumes: Array<{ name: string; mountPath: string }>;
  /** Host ports the app would bind. Dockify never publishes them today, but a fixed host port can
   *  only be held by one container, so it would force stop-then-start. */
  hostPorts?: number[];
  replicas?: number;
}

export interface Strategy {
  mode: SwapMode;
  reasons: string[];
}

const STATEFUL_KINDS = new Set(["postgres", "redis", "s3"]);

export function swapStrategy(app: StrategyInput): Strategy {
  const reasons: string[] = [];
  if (app.volumes.length > 0) {
    const list = app.volumes.map((v) => `${v.name} at ${v.mountPath}`).join(", ");
    reasons.push(`it mounts volume ${list}, which holds single-writer state; two containers on one volume can corrupt it`);
  }
  if (STATEFUL_KINDS.has(app.kind) && app.volumes.length === 0) {
    reasons.push(`it is a ${app.kind} service, which owns its data and must not run twice`);
  }
  const ports = [...new Set(app.hostPorts ?? [])];
  if (ports.length > 0) {
    reasons.push(`it binds fixed host port${ports.length > 1 ? "s" : ""} ${ports.join(", ")}, which only one container can hold`);
  }
  return reasons.length ? { mode: "stop_then_start", reasons } : { mode: "zero_downtime", reasons: [] };
}

export function describeStrategy(s: Strategy): string {
  return s.mode === "zero_downtime"
    ? "zero downtime: the new container starts beside the old one and takes traffic only after it is ready"
    : `stop then start (a short outage) because ${s.reasons.join("; and ")}`;
}
