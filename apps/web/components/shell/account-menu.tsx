"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { settle } from "@/components/auth/util";
import { Icon } from "@/components/icon";
import { Avatar } from "@/components/ui/avatar";
import { cx } from "@/components/ui/cx";
import { toast } from "@/components/ui/toast";
import { useOutsidePress } from "@/lib/hooks";
import { signOut } from "@/lib/pages/auth";
import { DOCS_URL } from "./nav";
import type { ShellData } from "./shell";

/** "admin" from the API reads "Admin"; the only roles are Admin and Viewer. */
const roleLabel = (role: string) => (role.toLowerCase() === "viewer" ? "Viewer" : "Admin");

type Viewer = NonNullable<ShellData["viewer"]>;

/* A failure stays on screen: the session is still live. */
async function signOutHere(preview: boolean) {
  if (!preview) {
    const r = await settle(signOut());
    if (!r.ok) {
      toast.error("Could not sign out", { description: r.error });
      return;
    }
  }
  window.location.assign("/login?reason=signed-out");
}

/** `menu` makes the list an ARIA menu described by `describedBy`. `pages={false}` leaves out Settings and Activity. */
export function AccountRows({
  preview = false,
  menu = false,
  describedBy,
  pages = true,
  onPick,
}: {
  preview?: boolean;
  menu?: boolean;
  describedBy?: string;
  pages?: boolean;
  onPick?: () => void;
}) {
  const none = menu ? "none" : undefined;
  const item = menu ? "menuitem" : undefined;
  return (
    <ul className="acct-rows" role={menu ? "menu" : undefined} aria-label={menu ? "Account" : undefined} aria-describedby={menu ? describedBy : undefined}>
      {pages ? (
        <>
          <li role={none}>
            <Link href="/settings" className="acct-row" role={item} data-menu-item="" onClick={onPick}>
              <span className="acct-row-label">Settings</span>
              <Icon name="settings" size={16} />
            </Link>
          </li>
          <li role={none}>
            <Link href="/activity" className="acct-row" role={item} data-menu-item="" onClick={onPick}>
              <span className="acct-row-label">Activity</span>
              <Icon name="activity" size={16} />
            </Link>
          </li>
        </>
      ) : null}
      <li role={none}>
        <a href={DOCS_URL} target="_blank" rel="noreferrer" className="acct-row" role={item} data-menu-item="" onClick={onPick}>
          <span className="acct-row-label">
            Docs
            <span className="sr">, opens in a new tab</span>
          </span>
          <Icon name="book" size={16} />
        </a>
      </li>
      <li role={none}>
        <button
          type="button"
          className="acct-row"
          role={item}
          data-menu-item=""
          onClick={() => {
            onPick?.();
            void signOutHere(preview);
          }}
        >
          <span className="acct-row-label">Sign out</span>
          <Icon name="logout" size={16} />
        </button>
      </li>
    </ul>
  );
}

/** Focus returns to the trigger after a row is used too, so it never falls to the page while a sign out or navigation runs. */
export function AccountMenu({ viewer, preview, collapsed }: { viewer: Viewer; preview?: boolean; collapsed: boolean }) {
  const path = usePathname();
  const headId = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const moreKey = useRef<HTMLButtonElement>(null);
  const avatarKey = useRef<HTMLButtonElement>(null);

  const trigger = useCallback(() => (collapsed ? avatarKey.current : moreKey.current), [collapsed]);

  const close = useCallback(
    (refocus = true) => {
      setOpen(false);
      if (refocus) trigger()?.focus();
    },
    [trigger],
  );

  const items = () => [...(panel.current?.querySelectorAll<HTMLElement>("[data-menu-item]") ?? [])];

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("[data-menu-item]")?.focus();
  }, [open]);
  useOutsidePress(open, [root], () => close(false));

  // Collapsing or expanding the sidebar moves the trigger, so the menu closes. Focus it held went
  // down with it, so it lands on the trigger for the new width instead of the page.
  const [width, setWidth] = useState(collapsed);
  const [closedByWidth, setClosedByWidth] = useState(false);
  if (width !== collapsed) {
    setWidth(collapsed);
    setClosedByWidth(open);
    if (open) setOpen(false);
  }
  useEffect(() => {
    if (closedByWidth && (!document.activeElement || document.activeElement === document.body)) trigger()?.focus();
  }, [closedByWidth, trigger]);

  // Back and forward navigation leave no click outside, so a route change closes the menu too.
  const [shownPath, setShownPath] = useState(path);
  if (shownPath !== path) {
    setShownPath(path);
    setOpen(false);
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "Tab") {
      close(false);
      return;
    }
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (e.key === "ArrowDown") next = (at + 1) % list.length;
    else if (e.key === "ArrowUp") next = at < 0 ? list.length - 1 : (at - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    list[next]?.focus();
  };

  const toggle = () => {
    if (open) return close();
    setClosedByWidth(false);
    setOpen(true);
  };

  // The open row is one big target for a pointer. The keys handle their own clicks (so none is
  // handled twice), and the keyboard keeps its path through the more key.
  const fromRow = (e: React.MouseEvent) => {
    if (collapsed || (e.target as Element).closest("button")) return;
    toggle();
  };

  return (
    <div ref={root} data-open={open}>
      <div className="side-user" onClick={fromRow}>
        <button
          ref={avatarKey}
          type="button"
          className="acct-avatar"
          aria-label="Account menu"
          aria-haspopup="menu"
          aria-expanded={collapsed ? open : undefined}
          tabIndex={collapsed ? 0 : -1}
          onClick={toggle}
        >
          <Avatar url={viewer.avatarUrl} />
        </button>
        <span className="side-user-text">
          <span className="side-user-name">{viewer.name}</span>
          <span className="side-user-role">{roleLabel(viewer.role)}</span>
        </span>
        <button
          ref={moreKey}
          type="button"
          className={cx("btn btn-sm btn-icon side-user-key", open && !collapsed && "is-open")}
          aria-label="Account menu"
          aria-haspopup="menu"
          aria-expanded={collapsed ? undefined : open}
          tabIndex={collapsed ? -1 : 0}
          onClick={toggle}
        >
          <Icon name="more" />
        </button>
      </div>

      {/* The popover holds who is signed in, then the menu itself, so the menu holds only items. */}
      {open ? (
        <div ref={panel} className="acct-pop" data-side={collapsed ? "right" : "top"} onKeyDownCapture={onKey}>
          <div className="acct-hd" id={headId}>
            <Avatar url={viewer.avatarUrl} />
            <span className="acct-hd-text">
              <span className="acct-name">{viewer.name}</span>
              <span className="acct-email">{viewer.email ?? roleLabel(viewer.role)}</span>
            </span>
          </div>
          <AccountRows preview={preview} menu describedBy={headId} onPick={() => close()} />
        </div>
      ) : null}
    </div>
  );
}
