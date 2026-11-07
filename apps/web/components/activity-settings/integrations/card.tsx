"use client";

import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/icon";
import { Callout } from "@/components/ui/callout";
import { StatusChip } from "@/components/ui/chip";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Empty } from "@/components/ui/empty";
import { Field, TextInput } from "@/components/ui/field";
import { IconTile } from "@/components/ui/icon-tile";
import { PendingButton } from "@/components/ui/pending";
import { MaskDots, Secret } from "@/components/ui/secret";
import { clause } from "@/lib/format";
import type { IntegrationStatus } from "@/lib/pages/integrations";
import { useCan } from "@/lib/viewer";
import { intFetch } from "./client";

/* The pieces every integration and its dialogs share: the integration row, its status chip, a
   stored secret's hint, the facts grid, the form and manage dialog parts, and the state of a
   card that lists things. */

const STATUS: Record<IntegrationStatus, { label: string; tone: "ok" | "idle" | "bad" }> = {
  connected: { label: "Connected", tone: "ok" },
  disconnected: { label: "Not connected", tone: "idle" },
  error: { label: "Error", tone: "bad" },
};

/** The integration's state, as every status column reads: the shared status chip. */
function Status({ status }: { status: IntegrationStatus }) {
  const s = STATUS[status];
  return <StatusChip tone={s.tone}>{s.label}</StatusChip>;
}

/**
 * One integration as a ruled settings row: a 32px tile, the name over what is connected (its
 * purpose until something is), then the status chip and the keys on the shared right edge. A long
 * status wraps inside its own row and never stretches the others. Narrow columns put the chip and
 * keys under the text, as every settings row does.
 */
export function IntegrationCard({
  id,
  icon,
  name,
  purpose,
  status,
  meta,
  children,
}: {
  id: string;
  icon: IconName;
  name: string;
  purpose: string;
  status: IntegrationStatus;
  /** What is connected, or what went wrong; the purpose shows until there is something to say. */
  meta?: React.ReactNode;
  /** The keys: Connect, or Manage. A Viewer gets none: every integration change is an admin's. */
  children: React.ReactNode;
}) {
  const { manage } = useCan();
  return (
    <li className="set-row set-row-lead" aria-labelledby={id}>
      <span className="set-row-pic">
        <IconTile size="md">
          <Icon name={icon} />
        </IconTile>
      </span>
      <span className="two">
        <h3 id={id} className="two-main int-item-name">
          {name}
        </h3>
        <span className="two-sub int-item-sub">{meta ?? purpose}</span>
      </span>
      <span className="set-ctl">
        <Status status={status} />
        {manage ? children : null}
      </span>
    </li>
  );
}

/** A stored secret: never revealable from the browser, so only its mask and last four show. */
export function Hint({ hint, what }: { hint: string; what: string }) {
  return (
    <Secret
      what={what}
      copy={false}
      className="int-hint"
      mask={
        <>
          <MaskDots />
          {hint ? <span className="int-hint-tail">{hint}</span> : null}
        </>
      }
    />
  );
}

/** Label over value pairs in a two-column grid, one column on phones. */
export function Facts({ items }: { items: Array<{ label: string; value: React.ReactNode }> }) {
  return (
    <dl className="int-facts">
      {items.map((f) => (
        <div key={f.label} className="kv">
          <dt className="kv-label">{f.label}</dt>
          <dd className="kv-value">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A two-line row in an integration dialog: a tile, the name and its sub line, then keys. */
export function ItemRow({ icon, title, sub, children }: { icon: IconName; title: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <li className="soft-row int-row" data-hover="true">
      <IconTile>
        <Icon name={icon} />
      </IconTile>
      <span className="two">
        <span className="two-main int-row-title">{title}</span>
        {sub ? <span className="two-sub">{sub}</span> : null}
      </span>
      {children ? <span className="int-row-keys">{children}</span> : null}
    </li>
  );
}

/** A dialog form's footer keys: Cancel, then the submit key. */
export function FormKeys({ onCancel, busy, cancel = "Cancel", ...submit }: { onCancel: () => void; busy: boolean; cancel?: string } & Omit<React.ComponentProps<typeof PendingButton>, "type" | "className" | "pending">) {
  return (
    <>
      <button type="button" className="btn" onClick={onCancel} disabled={busy}>
        {cancel}
      </button>
      <PendingButton type="submit" className="btn btn-primary" pending={busy} {...submit} />
    </>
  );
}

/** The one field of a provider's connect form: a pasted token. Typing clears its error. */
export function TokenField({ label, form, hint }: { label: string; form: ReturnType<typeof useTokenForm>; hint: React.ReactNode }) {
  return (
    <Field label={label} error={form.error} hint={hint}>
      {(ids) => (
        <TextInput
          ids={ids}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={form.token}
          onChange={(e) => {
            form.setToken(e.target.value);
            form.setError(null);
          }}
          data-autofocus
        />
      )}
    </Field>
  );
}

/** A connect form's state. `begin` starts a submit: false while one runs, or when no token was pasted. */
export function useTokenForm() {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const begin = () => {
    if (busy) return false;
    if (!token.trim()) {
      setError("Paste the token first");
      return false;
    }
    setError(null);
    setBusy(true);
    return true;
  };
  return { token, setToken, busy, setBusy, error, setError, begin };
}

/** A connected provider's dialog: Disconnect and Done, and what went wrong on top when the token stopped working. */
export function ProviderDialog({
  open,
  onClose,
  onDisconnect,
  title,
  sub,
  icon,
  error,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onDisconnect: () => void;
  title: string;
  sub?: string;
  icon: IconName;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      sub={sub}
      icon={icon}
      size="lg"
      footer={
        <>
          <button type="button" className="btn int-ft-start" onClick={onDisconnect}>
            Disconnect
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      {error ? (
        <Callout tone="warn" icon="alert">
          {clause(error)}. Disconnect, then connect again with a new token.
        </Callout>
      ) : null}
      {children}
    </Dialog>
  );
}

/** Where a list that failed to load stands, with the key that asks again. */
export function Unavailable({ icon, title, error, onRetry }: { icon: IconName; title: string; error: string; onRetry: () => void }) {
  return (
    <Empty
      icon={icon}
      title={title}
      body={`${clause(error)}. Try again in a moment.`}
      action={
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Try again
        </button>
      }
    />
  );
}

export type Listing<T> = { state: "idle" | "loading" } | { state: "ready"; list: T[] } | { state: "error"; error: string };

/**
 * A provider card's state: its dialog, its Disconnect confirm, and the list the dialog reads, once per
 * connection, from the press that opens it. An answer to an older load, or one after the card left, is dropped.
 */
export function useProviderCard<T>(connected: boolean, path: string, onLoaded?: (list: T[]) => void) {
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [list, setList] = useState<Listing<T>>({ state: "idle" });
  const seq = useRef(0);
  useEffect(() => () => void ++seq.current, []);
  const load = async () => {
    const mine = ++seq.current;
    setList({ state: "loading" });
    const r = await intFetch<T[]>(path);
    if (mine !== seq.current) return;
    setList(r.ok ? { state: "ready", list: r.data } : { state: "error", error: r.error });
    if (r.ok) onLoaded?.(r.data);
  };
  const openManage = () => {
    setOpen(true);
    if (connected && list.state === "idle") void load();
  };
  return { open, setOpen, leaving, setLeaving, list, setList, load, openManage };
}

/**
 * The state of a card that manages a list: the dialog, its list or form step, and the row being
 * removed. The card's key goes straight to the form while there is nothing to list, and Cancel on
 * that first form just closes.
 */
export function useCrudCard<T>(hasItems: boolean) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<{ at: "list" } | { at: "form"; editing: T | null }>({ at: "list" });
  const [removing, setRemoving] = useState<T | null>(null);
  const toList = () => setMode({ at: "list" });
  return {
    open,
    close: () => setOpen(false),
    start: () => {
      setMode(hasItems ? { at: "list" } : { at: "form", editing: null });
      setOpen(true);
    },
    listOpen: open && mode.at === "list",
    /** The open form, with the row it edits; null while none shows. */
    form: open && mode.at === "form" ? { editing: mode.editing } : null,
    add: () => setMode({ at: "form", editing: null }),
    edit: (row: T) => setMode({ at: "form", editing: row }),
    toList,
    back: () => (hasItems ? toList() : setOpen(false)),
    removing,
    setRemoving,
  };
}

/** The list step of such a card: Done, and the key that opens the empty form. */
export function ListDialog({ open, onClose, onAdd, addLabel, title, sub, icon, children }: { open: boolean; onClose: () => void; onAdd: () => void; addLabel: string; title: string; sub: string; icon: IconName; children: React.ReactNode }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      sub={sub}
      icon={icon}
      size="lg"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
          <button type="button" className="btn btn-primary" onClick={onAdd}>
            <Icon name="plus" />
            {addLabel}
          </button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

/** Asks before a row leaves such a list; focus goes back to the list, or to its add key once it is empty. */
export function RemoveDialog<T>({ row, onClose, title, sub, body, label, onRemove }: { row: T | null; onClose: () => void; title: string; sub?: string; body: string | undefined; label: string; onRemove: (row: T) => Promise<void> }) {
  return (
    <ConfirmDialog
      open={row !== null}
      onClose={onClose}
      tone="danger"
      title={title}
      sub={sub}
      body={body}
      confirmLabel={label}
      confirmIcon="trash"
      onConfirm={() => (row ? onRemove(row) : undefined)}
      returnFocus={() => document.querySelector<HTMLElement>(".int-list .int-row-keys button") ?? document.querySelector<HTMLElement>(".dlg .btn-primary")}
    />
  );
}
