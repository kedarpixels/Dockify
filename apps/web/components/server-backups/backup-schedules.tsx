"use client";

import Link from "next/link";
import { CardTitle } from "@/components/card-title";
import { Icon } from "@/components/icon";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/chip";
import { CopyButton } from "@/components/ui/copy-button";
import { EnvTag } from "@/components/ui/env-tag";
import { IconTile } from "@/components/ui/icon-tile";
import { Switch } from "@/components/ui/switch";
import { When } from "@/components/ui/when";
import { plural } from "@/lib/format";
import { useUtcAt } from "@/lib/time-prefs";
import type { BackupConfig, BackupRun, BackupSchedule, StorageProvider } from "@/lib/pages/server-backups";
import { useCan } from "@/lib/viewer";
import { Countdown } from "./live";
import { cronText, dbLabel, offServer, placeName } from "./util";

/** Where backup destinations are managed. */
export const STORAGE_HREF = "/settings?section=integrations";

const PROVIDER: Record<StorageProvider, string> = { r2: "Cloudflare R2", s3: "AWS S3", minio: "MinIO", custom: "S3-compatible" };

/**
 * Where a schedule's backups go, then whether they are encrypted: one place chip (the destination,
 * or Local only in amber) and one encryption chip. Encryption that is on before the instance key
 * exists reads Key pending, so the chip never claims more than the Storage card can show.
 */
function PlaceTags({ s }: { s: BackupSchedule }) {
  const off = offServer(s);
  const enc = s.encryption;
  return (
    <>
      {/* "Local only" needs no tip: the note over the schedules says what it means. */}
      <Chip size="xs" tone={off ? "ok" : "warn"} tip={off ? `Bucket ${s.storage!.bucket}` : undefined}>
        {off ? placeName(s.storage) : "Local only"}
      </Chip>
      {enc.enabled && !enc.fingerprint ? (
        <Chip size="xs" tone="warn" tip="The key is created with the first backup">
          Key pending
        </Chip>
      ) : (
        <Chip size="xs" icon={<Icon name={enc.enabled ? "lock" : "lockOpen"} size={12} />} tip={enc.enabled ? `Key ${enc.fingerprint}` : undefined}>
          {enc.enabled ? "Encrypted" : "Not encrypted"}
        </Chip>
      )}
    </>
  );
}

/**
 * One schedule per row inside a soft ruled box: the database and its last run, the schedule in
 * words with the cron as a small chip, retention, destination and encryption chips, the next run
 * (relative, the exact UTC time in its tip), then the shared Switch. Local only schedules raise a
 * note on top. A Viewer reads the schedules without the switch.
 */
export function Schedules({
  schedules,
  runs,
  now,
  onToggle,
}: {
  schedules: BackupSchedule[];
  runs: BackupRun[];
  now: number;
  onToggle: (s: BackupSchedule, on: boolean) => void;
}) {
  const { manage } = useCan();
  const on = schedules.filter((s) => s.enabled).length;
  const local = schedules.filter((s) => !offServer(s));
  return (
    <section className="card sb-sched" aria-labelledby="sb-sched-title">
      <div className="card-hd">
        <CardTitle id="sb-sched-title" icon="calendar" title="Schedules" sub={`${on} of ${plural(schedules.length, "database")} on, times in UTC`} />
      </div>
      {local.length ? (
        <div className="bk-note-wrap">
          <Callout
            tone="warn"
            icon="alert"
            action={
              manage ? (
                <Link href={STORAGE_HREF} className="btn btn-sm">
                  Choose storage
                </Link>
              ) : undefined
            }
          >
            <b>Not off-server.</b> {local.map((s) => dbLabel(s.database)).join(", ")} {local.length === 1 ? "keeps its" : "keep their"} backups on this
            server only. If the disk fails, they go with it.
          </Callout>
        </div>
      ) : null}
      <div className="sb-sched-wrap">
        <ul className="sb-sched-box">
          {schedules.map((s) => {
            const words = cronText(s.cron);
            const last = runs.find((r) => r.resourceId === s.resourceId && r.status !== "running");
            const lastAt = last ? (last.finishedAt ?? last.createdAt) : s.lastRunAt;
            return (
              <li key={s.id} className="sb-sched-row" data-off={!s.enabled || undefined}>
                <IconTile size="sm" className="sb-sched-tile">
                  <Icon name="database" />
                </IconTile>
                <span className="sb-sched-db two">
                  <span className="two-main">
                    <span>
                      <span className="sb-muted">{s.database.projectSlug} /</span> {s.database.name}
                    </span>
                    <EnvTag env={s.database.environment} compact quiet />
                  </span>
                  <span className={last?.status === "failed" ? "two-sub tone-bad" : "two-sub"}>
                    <When iso={lastAt} now={now} utc prefix={last?.status === "failed" ? "Last run failed" : "Last backup"} fallback="No backup yet" />
                  </span>
                </span>
                <span className="sb-sched-when">
                  {/* An expression cronText cannot read stays as the chip alone, under a plain name. */}
                  <span className="sb-sched-words">{words === s.cron ? "Custom schedule" : words}</span>
                  <span className="sb-cron" data-tip={`Cron expression, ${s.timezone}`}>
                    <Chip size="xs" className="num">
                      {s.cron}
                    </Chip>
                  </span>
                </span>
                <span className="sb-sched-tags">
                  <Chip size="xs" icon={<Icon name="history" size={12} />} className="num">
                    Keep {plural(s.retentionDays, "day")}
                  </Chip>
                  <PlaceTags s={s} />
                </span>
                <span className="sb-sched-next two">
                  {!s.enabled ? (
                    <>
                      <span className="two-main sb-muted">Paused</span>
                      <span className="two-sub">Turn on to resume</span>
                    </>
                  ) : s.nextRunAt ? (
                    <Countdown at={s.nextRunAt} serverNow={now} prefix="Next" className="two-main num" tipAlign="end" />
                  ) : (
                    <>
                      <span className="two-main sb-muted">Not planned</span>
                      <span className="two-sub">Not scheduled yet</span>
                    </>
                  )}
                </span>
                {manage ? (
                  <Switch className="sb-sched-switch" checked={s.enabled} label={`Back up ${dbLabel(s.database)} on schedule`} onChange={(v) => onToggle(s, v)} />
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/**
 * Where backups go and how they are encrypted: the destinations from Settings, Integrations, Backup
 * storage (plus this server when a schedule keeps backups local), the instance key's fingerprint,
 * and when the next automatic restore test runs.
 */
export function StorageCard({ config, schedules, now }: { config: BackupConfig; schedules: BackupSchedule[]; now: number }) {
  const utcAt = useUtcAt();
  const { manage } = useCan();
  const local = schedules.filter((s) => !offServer(s)).length;
  const using = (id: string) => schedules.filter((s) => offServer(s) && s.storage!.id === id).length;
  const enc = config.encryption;
  // The instance key is made on first use, so encryption can be on while no key exists yet.
  const sealed = !enc.enabled ? "not encrypted" : enc.fingerprint ? "encrypted" : "key pending";
  return (
    <section className="card bk-store" aria-labelledby="bk-store-title">
      <div className="card-hd">
        <CardTitle id="bk-store-title" icon="cloud" title="Storage and encryption" sub={`${plural(config.destinations.length, "destination")}, ${sealed}`} />
        {manage ? (
          <Link href={STORAGE_HREF} className="btn btn-sm">
            Manage storage
          </Link>
        ) : null}
      </div>
      <ul className="soft-list bk-store-list">
        {config.destinations.length === 0 ? (
          <li className="soft-row bk-store-row">
            <IconTile>
              <Icon name="cloud" />
            </IconTile>
            <span className="two">
              <span className="two-main">No off-server destination</span>
              <span className="two-sub">Add R2, AWS S3, MinIO or any S3-compatible bucket in Settings, Integrations, Backup storage.</span>
            </span>
            <span className="bk-store-end" />
          </li>
        ) : null}
        {config.destinations.map((d) => {
          const n = using(d.id);
          return (
            <li key={d.id} className="soft-row bk-store-row">
              <IconTile>
                <Icon name="cloud" />
              </IconTile>
              <span className="two">
                <span className="two-main bk-store-name">
                  {d.name}
                  {d.isDefault ? <Chip size="xs">Default</Chip> : null}
                </span>
                <span className="two-sub">
                  {PROVIDER[d.provider]}, bucket <span className="mono">{d.bucket}</span>
                </span>
              </span>
              <span className="bk-store-end two">
                <span className="two-main num">{n ? plural(n, "database") : "Not used yet"}</span>
                {d.error ? (
                  <span className="two-sub tone-bad">{d.error}</span>
                ) : (
                  <span className="two-sub">
                    <When iso={d.lastTestedAt} now={now} prefix="Tested" fallback="Never tested" tipAlign="end" />
                  </span>
                )}
              </span>
            </li>
          );
        })}
        {local ? (
          <li className="soft-row bk-store-row">
            <IconTile>
              <Icon name="server" />
            </IconTile>
            <span className="two">
              <span className="two-main">This server</span>
              {/* Neutral here: the note on Schedules is the one warning about it. */}
              <span className="two-sub">Local disk, not off-server</span>
            </span>
            <span className="bk-store-end two">
              <span className="two-main num">{plural(local, "database")}</span>
              <span className="two-sub">Lost with the disk</span>
            </span>
          </li>
        ) : null}
        <li className="soft-row bk-store-row">
          <IconTile>
            <Icon name={enc.enabled ? "lock" : "lockOpen"} />
          </IconTile>
          <span className="two">
            <span className="two-main">Client-side encryption</span>
            <span className={enc.enabled ? "two-sub" : "two-sub tone-warn"}>
              {enc.enabled ? (
                <>
                  {enc.algorithm}, encrypted on this server before upload
                  {enc.createdAt ? <>, key from <span className="num">{utcAt(enc.createdAt)}</span></> : null}
                </>
              ) : (
                "Off, backups leave this server readable"
              )}
            </span>
          </span>
          <span className="bk-store-end bk-fp">
            {enc.fingerprint ? (
              <>
                {/* The value is printed without its name, so the tip says what it is. */}
                <span className="mono num" data-tip="Key fingerprint">
                  {enc.fingerprint}
                </span>
                <CopyButton value={enc.fingerprint} what="key fingerprint" align="end" />
              </>
            ) : enc.enabled ? (
              <span className="tone-warn" data-tip="The key is created with the first backup" data-tip-align="end">
                No key yet
              </span>
            ) : (
              <span className="none">No key</span>
            )}
          </span>
        </li>
        <li className="soft-row bk-store-row">
          <IconTile>
            <Icon name="shieldCheck" />
          </IconTile>
          <span className="two">
            <span className="two-main">Restore tests</span>
            <span className="two-sub">
              {cronText(config.restoreTests.cron)} UTC, each database’s newest backup goes into a throwaway container
            </span>
          </span>
          <span className="bk-store-end two">
            {config.restoreTests.nextRunAt ? (
              <Countdown at={config.restoreTests.nextRunAt} serverNow={now} prefix="Next" className="two-main num" tipAlign="end" />
            ) : (
              <span className="two-main none">Not planned</span>
            )}
          </span>
        </li>
      </ul>
    </section>
  );
}
