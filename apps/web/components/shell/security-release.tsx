"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { send } from "@/components/server-backups/use-poll";
import { wasCancelled } from "@/components/step-up/step-up";
import { Chip } from "@/components/ui/chip";
import { Dialog } from "@/components/ui/dialog";
import { ExternalLink } from "@/components/ui/external-link";
import { claimLeave } from "@/components/ui/leave-guard";
import { PendingButton } from "@/components/ui/pending";
import { toast } from "@/components/ui/toast";
import { callJson } from "@/lib/client-api";
import { describe, errText } from "@/lib/feedback";
import { apiFetch, useNow } from "@/lib/hooks";
import { safeHref } from "@/lib/markdown";
import type { UpdateJob } from "@/lib/pages/server-backups";
import {
  CLOSE_SNOOZE, compareVersions, dayLabel, levelLabel, popupDue, readAlert, snoozeChoices, updatePlan,
  type SecurityAlert, type SecurityAlertResult, type SecurityRelease, type SnoozeDays,
} from "@/lib/security-release";
import { onUpdateJob, updateStarted } from "@/lib/update-events";
import { useCan } from "@/lib/viewer";

// The popup never stacks: it waits while another dialog or menu is up, and "Confirm it is you"
// hides it while it asks. Closing it any way counts as a 1 day reminder; the banner stays.

const DAY = 86_400_000;
/** Checked every 5 minutes, every 30 seconds while an update runs. */
const POLL_MS = 300_000;
const POLL_UPDATING_MS = 30_000;

/** Anything else on screen that the popup must not stack over: never two popups. */
const OVERLAY = '[aria-modal="true"], [role="dialog"], .cmd-scrim, .acct-pop, .mnav[data-open="true"], .sel-list, .dtp-pop, .session-ended';
const overlayOpen = () => document.documentElement.classList.contains("step-up-open") || document.querySelector(OVERLAY) !== null;

const v = (version: string) => (version.startsWith("v") ? version : `v${version}`);

interface SecurityState {
  alert: SecurityAlert | null;
  admin: boolean;
  preview: boolean;
  starting: boolean;
  updateNow: () => void;
}

const SecurityContext = createContext<SecurityState | null>(null);

export function SecurityReleaseProvider({ initial, children }: { initial: SecurityAlertResult; children: React.ReactNode }) {
  const router = useRouter();
  // Keys follow the usual rule (an unknown role keeps them, the API refuses what it must), but the
  // popup interrupts, so it opens only for a member known to be an Admin.
  const { manage, role } = useCan();
  const admin = role === "admin";
  const now = useNow(60_000);
  const [alert, setAlert] = useState(initial.data);
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const startLock = useRef(false);
  const preview = initial.source === "preview";
  const live = initial.source === "api";

  // A fresher answer from the server (a refresh of the layout) replaces what the page holds.
  const [seen, setSeen] = useState(initial);
  if (initial !== seen) {
    setSeen(initial);
    setAlert(initial.data);
  }

  // The newest alert, for the actions, which must not restart on every poll.
  const alertRef = useRef(alert);
  useEffect(() => {
    alertRef.current = alert;
  });

  const due = popupDue(alert, admin, now);
  // When the popup stops being due (put off elsewhere, an update started), it is closed for good;
  // the next time it is due it waits for a clear screen again.
  const [wasDue, setWasDue] = useState(due);
  if (due !== wasDue) {
    setWasDue(due);
    if (!due) setOpen(false);
  }

  // Opens once due, a beat after the page paints, and only over an otherwise clear screen.
  useEffect(() => {
    if (!due || open) return;
    let timer: ReturnType<typeof setTimeout>;
    const attempt = () => {
      if (overlayOpen()) {
        timer = setTimeout(attempt, 400);
        return;
      }
      setOpen(true);
    };
    timer = setTimeout(attempt, 250);
    return () => clearTimeout(timer);
  }, [due, open]);

  // Only live API data polls; the preview fixture holds still.
  const updating = !!alert?.updating;
  useEffect(() => {
    if (!live) return;
    let stop = false;
    let last = Date.now();
    const pull = async () => {
      if (document.hidden) return;
      last = Date.now();
      try {
        const res = await apiFetch("/api/server/updates/security", { cache: "no-store" });
        if (!res.ok) return;
        const next = readAlert(((await res.json()) as Partial<SecurityAlertResult>).data);
        // A failed or unreadable read keeps the last good alert: the banner never flickers away.
        if (!stop && next) setAlert(next);
      } catch {
        // The control plane may be restarting during an update; the next tick asks again.
      }
    };
    const id = setInterval(() => void pull(), updating ? POLL_UPDATING_MS : POLL_MS);
    const onVisible = () => {
      if (!document.hidden && Date.now() - last > 60_000) void pull();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [live, updating]);

  // The Updates card's news (lib/update-events.ts): a running job turns the banner to its
  // progress, and an update that reached the fixed release takes the alert away.
  useEffect(
    () =>
      onUpdateJob((j: UpdateJob) => {
        setAlert((a) => {
          if (!a) return a;
          if (j.state === "waiting" || j.state === "running") return { ...a, updating: { kind: j.kind, version: j.version } };
          const fixed = j.kind === "update" && j.state === "done" && !!a.release && compareVersions(j.version, a.release.version) >= 0;
          return { ...a, updating: null, current: j.state === "done" ? j.version : a.current, target: j.state === "done" ? null : a.target, release: fixed ? null : a.release };
        });
      }),
    [],
  );

  /** Puts the popup off for this member. The banner stays. */
  const snooze = useCallback(
    async (days: SnoozeDays, chosen: boolean) => {
      const rel = alertRef.current?.release;
      setOpen(false);
      if (!rel) return;
      const until = new Date(Date.now() + Math.min(days, rel.maxSnoozeDays) * DAY).toISOString();
      setAlert((a) => (a ? { ...a, snoozedUntil: until } : a));
      const r = await callJson<unknown>("/api/server/updates/security/snooze", { method: "POST", body: { version: rel.version, days } });
      const next = r.ok ? readAlert(r.data) : null;
      if (next) {
        // A newer security release came out meanwhile: the answer carries it and the popup shows it.
        setAlert(next);
        if (chosen && next.release?.version === rel.version && next.snoozedUntil) {
          toast.success("Reminder set", { description: describe([`Dockify asks again in ${dayLabel(days)}`, "The banner stays until the update is installed"], { preview }) });
        }
      } else if (!r.ok) {
        toast.error("Could not save the reminder", { description: describe([r.error, "The popup asks again on the next page"]) });
      }
    },
    [preview],
  );

  const updateNow = useCallback(async () => {
    const a = alertRef.current;
    if (startLock.current || !a?.target) return;
    startLock.current = true;
    setStarting(true);
    try {
      const job = await send<UpdateJob>("/api/server/updates/apply", "POST", { version: a.target });
      setOpen(false);
      updateStarted(job);
      if (!claimLeave("/server#updates")) router.push("/server#updates");
    } catch (e) {
      if (!wasCancelled(e)) toast.error("Could not start the update", { description: describe([`Still on ${v(a.current)}`, errText(e)], { preview }) });
    } finally {
      startLock.current = false;
      setStarting(false);
    }
  }, [router, preview]);

  const value = useMemo<SecurityState>(() => ({ alert, admin: manage, preview, starting, updateNow: () => void updateNow() }), [alert, manage, preview, starting, updateNow]);
  const release = alert?.release ?? null;

  return (
    <SecurityContext.Provider value={value}>
      {children}
      {alert && release && admin ? (
        <SecurityPopup
          open={open && due}
          alert={alert}
          release={release}
          starting={starting}
          onUpdate={() => void updateNow()}
          onSnooze={(d, chosen) => void snooze(d, chosen)}
        />
      ) : null}
    </SecurityContext.Provider>
  );
}

function planLine(alert: SecurityAlert, release: SecurityRelease): string {
  switch (updatePlan(alert, release)) {
    case "exact":
      return `Update now installs ${v(release.version)}.`;
    case "newer":
      return `Update now installs ${v(alert.target!)}, which includes the fix.`;
    case "step":
      return `Update now installs ${v(alert.target!)} first, a required step on the way to ${v(release.version)}.`;
    case "none":
      return `This server cannot move to ${v(release.version)} in one step. The Server page says what it needs first.`;
  }
}

function SecurityPopup({
  open,
  alert,
  release,
  starting,
  onUpdate,
  onSnooze,
}: {
  open: boolean;
  alert: SecurityAlert;
  release: SecurityRelease;
  starting: boolean;
  onUpdate: () => void;
  onSnooze: (days: SnoozeDays, chosen: boolean) => void;
}) {
  const update = useRef<HTMLButtonElement>(null);
  const advisory = release.advisory ? safeHref(release.advisory) : null;
  const canUpdate = updatePlan(alert, release) !== "none";
  return (
    <Dialog
      open={open}
      onClose={() => onSnooze(CLOSE_SNOOZE, false)}
      busy={starting}
      tone="bad"
      icon="alert"
      size="md"
      className="dlg-security"
      title="Important security release"
      sub={`Dockify ${v(release.version)} fixes a security issue.`}
      initialFocus={canUpdate ? update : undefined}
      footer={
        <>
          <div className="sec-remind" role="group" aria-label="Remind me in">
            <span className="sec-remind-label" aria-hidden="true">
              Remind me in
            </span>
            {snoozeChoices(release).map((d) => (
              <button key={d} type="button" className="btn" aria-label={`Remind me in ${dayLabel(d)}`} disabled={starting} onClick={() => onSnooze(d, true)}>
                {dayLabel(d)}
              </button>
            ))}
          </div>
          {canUpdate ? (
            <PendingButton ref={update} className="btn btn-primary" icon="download" pending={starting} onClick={onUpdate}>
              Update now
            </PendingButton>
          ) : (
            <Link className="btn btn-primary" href="/server#updates" onClick={() => onSnooze(CLOSE_SNOOZE, false)}>
              Open updates
            </Link>
          )}
        </>
      }
    >
      <p className="dlg-text sec-summary">{release.summary}</p>
      <div className="sec-meta">
        <Chip size="xs" tone={release.level === "critical" ? "bad" : "warn"}>
          {levelLabel(release.level)}
        </Chip>
        {release.cves.map((c) => (
          <span key={c} className="sec-cve">
            {c}
          </span>
        ))}
        {advisory ? (
          <ExternalLink className="sec-link" href={advisory}>
            Read the advisory
          </ExternalLink>
        ) : null}
      </div>
      <p className="sec-note">
        You run {v(alert.current)}. {planLine(alert, release)} It backs up the database first and rolls back on its own if a step fails.
      </p>
    </Dialog>
  );
}

export function SecurityBanner() {
  const s = useContext(SecurityContext);
  const alert = s?.alert;
  const release = alert?.release;
  if (!s || !alert || !release) return null;
  const up = alert.updating;
  return (
    <section className="secb" aria-label="Security release" data-level={release.level}>
      <div className="secb-rail">
        <Icon name="alert" size={16} className="secb-ic" />
        <p className="secb-text">
          {up ? (
            <>
              {up.kind === "rollback" ? "Rolling Dockify back to " : "Updating Dockify to "}
              <b className="num">{v(up.version)}</b>
            </>
          ) : (
            <>
              Important security release <b className="num">{v(release.version)}</b> is available
            </>
          )}
        </p>
        <span className="secb-act">
          {up ? (
            <Link className="secb-link" href="/server#updates">
              See progress
            </Link>
          ) : s.admin && alert.target ? (
            <PendingButton className="btn btn-xs" pending={s.starting} onClick={s.updateNow}>
              Update now
            </PendingButton>
          ) : s.admin ? (
            <Link className="secb-link" href="/server#updates">
              Open updates
            </Link>
          ) : (
            <span className="secb-note">Ask an admin to update</span>
          )}
        </span>
      </div>
    </section>
  );
}
