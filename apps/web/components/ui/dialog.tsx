"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "@/components/icon";
import { useHydrated } from "@/lib/hooks";
import { isTopLayer, openLayer } from "@/lib/modal";
import { cx } from "./cx";
import { Field, TextInput } from "./field";
import { IconTile } from "./icon-tile";
import { PendingButton } from "./pending";

/*
 * The one modal dialog, in the popover material: radius 12, popover fill, a 1px strong ring and a
 * soft shadow over a dim scrim. Below 760px it is a bottom sheet with a grab bar.
 *
 *   <Dialog open={open} onClose={() => setOpen(false)} title="Add domain" sub="horseai / web" icon="globe"
 *     busy={saving} onSubmit={save} footer={<><button type="button" className="btn" onClick={close}>Cancel</button>
 *     <button type="submit" className="btn btn-primary"><PendingLabel pending={saving} icon="plus">Add domain</PendingLabel></button></>}>
 *     <Field label="Domain">{(ids) => <TextInput ids={ids} data-autofocus />}</Field>
 *   </Dialog>
 *
 * Tab stays inside. Focus starts on `initialFocus`, `[data-autofocus]`, the first body control or
 * the panel, and returns to the opener on close. When the opener is gone (the row it sat in was just
 * removed), focus goes to `returnFocus()` (the next row's control, or the list's heading), else to
 * the page's title, so it never falls back to the top of the page. Esc, the scrim and the X close it
 * unless `busy`, so a running write always has a place to answer. Nested dialogs stack; only the
 * top one hears keys.
 */

const FOCUSABLE = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled):not([type='hidden'])",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(",");

const visible = (el: HTMLElement) => el.getClientRects().length > 0;

/** Where focus lands when the opener is gone: `fallback`, else the page's title, else main. */
function landing(fallback?: () => HTMLElement | null) {
  const target = fallback?.() ?? document.querySelector<HTMLElement>("main h1") ?? document.querySelector<HTMLElement>("main");
  if (!target) return;
  if (!target.matches(FOCUSABLE)) target.tabIndex = -1;
  target.focus({ preventScroll: true });
}

/**
 * Puts the focus back after a dialog closes. On the opener while it is in the page; a list that
 * drops the opener's row a moment later (its refresh landing after the close) is caught for a few
 * seconds, so the focus still lands somewhere near instead of on the document.
 */
function giveFocusBack(opener: HTMLElement | null, fallback?: () => HTMLElement | null) {
  if (!opener?.isConnected) {
    landing(fallback);
    return;
  }
  opener.focus({ preventScroll: true });
  // An opener still in the page may no longer take the focus (a key now disabled because what it
  // acted on is gone): land as if it had left.
  if (document.activeElement !== opener) {
    landing(fallback);
    return;
  }
  const until = Date.now() + 3000;
  const watch = window.setInterval(() => {
    const lost = !opener.isConnected && (document.activeElement === document.body || document.activeElement === null);
    if (lost) landing(fallback);
    if (lost || Date.now() > until || (document.activeElement !== opener && opener.isConnected)) window.clearInterval(watch);
  }, 100);
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  sub?: React.ReactNode;
  /** Glyph in a 32px tile before the title, as in card heads. */
  icon?: IconName;
  /**
   * "bad" tones the head for an alert the operator must not miss (a security release): a soft red
   * wash under the title and the glyph on the soft red tile. Calm, never a solid red head.
   */
  tone?: "bad";
  /** "sm" 440, "md" 560 (default), "lg" 640. */
  size?: "sm" | "md" | "lg";
  /** Work in flight: nothing closes the dialog and the X is disabled. */
  busy?: boolean;
  initialFocus?: React.RefObject<HTMLElement | null>;
  /** Makes the panel a form; Enter submits. The default submit is prevented for you. */
  onSubmit?: () => void;
  /** Footer keys, right aligned, 36px. Put a `.dlg-note` first for a muted note on the left. */
  footer?: React.ReactNode;
  /**
   * Where focus goes on close when the opener no longer exists (a removed row): the next row's
   * main control, or the list heading when the list is now empty. Defaults to the page's title.
   */
  returnFocus?: () => HTMLElement | null;
  className?: string;
  children?: React.ReactNode;
}

export function Dialog(props: DialogProps) {
  const hydrated = useHydrated();
  return props.open && hydrated ? <DialogPanel {...props} /> : null;
}

function DialogPanel({ onClose, title, sub, icon, tone, size = "md", busy = false, initialFocus, onSubmit, footer, returnFocus, className, children }: DialogProps) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const foot = useRef<HTMLDivElement>(null);
  const downOnScrim = useRef(false);
  // Read once at mount, before the dialog moves focus (StrictMode re-runs effects, not this).
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  // The first focus is decided once per open, so a caller that swaps the ref later changes nothing.
  const [firstFocus] = useState(() => initialFocus);

  // Latest values for the listeners, which are bound once per open.
  const live = useRef({ onClose, busy, returnFocus });
  useEffect(() => {
    live.current = { onClose, busy, returnFocus };
  });

  // Runs once per open: its inputs (the id, the first focus, the opener) are fixed for the dialog's life.
  useEffect(() => {
    const el = panel.current!;
    const release = openLayer(id, el);

    const first =
      firstFocus?.current ??
      el.querySelector<HTMLElement>("[data-autofocus]") ??
      [...(body.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].find(visible) ??
      [...(foot.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].find(visible) ??
      el;
    first.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (!isTopLayer(id)) return;
      if (e.key === "Escape") {
        // A control inside (a dropdown, a search field) that used this Esc has already said so.
        if (e.defaultPrevented) return;
        e.preventDefault();
        if (!live.current.busy) live.current.onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
      if (!items.length) {
        e.preventDefault();
        el.focus();
        return;
      }
      const active = document.activeElement;
      const inside = active instanceof Node && el.contains(active);
      if (e.shiftKey && (!inside || active === items[0] || active === el)) {
        e.preventDefault();
        items.at(-1)!.focus();
      } else if (!e.shiftKey && (!inside || active === items.at(-1))) {
        e.preventDefault();
        items[0]!.focus();
      }
    };

    // Focus that lands behind the dialog comes back to it. Toasts stay reachable.
    const onFocusIn = (e: FocusEvent) => {
      if (!isTopLayer(id)) return;
      const t = e.target;
      if (!(t instanceof HTMLElement) || el.contains(t) || t.closest(".toaster")) return;
      el.focus({ preventScroll: true });
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);
      release();
      // The row that opened it may be removed in the same update as the close: decide on the next
      // frame, once the page shows what is left.
      const back = live.current.returnFocus;
      if (opener?.isConnected) giveFocusBack(opener, back);
      else requestAnimationFrame(() => giveFocusBack(opener, back));
    };
  }, [id, firstFocus, opener]);

  const content = (
    <>
      <header className="dlg-hd">
        {icon ? (
          <IconTile size="md" tone={tone} soft={!!tone}>
            <Icon name={icon} />
          </IconTile>
        ) : null}
        <span className="dlg-titles">
          <h2 id={`${id}-t`} className="dlg-title">
            {title}
          </h2>
          {sub ? (
            <span id={`${id}-s`} className="dlg-sub">
              {sub}
            </span>
          ) : null}
        </span>
        <button type="button" className="btn btn-icon dlg-close" aria-label="Close" onClick={onClose} disabled={busy}>
          <Icon name="close" size={14} />
        </button>
      </header>
      <div ref={body} className="dlg-body">
        {children}
      </div>
      {footer ? (
        <div ref={foot} className="dlg-ft">
          {footer}
        </div>
      ) : null}
    </>
  );

  return createPortal(
    <div
      className="dlg-scrim"
      onPointerDown={(e) => {
        downOnScrim.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnScrim.current && e.target === e.currentTarget && !busy) onClose();
        downOnScrim.current = false;
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        aria-describedby={sub ? `${id}-s` : undefined}
        aria-busy={busy || undefined}
        tabIndex={-1}
        className={cx("dlg", className)}
        data-size={size}
        data-tone={tone}
      >
        {onSubmit ? (
          <form
            className="dlg-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) onSubmit();
            }}
          >
            {content}
          </form>
        ) : (
          content
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * A yes or no question in a small dialog. `onConfirm` may return a promise: the confirm key shows
 * a spinner and nothing closes while it runs; it closes when the promise resolves and stays open
 * when it throws (toast the error in `onConfirm`). `confirmText` asks the operator to type a name
 * before a destructive action unlocks.
 *
 *   <ConfirmDialog open={open} onClose={close} tone="danger" title="Delete project"
 *     body="This removes horseai, its 6 apps and their volumes." confirmLabel="Delete project"
 *     confirmIcon="trash" confirmText="horseai" onConfirm={() => remove("horseai")} />
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  sub,
  body,
  confirmLabel = "Confirm",
  confirmIcon,
  cancelLabel = "Cancel",
  tone = "default",
  confirmText,
  busy,
  returnFocus,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => unknown;
  title: string;
  sub?: React.ReactNode;
  body?: React.ReactNode;
  confirmLabel?: string;
  confirmIcon?: IconName;
  cancelLabel?: string;
  /** "danger" makes the confirm key solid red. */
  tone?: "default" | "danger";
  /** The exact text to type before the confirm key unlocks, usually the object's name. */
  confirmText?: string;
  /** Controlled pending state; otherwise it follows the promise `onConfirm` returns. */
  busy?: boolean;
  /** Where focus goes when the confirmed action removed the opener (see Dialog). */
  returnFocus?: () => HTMLElement | null;
}) {
  const [typed, setTyped] = useState("");
  const [running, setRunning] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  const cancel = useRef<HTMLButtonElement>(null);

  // A fresh question every time it opens.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setTyped("");
  }

  const pending = busy ?? running;
  const unlocked = !confirmText || typed.trim() === confirmText;

  const run = async () => {
    if (!unlocked || pending) return;
    setRunning(true);
    try {
      await onConfirm();
      onClose();
    } catch {
      // The caller reported it; the dialog stays open for another try.
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      sub={sub}
      size="sm"
      busy={pending}
      initialFocus={confirmText ? undefined : cancel}
      onSubmit={() => void run()}
      returnFocus={returnFocus}
      footer={
        <>
          <button ref={cancel} type="button" className="btn" onClick={onClose} disabled={pending}>
            {cancelLabel}
          </button>
          {/* Busy, not unavailable: the key keeps the focus while the action runs. */}
          <PendingButton
            type="submit"
            className={tone === "danger" ? "btn btn-danger" : "btn btn-primary"}
            disabled={!unlocked}
            pending={pending}
            icon={confirmIcon}
          >
            {confirmLabel}
          </PendingButton>
        </>
      }
    >
      {typeof body === "string" ? <p className="dlg-text">{body}</p> : body}
      {confirmText ? (
        <Field
          label={
            <>
              Type <b className="dlg-confirm-name">{confirmText}</b> to confirm
            </>
          }
        >
          {(ids) => (
            <TextInput
              ids={ids}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              data-autofocus
              readOnly={pending}
            />
          )}
        </Field>
      ) : null}
    </Dialog>
  );
}
