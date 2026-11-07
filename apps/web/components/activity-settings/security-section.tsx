"use client";

import { useState } from "react";
import { revokeOtherSessions, revokeSession } from "@/app/(console)/settings/actions";
import { Icon, type IconName } from "@/components/icon";
import { RowMenu } from "@/components/project-extras/row-menu";
import { Chip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/dialog";
import { PendingButton } from "@/components/ui/pending";
import { When } from "@/components/ui/when";
import { report } from "@/lib/feedback";
import type { Session } from "@/lib/pages/activity-settings";
import { Group, settle } from "./form";
import { PasswordDialog } from "./password-dialog";
import { Segment, SectionTabs } from "./section-tabs";
import type { SectionProps } from "./settings-view";
import { TwoFactorGroup } from "./two-factor";

/* ---------- Password ---------- */

/** One row: what the password is for, and the key that opens the change dialog. */
function PasswordGroup({ emailEnabled, preview, email }: { emailEnabled: boolean; preview: boolean; email: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Group
      solo
      id="set-password"
      icon="lock"
      title="Password"
      sub="Change the password you sign in with"
      actions={
        <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
          Change password
        </button>
      }
    >
      {open ? <PasswordDialog onClose={() => setOpen(false)} emailEnabled={emailEnabled} preview={preview} email={email} /> : null}
    </Group>
  );
}

/* ---------- Sessions ---------- */

/** A session's device by its shape: phone, tablet, computer, or a globe when nothing was recognised. */
const DEVICE_ICON: Record<Session["kind"], IconName> = { mobile: "mobile", tablet: "tablet", desktop: "desktop", unknown: "globe" };

/**
 * One session as a 56px table row, the same shape as a token: the device glyph and name (This
 * device on the current one) over the address and sign-in time, when it was last active, then the
 * more key with Revoke. While a revoke runs its key turns into the spinner; any revoke in flight
 * disables the others. The current session has no key.
 */
function SessionRow({ s, now, onRevoke, busy, pending }: { s: Session; now: number; onRevoke: () => void; busy: boolean; pending: boolean }) {
  // Several sessions can share a device name, so the key says the address too.
  const who = [s.device, s.ip].filter(Boolean).join(", ");
  return (
    <li className="set-ss-row">
      <span className="two set-ss-main">
        <span className="two-main set-tm-title">
          <span className="set-ss-device">
            <Icon name={DEVICE_ICON[s.kind] ?? "globe"} size={14} />
            <span className="set-tk-name">
              {s.device}
            </span>
          </span>
          {s.current ? (
            <Chip size="xs" tone="ok">
              This device
            </Chip>
          ) : null}
        </span>
        <span className="two-sub set-tm-sub num">
          <span className="set-ss-where">{[s.ip, s.location].filter(Boolean).join(", ")}</span>
          {s.createdAt ? (
            <span className="set-keep">
              , <When iso={s.createdAt} now={now} prefix="signed in" />
            </span>
          ) : null}
        </span>
      </span>
      <span className="set-ss-seen num">{s.current ? "Active now" : <When iso={s.lastSeenAt} now={now} prefix="Last seen" tipAlign="end" />}</span>
      <span className="set-tm-end">
        {s.current ? null : pending ? (
          <PendingButton className="btn btn-xs btn-icon" pending aria-label={`Revoking ${who}`} icon="more" />
        ) : (
          <RowMenu label={`More for ${who}`} items={[{ label: "Revoke session", icon: "logout", bad: true, onSelect: onRevoke, disabled: busy }]} />
        )}
      </span>
    </li>
  );
}

function SessionsGroup({ data, update, now, preview }: Pick<SectionProps, "data" | "update" | "now" | "preview">) {
  const [busy, setBusy] = useState<string | null>(null);
  // The count the question was asked with, so the closing dialog does not read "0 sessions".
  const [confirm, setConfirm] = useState<number | null>(null);
  const others = data.sessions.filter((s) => !s.current);
  // This browser first, then the rest by when they were last seen (the API's order).
  const sessions = [...data.sessions].sort((x, y) => Number(y.current) - Number(x.current));

  const revoke = async (id: string) => {
    if (busy) return;
    const s = data.sessions.find((x) => x.id === id);
    setBusy(id);
    const res = report(await settle(revokeSession(id)), {
      success: "Session revoked",
      error: "Could not revoke session",
      what: s ? [s.device, s.location ?? s.ip].filter(Boolean).join(", ") : undefined,
      preview,
    });
    setBusy(null);
    if (!res.ok) return;
    update({ sessions: data.sessions.filter((x) => x.id !== id) });
    // The row and its key are gone: the focus goes on to the next session's key, else the heading,
    // never to the top of the page.
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const head = document.getElementById("set-sessions");
      const key = head?.closest("section")?.querySelector<HTMLElement>(".set-tm-end button");
      if (key) return key.focus({ preventScroll: true });
      if (!head) return;
      head.tabIndex = -1;
      head.focus({ preventScroll: true });
    });
  };
  // A failure toasts and keeps the question open, so trying again is one click.
  const revokeOthers = async () => {
    const n = confirm ?? others.length;
    setBusy("others");
    const res = report(await settle(revokeOtherSessions()), {
      success: "Other sessions signed out",
      error: "Could not sign out other sessions",
      what: `${n} ${n === 1 ? "session" : "sessions"}. This browser stays signed in`,
      preview,
    });
    setBusy(null);
    if (!res.ok) throw new Error(res.error);
    update({ sessions: data.sessions.filter((x) => x.current) });
  };

  return (
    <Group
      id="set-sessions"
      icon="desktop"
      title="Active sessions"
      sub={data.sessions.length === 1 ? "Only this browser is signed in to your account" : `${data.sessions.length} browsers are signed in to your account`}
      actions={
        <button type="button" className="btn btn-sm" onClick={() => setConfirm(others.length)} disabled={!others.length || busy !== null}>
          Sign out other sessions
        </button>
      }
    >
      <div className="set-ss-head" aria-hidden="true">
        <span>Session</span>
        <span>Last active</span>
        <span />
      </div>
      <ul className="set-tm-list" aria-label="Active sessions">
        {sessions.map((s) => (
          <SessionRow key={s.id} s={s} now={now} busy={busy !== null} pending={busy === s.id} onRevoke={() => void revoke(s.id)} />
        ))}
      </ul>
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={revokeOthers}
        title="Sign out other sessions"
        body={`${confirm === 1 ? "1 other session" : `${confirm ?? 0} other sessions`} will need to sign in again. This browser stays signed in.`}
        confirmLabel={confirm === 1 ? "Sign out 1 session" : `Sign out ${confirm ?? 0} sessions`}
        confirmIcon="logout"
      />
    </Group>
  );
}

/* ---------- Section ---------- */

export function SecuritySection({ data, update, now, preview, emailEnabled, elevate, tab, onTab }: SectionProps) {
  return (
    <SectionTabs section="security" tab={tab} onTab={onTab} counts={{ sessions: data.sessions.length }}>
      <Segment value="two-factor" tab={tab}>
        <TwoFactorGroup data={data} update={update} preview={preview} elevate={elevate} />
      </Segment>
      <Segment value="password" tab={tab}>
        <PasswordGroup emailEnabled={emailEnabled} preview={preview} email={data.me.email} />
      </Segment>
      <Segment value="sessions" tab={tab}>
        <SessionsGroup data={data} update={update} now={now} preview={preview} />
      </Segment>
    </SectionTabs>
  );
}
