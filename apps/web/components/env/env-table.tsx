"use client";

import { useId, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/icon";
import { ENV_KEY } from "@/components/project-detail/dotenv";
import { isPublicBuildKey, TARGET_LABEL, TARGET_SHORT, type RowState } from "@/components/project-extras/env-model";
import { RefChip } from "@/components/project-extras/env-refs";
import { RowMenu } from "@/components/project-extras/row-menu";
import { Chip } from "@/components/ui/chip";
import { CopyButton } from "@/components/ui/copy-button";
import { cx } from "@/components/ui/cx";
import { TextInput } from "@/components/ui/field";
import { PendingButton } from "@/components/ui/pending";
import { MaskDots } from "@/components/ui/secret";
import { Select, type SelectOption } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { When } from "@/components/ui/when";
import type { EnvTarget } from "@/lib/pages/project-detail";

// A secret, or what a link resolves to, is fetched by the caller through the audited reveal; copy
// never unmasks the row. The column head is hidden from screen readers; each cell names its column instead.

export const TARGET_OPTIONS: SelectOption<EnvTarget>[] = (["runtime", "build", "both"] as const).map((value) => ({ value, label: TARGET_LABEL[value] }));

const TAG: Record<Exclude<RowState, "same">, { label: string; tone: "ok" | "warn" | "bad" }> = {
  added: { label: "New", tone: "ok" },
  changed: { label: "Edited", tone: "warn" },
  removed: { label: "Removed", tone: "bad" },
};

export interface Draft {
  key: string;
  /** Undefined keeps the stored value: a secret whose value was never revealed. */
  value: string | undefined;
  secret: boolean;
  target: EnvTarget;
}

/** What a linked row's third key does: open the project's Variables tab, or a menu with Unlink and Remove. */
export type LinkEdit = { href: string } | { onUnlink: () => void; onRemove: () => void };

const rowClass = (targets: boolean, extra?: string) => cx("ev-var", targets && "ev-var-t", extra);

/** An app named above its rows in the project overrides table, where a column would cut a long name. */
export function EnvGroupHead({ name, icon, count }: { name: string; icon: React.ReactNode; count?: string }) {
  return (
    <li className="ev-group">
      {icon}
      <span className="ev-group-name">{name}</span>
      {count ? <span className="ev-group-count">{count}</span> : null}
    </li>
  );
}

export function EnvTableHead({ targets = false }: { targets?: boolean }) {
  return (
    <div className={rowClass(targets, "ev-var-head")} aria-hidden="true">
      <span>Key</span>
      <span>Value</span>
      {targets ? <span>Used at</span> : null}
      <span className="ev-var-when">Updated</span>
      <span />
    </div>
  );
}

/** "Both" names both stages in its tip and to screen readers. */
function TargetMark({ target }: { target: EnvTarget }) {
  const full = TARGET_LABEL[target];
  const short = TARGET_SHORT[target];
  if (short === full) {
    return (
      <span className="ev-target" data-target={target}>
        {short}
      </span>
    );
  }
  return (
    <span className="ev-target" data-target={target} data-tip={full}>
      <span aria-hidden="true">{short}</span>
      <span className="sr">{full}</span>
    </span>
  );
}

export function EnvVarRow({
  rowId,
  name,
  secret,
  state = "same",
  target,
  updatedAt,
  now,
  shown,
  value,
  revealing,
  note,
  link,
  linkEdit,
  onReveal,
  onCopy,
  onEdit,
  onUndo,
}: {
  /** Names the row in the page (`data-row`), so focus can land back on its keys after an edit. */
  rowId?: string;
  name: string;
  secret: boolean;
  state?: RowState;
  /** Set, the row has a "used at" column. */
  target?: EnvTarget;
  /** Null while the row is staged. */
  updatedAt: string | null;
  now: number;
  shown: boolean;
  /** The row's own value, or the one fetched through reveal. Null while unknown. */
  value: string | null;
  revealing: boolean;
  /** A muted tag beside the value, such as "Overrides shared". */
  note?: string;
  /** The chip of a linked row: "horseai/postgres, DATABASE_URL". */
  link?: { text: string; missing?: boolean };
  linkEdit?: LinkEdit;
  onReveal: () => void;
  /** Rejects when the value cannot be read, so the key reads "Copy failed". */
  onCopy: () => Promise<string>;
  onEdit: () => void;
  /** Set when the row can only be undone: a staged removal, or a link staged in this session. */
  onUndo?: () => void;
}) {
  const tag = state === "same" ? null : TAG[state];
  const removed = state === "removed";
  const what = link ? `the value ${name} resolves to` : name;
  const targets = target !== undefined;
  const masked = !link && (!shown || value === null);

  let edit: React.ReactNode;
  // A row edited elsewhere (a shared row on an app's tab, or a link) points to where it is edited.
  if (linkEdit && "href" in linkEdit) {
    edit = (
      <Link href={linkEdit.href} className="btn btn-xs btn-icon" aria-label={`Edit ${name} in the project variables`} data-tip="Edit in project" data-tip-align="end">
        <Icon name="edit" />
      </Link>
    );
  } else if (link && linkEdit && "onUnlink" in linkEdit) {
    edit = (
      <RowMenu
        label={`More for ${name}`}
        items={[
          { label: "Unlink", icon: "link", onSelect: linkEdit.onUnlink, disabled: link.missing },
          { label: "Remove", icon: "trash", onSelect: linkEdit.onRemove, bad: true },
        ]}
      />
    );
  } else {
    edit = (
      <button type="button" className="btn btn-xs btn-icon" aria-label={`Edit ${name}`} onClick={onEdit}>
        <Icon name="edit" />
      </button>
    );
  }

  return (
    <li className={rowClass(targets)} data-state={state} data-row={rowId}>
      <span className="ev-var-key">
        <span className="ev-var-keytext">{name}</span>
        {secret ? <Icon name="lock" size={14} className="ev-var-lock" label="Secret" /> : null}
        {tag ? (
          <Chip size="xs" tone={tag.tone}>
            {tag.label}
          </Chip>
        ) : null}
      </span>
      <span className="ev-var-val">
        <span className="sr">{masked ? "Value hidden" : "Value, "}</span>
        {link ? (
          <span className="px-ref-cell">
            <RefChip text={link.text} missing={link.missing} />
            {link.missing ? <span className="px-ref-note">Link it again or remove it before the next deploy</span> : null}
            {shown && value ? <span className="ev-var-text">{value}</span> : null}
          </span>
        ) : masked ? (
          <MaskDots />
        ) : value ? (
          <span className="ev-var-text">{value}</span>
        ) : (
          <span className="none">Empty</span>
        )}
        {note && !tag ? (
          <Chip size="xs" className="ev-var-note">
            {note}
          </Chip>
        ) : null}
      </span>
      {targets ? (
        <span className="ev-var-target">
          <span className="sr">Used at, </span>
          <TargetMark target={target} />
        </span>
      ) : null}
      <span className="ev-var-when num">
        <span className="sr">Updated, </span>
        {updatedAt ? <When iso={updatedAt} now={now} tipAlign="end" /> : <span className="none">{removed ? "On apply" : "Pending"}</span>}
      </span>
      <span className="ev-var-acts">
        {onUndo ? (
          <button type="button" className="btn btn-xs" onClick={onUndo}>
            Undo
          </button>
        ) : (
          <>
            {/* One name with a pressed state. */}
            <PendingButton
              className="btn btn-xs btn-icon"
              aria-label={`Show ${what}`}
              aria-pressed={shown}
              pending={revealing}
              icon={shown ? "eyeOff" : "eye"}
              disabled={link?.missing}
              onClick={onReveal}
            />
            <CopyButton value={onCopy} what={what} disabled={link?.missing} />
            {edit}
          </>
        )}
      </span>
    </li>
  );
}

function keyError(key: string, taken: string[]) {
  if (!key) return "Enter a key";
  if (key.length > 128) return "Keep keys under 128 characters";
  if (!ENV_KEY.test(key)) return "Use letters, numbers and underscores, not starting with a number";
  if (taken.includes(key)) return `${key} is already set here, edit it instead`;
  return null;
}

/** Enter saves, Escape cancels. With `staged`, nothing is sent until Review applies it. */
export function EnvEditRow({
  mode,
  initial,
  knownValue = true,
  taken,
  targets = false,
  staged = false,
  busy = false,
  onSave,
  onCancel,
  onDelete,
}: {
  mode: "add" | "edit";
  initial: Draft;
  /** False for a secret whose value was never revealed: the field starts empty and keeps it unless typed in. */
  knownValue?: boolean;
  taken: string[];
  targets?: boolean;
  staged?: boolean;
  busy?: boolean;
  onSave: (d: Draft) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [d, setD] = useState(initial);
  // A new key that a bundler reads for the browser is public by nature: it starts plain, until the switch is touched.
  const secretTouched = useRef(false);
  const [tried, setTried] = useState(false);
  const errId = useId();
  const key = d.key.trim();
  const error = mode === "add" ? keyError(key, taken) : null;
  // Only validation shows in the row; a failed write is a toast.
  const shown = tried ? error : null;
  const verb = staged ? { save: "Stage change", tip: "Stage, Enter", del: "Remove" } : { save: "Save", tip: "Save, Enter", del: "Delete" };

  const save = () => {
    setTried(true);
    if (error || busy) return;
    onSave({ ...d, key, value: mode === "add" ? (d.value ?? "") : d.value });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === "Enter" && !e.shiftKey && e.target instanceof HTMLInputElement) {
      e.preventDefault();
      save();
    }
  };

  return (
    <li className={rowClass(targets, "ev-var-edit")} onKeyDown={onKey}>
      <span className="ev-var-key">
        {mode === "add" ? (
          <TextInput
            aria-label="Key"
            data-size="sm"
            invalid={Boolean(shown)}
            aria-describedby={shown ? errId : undefined}
            value={d.key}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            maxLength={128}
            placeholder="API_KEY"
            onChange={(e) => setD((x) => {
              const key = e.target.value.toUpperCase().replace(/\s/g, "_");
              return { ...x, key, secret: secretTouched.current ? x.secret : !isPublicBuildKey(key) };
            })}
          />
        ) : (
          <span className="ev-var-keytext">{initial.key}</span>
        )}
      </span>
      <span className="ev-var-val">
        <TextInput
          aria-label={`Value of ${key || "the new variable"}`}
          data-size="sm"
          value={d.value ?? ""}
          autoFocus={mode === "edit"}
          autoComplete="off"
          spellCheck={false}
          placeholder={knownValue ? "Value" : "Unchanged, type to replace"}
          onChange={(e) => setD((x) => ({ ...x, value: !knownValue && e.target.value === "" ? undefined : e.target.value }))}
        />
      </span>
      {targets ? (
        <span className="ev-var-target">
          <Select size="sm" label={`Where ${key || "the variable"} is used`} value={d.target} options={TARGET_OPTIONS} onChange={(target) => setD((x) => ({ ...x, target }))} />
        </span>
      ) : null}
      <span className="ev-var-when ev-var-secret">
        <Switch
          checked={d.secret}
          onChange={(secret) => {
            secretTouched.current = true;
            setD((x) => ({ ...x, secret }));
          }}
          label="Secret"
        />
        <span aria-hidden="true">Secret</span>
      </span>
      <span className="ev-var-acts">
        <PendingButton className="btn btn-xs btn-icon btn-primary" aria-label={verb.save} data-tip={verb.tip} pending={busy} icon="check" onClick={save} />
        <button type="button" className="btn btn-xs btn-icon" aria-label="Cancel" data-tip="Cancel, Esc" onClick={onCancel}>
          <Icon name="close" />
        </button>
        {onDelete ? (
          <button
            type="button"
            className="btn btn-xs btn-icon btn-quiet-danger"
            aria-label={`${verb.del} ${initial.key}`}
            disabled={busy}
            onClick={onDelete}
          >
            <Icon name="trash" />
          </button>
        ) : (
          <span className="ev-var-gap" aria-hidden="true" />
        )}
      </span>
      {shown ? (
        <p id={errId} className="ev-var-err" role="alert">
          {shown}
        </p>
      ) : null}
    </li>
  );
}
