/**
 * Daily uptime minutes per app (app_uptime_days), for the public status page bars and the overview
 * health strip. Once a minute every app that should be running gets one sampled minute, plus a down
 * minute (no running container, or its route unreachable through the proxy) or a degraded minute
 * (running but unhealthy or restarting).
 */
import type { Db } from "@dockify/db";
import { appsHere } from "../server/apps-here.ts";
import type { ReachState } from "./reach.ts";
import type { SamplerState } from "./sampler.ts";

export type MinuteState = "up" | "degraded" | "down";

/** A reachability verdict older than this no longer speaks for the current minute. */
export const REACH_FRESH_MS = 3 * 60_000;

export function minuteState(c: { state: string; health: string | null } | undefined, reach?: { ok: boolean; at: number }, now = Date.now()): MinuteState {
  if (!c) return "down";
  // The container runs, but a visitor gets a gateway error: that minute was down for them.
  if (c.state === "running" && reach && !reach.ok && now - reach.at <= REACH_FRESH_MS) return "down";
  if (c.state === "restarting" || (c.state === "running" && c.health === "unhealthy")) return "degraded";
  return c.state === "running" ? "up" : "down";
}

export const utcDay = (ms: number): Date => new Date(Math.floor(ms / 86_400_000) * 86_400_000);

export async function recordUptimeMinute(db: Db, serverId: string, state: SamplerState, now = Date.now(), reach?: ReachState): Promise<number> {
  if (!state.dockerSeen) return 0;
  const apps = await db.app.findMany({
    where: { desiredState: "running", deployTarget: "server", currentDeploymentId: { not: null }, status: { not: "deploying" }, ...appsHere(serverId) },
    select: { id: true },
  });
  const day = utcDay(now);
  for (const a of apps) {
    const s = minuteState(state.apps.get(a.id), reach?.get(a.id), now);
    await db.appUptimeDay.upsert({
      where: { appId_day: { appId: a.id, day } },
      create: { appId: a.id, day, sampledMinutes: 1, downMinutes: s === "down" ? 1 : 0, degradedMinutes: s === "degraded" ? 1 : 0 },
      update: {
        sampledMinutes: { increment: 1 },
        ...(s === "down" ? { downMinutes: { increment: 1 } } : {}),
        ...(s === "degraded" ? { degradedMinutes: { increment: 1 } } : {}),
      },
    });
  }
  // Kept 400 days (the model comment).
  await db.appUptimeDay.deleteMany({ where: { day: { lt: utcDay(now - 400 * 86_400_000) } } });
  return apps.length;
}
