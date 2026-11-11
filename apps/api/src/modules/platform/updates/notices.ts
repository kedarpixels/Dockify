/**
 * The bell's control-plane notices, derived from the verified feed and the last update run.
 * Nothing is stored for the bell itself; each notice id is stable so the bell can remember it was read.
 */
import type { Db } from "@dockify/db";
import { bare, chooseRelease, compareVersions, pendingSecurity } from "./release.ts";
import { storedFeed } from "./state.ts";

const RECENT_MS = 7 * 86_400_000;
const HREF = "/server#updates";

export interface SystemNotice {
  id: string;
  kind: "updateAvailable" | "updated" | "updateFailed" | "updateRolledBack";
  tone: "info" | "ok" | "bad";
  title: string;
  detail: string;
  href: string;
  at: string;
}

const v = (s: string) => `v${bare(s)}`;

/**
 * `imageVersion` is what this api's own image carries. The recorded version lags when images are
 * swapped by hand, and the bell would keep offering the release that already runs, so the newer wins.
 */
export async function updateNotices(db: Db, imageVersion: string, now = Date.now()): Promise<SystemNotice[]> {
  const [inst, last] = await Promise.all([
    db.instance.findUnique({ where: { id: 1 }, select: { releaseVersion: true, latestRelease: true, updateChannel: true, updateSkipVersion: true } }),
    db.releaseUpdate.findFirst({ where: { state: { in: ["done", "failed", "rolled_back"] } }, orderBy: { startedAt: "desc" } }),
  ]);
  const out: SystemNotice[] = [];
  const recorded = inst?.releaseVersion;
  const current = recorded && compareVersions(recorded, imageVersion) > 0 ? recorded : imageVersion;
  const feed = storedFeed(inst?.latestRelease);
  const usable = feed && feed.channel === inst?.updateChannel ? feed : null;
  const target = usable ? chooseRelease(usable, current) : null;
  // Skipping a version only holds back automatic installs, never the security alert.
  const sec = usable ? pendingSecurity(usable, current) : null;
  if (sec) {
    out.push({
      id: `security-release-${sec.version}`,
      kind: "updateAvailable",
      tone: "bad",
      title: `Important security release ${v(sec.version)}`,
      detail: sec.summary.length > 160 ? `${sec.summary.slice(0, 157)}...` : sec.summary,
      href: HREF,
      at: sec.publishedAt,
    });
  }
  // The security notice already names its release; another one for the same version would repeat it.
  if (target?.target && bare(target.target.version) !== bare(inst?.updateSkipVersion ?? "") && bare(target.target.version) !== sec?.version) {
    out.push({
      id: `update-available-${bare(target.target.version)}`,
      kind: "updateAvailable",
      tone: target.critical ? "bad" : "info",
      title: target.critical ? `Security update available: ${v(target.target.version)}` : `Update available: ${v(target.target.version)}`,
      detail: `You run ${v(current)}. Signed release on the ${feed!.channel} channel.`,
      href: HREF,
      at: target.target.publishedAt,
    });
  }
  if (last?.finishedAt && now - last.finishedAt.getTime() < RECENT_MS) {
    const at = last.finishedAt.toISOString();
    const rollback = last.kind === "rollback";
    if (last.state === "done") {
      out.push({ id: `update-${last.id}`, kind: "updated", tone: "ok", title: rollback ? `Rolled back to ${v(last.version)}` : `Updated to ${v(last.version)}`, detail: `From ${v(last.fromVersion)}`, href: HREF, at });
    } else if (last.state === "rolled_back") {
      out.push({ id: `update-${last.id}`, kind: "updateRolledBack", tone: "bad", title: `Update failed, rolled back to ${v(last.fromVersion)}`, detail: (last.error ?? `The update to ${v(last.version)} did not pass`).slice(0, 200), href: HREF, at });
    } else {
      out.push({ id: `update-${last.id}`, kind: "updateFailed", tone: "bad", title: `Update to ${v(last.version)} failed`, detail: (last.error ?? "See the Server page").slice(0, 200), href: HREF, at });
    }
  }
  return out;
}
