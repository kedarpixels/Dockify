"use client";

import { useState } from "react";
import { Icon } from "@/components/icon";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { envName } from "@/components/ui/env-tag";
import { Field, TextInput } from "@/components/ui/field";
import { bytes, plural } from "@/lib/format";
import { useUtcAt } from "@/lib/time-prefs";
import type { BackupRun, BackupSchedule, RestoreRequest } from "@/lib/pages/server-backups";
import { NEW_DB_NAME, isOrphan } from "@/lib/pages/server-backups-shared";
import { isVolumes, listNoun } from "./history";
import { backUpPlaces } from "./tier-schedule";
import { dbLabel, dbName, dbRef, placeName, restoreName } from "./util";
import { hasReservedPrefix, isReservedServiceName, RESERVED_NAME_MESSAGE, RESERVED_SERVICE_MESSAGE } from "@/lib/validation";

// Backups run on UTC schedules, so every absolute time in these dialogs reads in UTC.

export function testLine(r: BackupRun): string {
  const t = r.restoreTest;
  if (t.status === "passed") return `Passed${t.tables !== null ? `, ${plural(t.tables, "table")}` : ""}${t.rows !== null ? `, ${plural(t.rows, "row")}` : ""}${t.files != null ? `, ${plural(t.files, "file")}` : ""}`;
  if (t.status === "failed") return `Failed, ${t.error ?? "the restore did not match the backup"}`;
  if (t.status === "running") return "Running now";
  return "Not tested";
}

/**
 * Replacing the live database, or an app's files, sits behind a typed confirm. A backup of volumes only
 * restores over its app. Mounted once per opened run, so every field starts fresh.
 */
export function RestoreDialog({ run, onClose, onConfirm }: { run: BackupRun; onClose: () => void; onConfirm: (r: BackupRun, req: RestoreRequest) => void }) {
  const utcAt = useUtcAt();
  const orphan = isOrphan(run);
  const files = isVolumes(run);
  const [mode, setMode] = useState<RestoreRequest["mode"]>(files ? "replace" : "new");
  const [name, setName] = useState(() => restoreName(run.database, run.createdAt));
  const [typed, setTyped] = useState("");
  const [tried, setTried] = useState(false);
  const ref = dbRef(run.database);
  const label = dbLabel(run.database);
  const stamp = utcAt(run.createdAt);

  const nameError = !NEW_DB_NAME.test(name)
    ? "Use lowercase letters, numbers and hyphens, 2 to 40 characters, starting with a letter"
    : hasReservedPrefix(name)
      ? RESERVED_NAME_MESSAGE
      : isReservedServiceName(name)
      ? RESERVED_SERVICE_MESSAGE
      : name === run.database.name && !orphan
      ? "That is the live database. Pick another name."
      : null;
  const ready = mode === "new" ? nameError === null : typed.trim() === ref;

  const submit = () => {
    if (!ready) {
      setTried(true);
      return;
    }
    onConfirm(run, mode === "new" ? { mode, name } : { mode, confirm: typed.trim() });
  };

  const modes: Array<{ value: RestoreRequest["mode"]; title: string; sub: string }> = files
    ? [{ value: "replace", title: "Replace the app's files", sub: `Overwrites the volumes of ${label}. Files written after ${stamp} are lost.` }]
    : [
        { value: "new", title: "Into a new database", sub: `Creates ${run.database.projectSlug} / ${name || "new database"} from this backup. Nothing live changes.` },
        ...(orphan ? [] : [{ value: "replace" as const, title: "Replace the live database", sub: `Overwrites ${label}. Writes after ${stamp} are lost.` }]),
      ];

  return (
    <Dialog
      open
      onClose={onClose}
      title="Restore backup"
      sub={`${label}, ${stamp}`}
      icon="rollback"
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          {/* Never disabled: a press with the name not typed yet says what is missing instead. */}
          {mode === "new" ? (
            <button type="submit" className="btn btn-primary">
              <Icon name="rollback" />
              Restore into new database
            </button>
          ) : (
            <button type="submit" className="btn btn-danger">
              <Icon name="rollback" />
              {files ? "Replace files" : "Replace database"}
            </button>
          )}
        </>
      }
    >
      {modes.length > 1 ? (
        <fieldset className="sb-choices">
          <legend className="fld-label">Where to restore</legend>
          {modes.map((m) => (
            <label key={m.value} className="soft-row sb-choice bk-mode">
              <input type="radio" className="radio" name="bk-mode" value={m.value} checked={mode === m.value} onChange={() => setMode(m.value)} />
              <span className="two">
                <span className="two-main">{m.title}</span>
                <span className="two-sub">{m.sub}</span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="dlg-text">
          {files
            ? "A backup of volumes restores over the app it came from. The app is stopped while its volumes are emptied and filled, then started again."
            : "This service was deleted, so its backups restore into a new database only."}
        </p>
      )}

      {mode === "new" ? (
        <Field
          label="New database name"
          hint={`Created in ${run.database.projectSlug} / ${envName(run.database.environment)}. Its connection URL shows on the new service.`}
          error={tried ? nameError : null}
        >
          {(ids) => <TextInput ids={ids} value={name} onChange={(e) => setName(e.target.value.toLowerCase())} spellCheck={false} autoComplete="off" data-autofocus />}
        </Field>
      ) : (
        <>
          <Callout tone="bad" icon="alert">
            This replaces {files ? "every file in the volumes of" : "all current data in"} <b>{label}</b> with the backup from {stamp}. Anything
            written after that time is lost and cannot be brought back.
          </Callout>
          <Field label={<>Type <b className="dlg-confirm-name">{ref}</b> to confirm</>} error={tried && typed.trim() !== ref ? `Type ${ref} exactly to replace the ${files ? "files" : "database"}` : null}>
            {(ids) => <TextInput ids={ids} value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} autoComplete="off" data-autofocus />}
          </Field>
        </>
      )}

      <dl className="sb-dlg-facts">
        <div>
          <dt>Backup</dt>
          <dd className="num">
            {bytes(run.sizeBytes ?? 0)}, {run.tier === "offsite" ? `offsite in ${placeName(run.storage)}${run.storage ? `, bucket ${run.storage.bucket}` : ""}` : "on this server"}
          </dd>
        </div>
        <div>
          <dt>Encryption</dt>
          <dd className="num">{run.encryption.enabled ? `Encrypted, key ${run.encryption.fingerprint ?? "unknown"}` : "Not encrypted"}</dd>
        </div>
        <div>
          <dt>Tested</dt>
          <dd className={run.restoreTest.status === "failed" ? "tone-bad" : undefined}>{testLine(run)}</dd>
        </div>
      </dl>
    </Dialog>
  );
}

/** Mounted only while open: the choice is set once on open, so a refresh mid flow never undoes it. */
export function RunDialog({ onClose, schedules, onConfirm }: { onClose: () => void; schedules: BackupSchedule[]; onConfirm: (pick: string) => void }) {
  const [pick, setPick] = useState(() => (schedules.some((s) => s.enabled) ? "all" : (schedules[0]?.resourceId ?? "all")));
  const enabled = schedules.filter((s) => s.enabled).length;

  const choices: Array<{ value: string; label: React.ReactNode; meta: string }> = [
    ...(enabled ? [{ value: "all", label: `Every enabled ${listNoun(schedules)}`, meta: plural(enabled, listNoun(schedules)) }] : []),
    ...schedules.map((s) => ({
      value: s.resourceId,
      label: (
        <>
          <span className="sb-muted">{s.database.projectSlug} /</span> {dbName(s.database)}
        </>
      ),
      meta: ((w) => w.charAt(0).toUpperCase() + w.slice(1))(backUpPlaces(s)),
    })),
  ];

  return (
    <Dialog
      open
      onClose={onClose}
      icon="archive"
      title="Back up now"
      sub="Runs a backup outside the schedule"
      size="sm"
      onSubmit={() => onConfirm(pick)}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            <Icon name="archive" />
            Start backup
          </button>
        </>
      }
    >
      <fieldset className="sb-choices">
        <legend className="fld-label">What to back up</legend>
        {choices.map((c) => (
          <label key={c.value} className="soft-row sb-choice">
            <input type="radio" className="radio" name="sb-run" value={c.value} checked={pick === c.value} onChange={() => setPick(c.value)} />
            <span className="sb-choice-label ellipsis">{c.label}</span>
            <span className="sb-choice-meta num">{c.meta}</span>
          </label>
        ))}
      </fieldset>
    </Dialog>
  );
}

export function DeleteOrphansDialog({
  runs,
  onClose,
  onConfirm,
  returnFocus,
}: {
  runs: BackupRun[];
  onClose: () => void;
  onConfirm: (resourceId: string) => Promise<void>;
  /** Where focus goes once the deleted group, and the key that opened this, are gone. */
  returnFocus?: () => HTMLElement | null;
}) {
  const first = runs[0]!;
  const kept = runs.filter((r) => !r.expired);
  const size = kept.reduce((n, r) => n + (r.sizeBytes ?? 0), 0);
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      tone="danger"
      title="Delete backups"
      sub={dbLabel(first.database)}
      confirmLabel={`Delete ${plural(runs.length, "backup")}`}
      confirmIcon="trash"
      confirmText={dbRef(first.database)}
      onConfirm={() => onConfirm(first.resourceId)}
      returnFocus={returnFocus}
      body={
        <>
          <p className="dlg-text">
            This deletes {plural(runs.length, "backup")} of {dbLabel(first.database)}, {bytes(size)} on {placeName(first.storage)}. The service was
            deleted, so these are the last copies of its data.
          </p>
          <p className="sb-dlg-note">{isVolumes(first) ? "Download one first if you might need it." : "Restore one into a new database first if you might need it."}</p>
        </>
      }
    />
  );
}
