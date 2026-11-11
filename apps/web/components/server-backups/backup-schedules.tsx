"use client";

import Link from "next/link";
import { CardTitle } from "@/components/card-title";
import { Icon } from "@/components/icon";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/chip";
import { CopyButton } from "@/components/ui/copy-button";
import { EnvTag } from "@/components/ui/env-tag";
import { IconTile } from "@/components/ui/icon-tile";
import { When } from "@/components/ui/when";
import { plural } from "@/lib/format";
import { useUtcAt } from "@/lib/time-prefs";
import type { BackupConfig, BackupRun, BackupSchedule, BackupTierSchedule, StorageProvider } from "@/lib/pages/server-backups";
import { useCan } from "@/lib/viewer";
import { heldNoun, isVolumes, listNoun } from "./history";
import { Countdown } from "./live";
import { lastOf, lastWord, TIER_LABEL, TIERS, tierWords } from "./tier-schedule";
import { cronText, dbLabel, dbName } from "./util";

export const STORAGE_HREF = "/settings?section=integrations";

const PROVIDER: Record<StorageProvider, string> = { r2: "Cloudflare R2", s3: "AWS S3", minio: "MinIO", custom: "S3-compatible" };

/** Reads Key pending before the instance key exists. */
function SealChip({ s }: { s: BackupSchedule }) {
  const enc = s.encryption;
  const { manage } = useCan();
  // A Viewer is never sent the fingerprint, so its absence says nothing about the key.
  return enc.enabled && !enc.fingerprint && manage ? (
    <Chip size="xs" tone="warn" tip="The key is created with the first backup">
      Key pending
    </Chip>
  ) : (
    <Chip size="xs" icon={<Icon name={enc.enabled ? "lock" : "lockOpen"} size={12} />} tip={enc.enabled && enc.fingerprint ? `Key ${enc.fingerprint}` : undefined}>
      {enc.enabled ? "Encrypted" : "Not encrypted"}
    </Chip>
  );
}

function TierLine({ s, t, runs, now }: { s: BackupSchedule; t: BackupTierSchedule; runs: BackupRun[]; now: number }) {
  const last = lastOf(runs, s.resourceId, t.tier);
  const words = cronText(t.cron);
  return (
    <span className="bk-tier-line" data-off={!t.enabled || undefined}>
      <span className="bk-tier-name">{TIER_LABEL[t.tier]}</span>
      <span className="bk-tier-what two">
        {t.enabled ? (
          <>
            <span className="two-main" title={words === t.cron ? `Cron ${t.cron}, ${t.timezone}` : `${t.cron}, ${t.timezone}`}>
              {tierWords(t)}
            </span>
            <span className={last?.status === "failed" ? "two-sub tone-bad" : "two-sub"}>
              <When iso={last ? (last.finishedAt ?? last.createdAt) : null} now={now} utc prefix={lastWord(last) ?? undefined} fallback="No backup yet" />
            </span>
          </>
        ) : (
          <span className="two-main sb-muted">Off</span>
        )}
      </span>
      <span className="bk-tier-place">
        {!t.enabled ? null : t.tier === "local" ? (
          <Chip size="xs">This server</Chip>
        ) : t.storage ? (
          <Chip size="xs" tone="ok" tip={t.storage.bucket ? `Bucket ${t.storage.bucket}` : undefined}>
            {t.storage.name}
          </Chip>
        ) : (
          <Chip size="xs" tone="warn">
            No storage
          </Chip>
        )}
      </span>
      <span className="bk-tier-next">
        {t.enabled && t.nextRunAt ? <Countdown at={t.nextRunAt} serverNow={now} prefix="Next" className="num" tipAlign="end" /> : null}
      </span>
    </span>
  );
}

/** A Viewer reads the schedules without Edit. */
export function Schedules({
  schedules,
  runs,
  now,
  hasStorage,
  onEdit,
}: {
  schedules: BackupSchedule[];
  runs: BackupRun[];
  now: number;
  /** Whether any S3 destination exists, which decides the step the note asks for. */
  hasStorage: boolean;
  onEdit: (s: BackupSchedule) => void;
}) {
  const { manage } = useCan();
  const on = schedules.filter((s) => s.enabled).length;
  // Copies made here while none go offsite: the offsite tier is off, or on with its storage gone.
  const local = schedules.filter((s) => s.tiers.local.enabled && !(s.tiers.offsite.enabled && s.tiers.offsite.available));
  return (
    <section className="card sb-sched" aria-labelledby="sb-sched-title">
      <div className="card-hd">
        <CardTitle id="sb-sched-title" icon="calendar" title="Schedules" sub={`${on} of ${plural(schedules.length, listNoun(schedules))} on, times in UTC`} />
      </div>
      {local.length ? (
        <div className="bk-note-wrap">
          <Callout
            tone="warn"
            icon="alert"
            action={
              manage && !hasStorage ? (
                <Link href={STORAGE_HREF} className="btn btn-sm">
                  Add storage
                </Link>
              ) : manage && local.length === 1 ? (
                <button type="button" className="btn btn-sm" onClick={() => onEdit(local[0]!)}>
                  Turn on offsite
                </button>
              ) : undefined
            }
          >
            <b>Not off-server.</b> {local.map((s) => dbLabel(s.database)).join(", ")} {local.length === 1 ? "keeps its" : "keep their"} backups on this
            server only. If the disk fails, they go with it.{" "}
            {hasStorage
              ? `Turn on the Offsite tier of ${local.length === 1 ? `this ${heldNoun(local[0]!)}` : "each"} with Edit to keep copies elsewhere.`
              : "Add S3 compatible storage in Settings, Integrations, then turn on the Offsite tier to keep copies elsewhere."}
          </Callout>
        </div>
      ) : null}
      <div className="sb-sched-wrap">
        <ul className="sb-sched-box">
          {schedules.map((s) => (
            <li key={s.id} className="sb-sched-row bk-sched-row" data-off={!s.enabled || undefined}>
              <IconTile size="sm" className="sb-sched-tile">
                <Icon name={isVolumes(s) ? "folder" : "database"} />
              </IconTile>
              <span className="sb-sched-db two">
                <span className="two-main">
                  <span>
                    <span className="sb-muted">{s.database.projectSlug} /</span> {dbName(s.database)}
                  </span>
                  <EnvTag env={s.database.environment} project={s.database.projectSlug} compact quiet />
                </span>
                <span className="two-sub">
                  <SealChip s={s} />
                </span>
              </span>
              <span className="bk-tiers">
                {TIERS.map((k) => (
                  <TierLine key={k} s={s} t={s.tiers[k]} runs={runs} now={now} />
                ))}
              </span>
              {manage ? (
                <button type="button" className="btn btn-sm bk-sched-edit" aria-label={`Edit the backup schedule of ${dbLabel(s.database)}`} onClick={() => onEdit(s)}>
                  Edit
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function StorageCard({ config, schedules, now }: { config: BackupConfig; schedules: BackupSchedule[]; now: number }) {
  const utcAt = useUtcAt();
  const { manage } = useCan();
  const local = schedules.filter((s) => s.tiers.local.enabled).length;
  const using = (id: string) => schedules.filter((s) => s.tiers.offsite.enabled && s.tiers.offsite.storage?.id === id).length;
  const enc = config.encryption;
  // The instance key is made on first use, so encryption can be on while no key exists yet.
  // Destinations and the fingerprint are an admin's: a Viewer reads only that backups are encrypted.
  const sealed = !enc.enabled ? "not encrypted" : enc.fingerprint || !manage ? "encrypted" : "key pending";
  return (
    <section className="card bk-store" aria-labelledby="bk-store-title">
      <div className="card-hd">
        <CardTitle id="bk-store-title" icon="cloud" title="Storage and encryption" sub={manage ? `${plural(config.destinations.length, "destination")}, ${sealed}` : sealed.charAt(0).toUpperCase() + sealed.slice(1)} />
        {manage ? (
          <Link href={STORAGE_HREF} className="btn btn-sm">
            Manage storage
          </Link>
        ) : null}
      </div>
      <ul className="soft-list bk-store-list">
        {manage && config.destinations.length === 0 ? (
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
                <span className="two-main num">{n ? plural(n, listNoun(schedules)) : "Not used yet"}</span>
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
              <span className="two-main num">{plural(local, listNoun(schedules))}</span>
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
              manage ? (
                <span className="tone-warn" data-tip="The key is created with the first backup" data-tip-align="end">
                  No key yet
                </span>
              ) : null
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
              {cronText(config.restoreTests.cron)} UTC, the newest backup of each {listNoun(schedules)} goes into a throwaway container
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
