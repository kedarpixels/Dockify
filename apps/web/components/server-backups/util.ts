import type { BackupDatabase, BackupKind, BackupStorageRef, UpdateMode } from "@/lib/pages/server-backups";

/** The update policy's choices, worded once for Settings, Updates and the Server page's Updates card. */
export const UPDATE_MODES: Array<{ value: UpdateMode; label: string }> = [
  { value: "manual", label: "Manual, notify only" },
  { value: "security", label: "Automatic, security only" },
  { value: "all", label: "Automatic, all stable releases" },
];

export const modeLabel = (mode: UpdateMode) => UPDATE_MODES.find((m) => m.value === mode)?.label ?? mode;

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n: number) => String(n).padStart(2, "0");

/** A Dockify version as it reads everywhere: "v0.9.0", whether or not the API sent the "v". */
export const v = (version: string) => (version.startsWith("v") ? version : `v${version}`);

/** Up time as d h m, never seconds: "12d 4h 7m", "3h 12m", "9m". */
function upFor(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Running time that visibly ticks: "12d 4h 7m" past a day, then "3h 12m 08s", "9m 04s", "42s".
 * Seconds are padded so the width holds still while it counts.
 */
export function upLive(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s >= 86_400) return upFor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = pad(s % 60);
  if (h) return `${h}h ${pad(m)}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${s % 60}s`;
}

/** How long until a scheduled run, read against `now`: "in 2d 4h", "in 3h 12m", "in 12m 08s", "in 42s", then "due now". */
export function dueIn(iso: string, now: number): string {
  const s = Math.floor((Date.parse(iso) - now) / 1000);
  if (s <= 0) return "due now";
  if (s >= 86_400) return `in ${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
  // Seconds only count down inside the last hour; hours away they would just flicker.
  if (s >= 3600) return `in ${upFor(s)}`;
  return `in ${upLive(s)}`;
}

/** "horseai / postgres", the way deploy rows name an app. */
/** "horseai / Main database": the service as people read it, its display name when it has one. */
export const dbLabel = (db: BackupDatabase) => `${db.projectSlug} / ${dbName(db)}`;
/** The service's own part of that label. */
export const dbName = (db: BackupDatabase) => db.displayName || db.name;

/** What the operator types to confirm a restore: "horseai/postgres". */
export const dbRef = (db: BackupDatabase) => `${db.projectSlug}/${db.name}`;

/**
 * A five field cron in plain words: "Every day at 03:00", "Every 12 hours", "Every Sunday at
 * 03:00". Anything it does not recognise comes back as the expression itself.
 */
export function cronText(cron: string): string {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return cron;
  const [mi, ho, dom, mon, dow] = f as [string, string, string, string, string];
  const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : null);
  const step = (s: string) => (/^\*\/\d+$/.test(s) ? Number(s.slice(2)) : null);
  if (mon !== "*") return cron;

  const everyMin = step(mi);
  if (everyMin && ho === "*" && dom === "*" && dow === "*") return everyMin === 1 ? "Every minute" : `Every ${everyMin} minutes`;
  const m = num(mi);
  if (m === null || m > 59) return cron;

  const anyDay = dom === "*" && dow === "*";
  if (ho === "*" && anyDay) return m ? `Every hour at :${pad(m)}` : "Every hour";
  const everyHours = step(ho);
  if (everyHours && anyDay) {
    const every = everyHours === 1 ? "Every hour" : `Every ${everyHours} hours`;
    return m ? `${every} at :${pad(m)}` : every;
  }

  const hours = /^\d+(,\d+)*$/.test(ho) ? ho.split(",").map(Number) : null;
  if (!hours || hours.some((h) => h > 23)) return cron;
  const time = hours.map((h) => `${pad(h)}:${pad(m)}`).join(" and ");

  if (anyDay) return `Every day at ${time}`;
  const wd = num(dow);
  if (dom === "*" && wd !== null && wd <= 7) return `Every ${DAYS[wd % 7]} at ${time}`;
  if (dom === "*" && dow === "1-5") return `Weekdays at ${time}`;
  if (dom === "*" && (dow === "0,6" || dow === "6,0")) return `Weekends at ${time}`;
  const md = num(dom);
  if (md !== null && dow === "*") return `Day ${md} of every month at ${time}`;
  return cron;
}

/** How each kind of run reads in the history. */
export const KIND_LABEL: Record<BackupKind, string> = {
  scheduled: "Scheduled",
  manual: "Manual",
  preDeploy: "Pre-deploy",
  preUpdate: "Pre-update",
};

/** Where a run or schedule keeps its file, in words: the destination's name, or this server. */
export const placeName = (storage: BackupStorageRef | null) => (storage ? storage.name : "This server");

/** Off-server only when an S3 destination holds it; local backups are lost with the disk. */
export const offServer = (x: { destination: string; storage: BackupStorageRef | null }) => x.destination === "s3" && x.storage !== null;

/** "horseai-postgres-restore-1030", the suggested name for a restore into a new database. */
export function restoreName(db: BackupDatabase, createdAt: string): string {
  const d = new Date(createdAt);
  const base = db.name.replace(/[^a-z0-9-]/g, "").slice(0, 24) || "db";
  return `${base}-restore-${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}
