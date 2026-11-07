"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Until } from "@/components/activity-settings/form";
import { wasCancelled } from "@/components/step-up/step-up";
import { CardTitle } from "@/components/card-title";
import { Icon } from "@/components/icon";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ExternalLink } from "@/components/ui/external-link";
import { PendingButton } from "@/components/ui/pending";
import { toast } from "@/components/ui/toast";
import { When } from "@/components/ui/when";
import { callJson } from "@/lib/client-api";
import { describe, errText } from "@/lib/feedback";
import { safeHref } from "@/lib/markdown";
import type { UpdateJob, UpdateStatus, UpdateStepId, UpdateStepRow, UpdatesResult } from "@/lib/pages/server-backups";
import { UPDATE_STEPS } from "@/lib/pages/server-backups-shared";
import { compareVersions, levelLabel, type SecurityRelease } from "@/lib/security-release";
import { startedUpdate, subscribeStarted, updateChanged } from "@/lib/update-events";
import { useCan } from "@/lib/viewer";
import { History, Notes, STEP, stepText, Steps } from "./update-parts";
import { send } from "./use-poll";
import { modeLabel, v } from "./util";

/** What the confirm dialog promises, in the order the API runs it. */
const PLAN: Partial<Record<UpdateStepId, string>> = {
  preflight: "Preflight checks: free disk, the database answers, nothing deploying or restoring",
  pull: "Pull the signed images and verify each one by digest",
  backup: "Back up the control-plane database, with its checksum recorded",
  migrate: "Run the release’s migrations",
  swapApi: "Restart the API, worker and dashboard one at a time",
  health: "Health checks on every service",
};

/** How long to keep following an update while the control plane restarts and drops requests. */
const FOLLOW_MS = 10 * 60_000;
/** In the ref below: the silence was already reported. Far enough ahead that it never reads as silent again. */
const WARNED = Number.MAX_SAFE_INTEGER;
const POLL_MS = 2_000;
/** The preview has no updater, so each step takes this long on its own. */
const PREVIEW_STEP_MS = 1_400;

const inFlight = (j: UpdateJob | null | undefined): j is UpdateJob => j?.state === "waiting" || j?.state === "running";
const sameSteps = (a: UpdateJob, b: UpdateJob) => a.state === b.state && a.phase === b.phase && JSON.stringify(a.steps) === JSON.stringify(b.steps);

/** The preview's updater: the running step finishes and the next one starts, or the job ends. */
function advance(job: UpdateJob): UpdateJob {
  const now = new Date().toISOString();
  const i = job.steps.findIndex((s) => s.status === "running");
  const steps = job.steps.map((s, k): UpdateStepRow => (k === i ? { ...s, status: "done", finishedAt: now } : k === i + 1 ? { ...s, status: "running", startedAt: now } : s));
  const next = steps[i + 1];
  if (next) return { ...job, steps, phase: next.id, state: "running", dumpId: job.dumpId ?? (steps.some((s) => s.id === "backup" && s.status === "done") ? `cpb_${job.id.slice(0, 8)}` : null) };
  return { ...job, steps, state: "done", finishedAt: now, durationMs: Date.now() - Date.parse(job.startedAt) };
}

/**
 * The control plane's version, its channel and policy, and the newest signed release with its
 * notes. Update now confirms, then the server's steps render live and a progress toast follows the
 * job across the restart. Any failure rolls back to the previous digests (and the dump when
 * migrations ran). The last good version stays one click away for 7 days.
 */
export function UpdatesCard({
  status,
  now,
  preview,
  onStatus,
}: {
  status: UpdateStatus | null;
  now: number;
  preview: boolean;
  onStatus: (next: UpdateStatus) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState<"apply" | "rollback" | null>(null);
  const [acting, setActing] = useState<"skip" | "pause" | null>(null);
  const [starting, setStarting] = useState<"update" | "rollback" | null>(null);
  // An update the security release popup or banner started from another page (lib/update-events.ts).
  const handed = useSyncExternalStore(subscribeStarted, startedUpdate, () => null);
  const [job, setJob] = useState<UpdateJob | null>(inFlight(status?.job) ? status.job : inFlight(handed) ? handed : null);
  const { manage } = useCan();
  const section = useRef<HTMLElement>(null);
  const toastId = useRef<string | null>(null);
  // When the API last answered about the job being followed.
  const heard = useRef(0);
  const checkLock = useRef(false);
  const actLock = useRef(false);
  // The newest status, read inside timers without restarting them.
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const running = inFlight(job);

  // An update started elsewhere (another tab, the CLI, the scheduler) shows up on a poll; follow it
  // here too. Adjusted while rendering, when the polled job changes, rather than in an effect.
  const polledJob = status?.job ?? null;
  const [seenJob, setSeenJob] = useState(polledJob);
  if (polledJob !== seenJob) {
    setSeenJob(polledJob);
    if (inFlight(polledJob) && !inFlight(job)) setJob(polledJob);
  }
  // The same for a job handed over while this card is already on screen.
  const [seenHanded, setSeenHanded] = useState(handed);
  if (handed !== seenHanded) {
    setSeenHanded(handed);
    if (inFlight(handed) && !inFlight(job)) setJob(handed);
  }

  // A handed over job brings the card into view; its progress goes back to the console's security
  // banner, which shows it and goes away once the fix is in.
  useEffect(() => {
    if (inFlight(handed)) section.current?.scrollIntoView({ block: "start" });
  }, [handed]);
  useEffect(() => {
    if (job) updateChanged(job);
  }, [job]);

  // Settles the toast and the card once a job ends.
  const finish = useCallback(
    (j: UpdateJob, next: UpdateStatus | null) => {
      const id = toastId.current ?? undefined;
      toastId.current = null;
      setJob(j);
      const back = j.kind === "rollback";
      if (j.state === "done") {
        toast.success(back ? `Rolled back to ${v(j.version)}` : "Dockify updated", {
          id,
          description: describe(back ? ["The database is back to its state before the update", "A fresh dump was taken first"] : [`Now on ${v(j.version)}`, "A checksummed database dump was taken first"], { preview }),
        });
      } else {
        const title = back ? "Rollback failed" : j.state === "rolledBack" ? "Update rolled back" : "Update failed";
        toast.error(title, { id, description: describe([`Still on ${v(j.from)}`, j.error ?? `${STEP[j.phase]} failed`], { preview }) });
      }
      if (next) return onStatus(next);
      // The preview has no API to ask, so the card writes the outcome into the status it has.
      const base = statusRef.current;
      if (!base) return;
      const ok = j.state === "done";
      onStatus({
        ...base,
        current: ok ? j.version : base.current,
        latest: ok && base.latest?.version === j.version ? null : base.latest,
        autoAt: ok && base.latest?.version === j.version ? null : base.autoAt,
        job: j,
        history: [j, ...base.history.filter((h) => h.id !== j.id)].slice(0, 20),
        rollback: ok ? (back ? null : { updateId: j.id, version: j.from, until: new Date(Date.now() + 7 * 86_400_000).toISOString() }) : base.rollback,
        // Updating to the security release, or past it, installs its fix.
        security: ok && !back && base.security && compareVersions(j.version, base.security.version) >= 0 ? null : base.security,
      });
    },
    [onStatus, preview],
  );

  // Follows a running job: the preview steps through on a timer, the API is polled and its
  // restart is ridden out until FOLLOW_MS.
  useEffect(() => {
    if (!inFlight(job)) return;
    const title = job.kind === "rollback" ? `Rolling back to ${v(job.version)}` : `Updating to ${v(job.version)}`;
    if (!toastId.current) toastId.current = toast.loading(title, { description: stepText(job) });
    else toast.loading(title, { id: toastId.current, description: stepText(job) });
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (preview) {
      timer = setTimeout(() => {
        const next = advance(job);
        if (next.state === "done") finish(next, null);
        else setJob(next);
      }, PREVIEW_STEP_MS);
      return () => clearTimeout(timer);
    }

    const started = Date.parse(job.startedAt);
    const tick = async () => {
      if (stop) return;
      // A failed answer means the control plane is restarting; keep asking.
      const r = await callJson<UpdatesResult>("/api/server/updates");
      const body = r.ok ? r.data : null;
      const j = body?.data?.job;
      if (!stop && body && j && j.id === job.id) {
        heard.current = Date.now();
        if (!inFlight(j)) return finish(j, body.data);
        if (!sameSteps(j, job)) return setJob(j);
      }
      if (stop) return;
      // Said once, for true silence, and the asking goes on: the result lands in this same toast.
      if (Date.now() - Math.max(started, heard.current) > FOLLOW_MS && heard.current !== WARNED) {
        heard.current = WARNED;
        toast.warn(job.kind === "rollback" ? "Rollback still running" : "Update still running", {
          id: toastId.current ?? undefined,
          description: "Dockify has not answered for 10 minutes. Check the server before trying again.",
        });
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [job, preview, finish]);

  const check = async () => {
    if (checkLock.current) return;
    checkLock.current = true;
    setChecking(true);
    try {
      const next = await send<UpdateStatus>("/api/server/updates/check", "POST", {});
      onStatus(next);
      if (next.checkError) toast.error("Could not check for updates", { description: describe(next.checkError, { preview }) });
      else if (next.latest) toast.info(`Dockify ${v(next.latest.version)} is available`, { description: describe([`Signed release on the ${next.channel} channel`, `You run ${v(next.current)}`], { preview }) });
      else toast.success("Dockify is up to date", { description: describe(`${v(next.current)} is the newest ${next.channel} release`, { preview }) });
    } catch (e) {
      toast.error("Could not check for updates", { description: describe(errText(e), { preview }) });
    } finally {
      checkLock.current = false;
      setChecking(false);
    }
  };

  /** Starts an update or a rollback; `send` asks "Confirm it is you" when the API wants a step-up, then sends again. */
  const start = async (kind: "update" | "rollback") => {
    const s = statusRef.current;
    if (!s || running || starting) return;
    const target = kind === "update" ? s.latest?.version : s.rollback?.version;
    if (!target) return;
    const title = kind === "update" ? `Updating to ${v(target)}` : `Rolling back to ${v(target)}`;
    setStarting(kind);
    try {
      const j =
        kind === "update"
          ? await send<UpdateJob>("/api/server/updates/apply", "POST", { version: target })
          : await send<UpdateJob>("/api/server/updates/rollback", "POST", { updateId: s.rollback!.updateId });
      toastId.current = toast.loading(title, { description: stepText(j) });
      setJob(j);
    } catch (e) {
      if (wasCancelled(e)) return;
      toast.error(kind === "update" ? "Update did not start" : "Rollback did not start", { description: describe([`Still on ${v(s.current)}`, errText(e)], { preview }) });
    } finally {
      setStarting(null);
    }
  };

  const skip = async (version: string | null) => {
    if (actLock.current) return;
    actLock.current = true;
    setActing("skip");
    try {
      onStatus(await send<UpdateStatus>("/api/server/updates/skip", "POST", { version }));
      if (version) toast.success(`Skipped ${v(version)}`, { description: describe(["Automatic installs leave this version alone", "You can still update by hand"], { preview }) });
      else toast.success("Skip cleared", { description: describe("Automatic installs may pick this version again", { preview }) });
    } catch (e) {
      if (wasCancelled(e)) return;
      toast.error(version ? "Could not skip this version" : "Could not clear the skip", { description: describe(errText(e), { preview }) });
    } finally {
      actLock.current = false;
      setActing(null);
    }
  };

  const pause = async (days: 0 | 7) => {
    if (actLock.current) return;
    actLock.current = true;
    setActing("pause");
    try {
      onStatus(await send<UpdateStatus>("/api/server/updates/pause", "POST", { days }));
      if (days) toast.success("Automatic updates paused", { description: describe(["For 7 days", "Checks keep running and you can still update by hand"], { preview }) });
      else toast.success("Automatic updates resumed", { description: describe("The next release installs in its window", { preview }) });
    } catch (e) {
      if (wasCancelled(e)) return;
      toast.error(days ? "Could not pause updates" : "Could not resume updates", { description: describe(errText(e), { preview }) });
    } finally {
      actLock.current = false;
      setActing(null);
    }
  };

  const latest = status?.latest ?? null;
  const policy = status?.policy ?? null;
  const shownJob = job ?? (status?.job && status.job.state !== "done" ? status.job : null);
  const justDone = job?.state === "done";
  const skipped = Boolean(latest && policy?.skipVersion === latest.version);
  const paused = Boolean(policy?.pausedUntil && Date.parse(policy.pausedUntil) > now);
  const rollback = status?.rollback && Date.parse(status.rollback.until) > now ? status.rollback : null;
  const notesUrl = latest ? safeHref(latest.notesUrl) : null;
  const channel = status?.channel === "beta" ? "Beta" : "Stable";

  return (
    // `updates` is the anchor the bell, the emails and the security release popup link to (/server#updates).
    <section ref={section} id="updates" className="card srv-up" aria-labelledby="srv-up-title">
      <div className="card-hd">
        <CardTitle
          id="srv-up-title"
          icon="download"
          title="Updates"
          sub={!status ? "Signed releases only" : !status.configured ? "Not configured" : <When iso={status.checkedAt} now={now} prefix="Checked" fallback="Never checked" />}
        />
        {manage ? (
          <PendingButton className="btn btn-sm" onClick={() => void check()} pending={checking} disabled={!status?.configured || running}>
            Check now
          </PendingButton>
        ) : null}
      </div>

      {/* Nothing to manage yet: one line in the card, not a tall empty panel. */}
      {!status ? (
        <div className="srv-up-body">
          <Callout>The API did not answer for updates. This page retries on its own.</Callout>
        </div>
      ) : !status.configured ? (
        <div className="srv-up-body">
          <Callout>
            Dockify {v(status.current)} has no release feed or signing key. Set <code className="md-code">DOCKIFY_RELEASE_FEED</code> and{" "}
            <code className="md-code">DOCKIFY_RELEASE_PUBKEY</code> in its environment, then restart it.
          </Callout>
        </div>
      ) : (
        <div className="srv-up-body">
          <dl className="srv-up-facts">
            <div className="kv">
              <dt className="kv-label">Current version</dt>
              <dd className="kv-value num">{v(status.current)}</dd>
            </div>
            <div className="kv">
              <dt className="kv-label">Channel</dt>
              <dd className="kv-value">
                <Chip size="xs" icon={<Icon name="shieldCheck" size={12} />}>
                  {channel}, signed
                </Chip>
              </dd>
            </div>
            <div className="kv">
              <dt className="kv-label">Next check</dt>
              <dd className="kv-value">{status.nextCheckAt ? <Until iso={status.nextCheckAt} now={now} expired="Due now" /> : <span className="none">Not scheduled</span>}</dd>
            </div>
            <div className="kv">
              <dt className="kv-label">Policy</dt>
              <dd className="kv-value">{policy ? (paused ? "Paused" : modeLabel(policy.mode)) : "Unknown"}</dd>
            </div>
          </dl>

          {status.checkError ? (
            <Callout tone="bad" icon="alert" role="status">
              Last check failed: {status.checkError}
            </Callout>
          ) : null}

          {shownJob ? <Steps job={shownJob} /> : null}

          <div className="srv-up-cols">
            <div className="srv-up-main">
              {status.security && !justDone ? <SecurityNote security={status.security} /> : null}
              {latest && !justDone ? (
                <div className="srv-up-release">
                  <div className="srv-up-rel-hd">
                    <span className="two">
                      <span className="two-main num">Dockify {v(latest.version)}</span>
                      <span className="two-sub">
                        <When iso={latest.publishedAt} now={now} prefix="Released" />
                      </span>
                    </span>
                    <span className="srv-up-chips">
                      {latest.critical ? (
                        <Chip size="xs" tone="warn">
                          Security release
                        </Chip>
                      ) : null}
                      <Chip size="xs" tone="ok">
                        Signed
                      </Chip>
                    </span>
                  </div>

                  {latest.notes.trim() ? <Notes source={latest.notes} label={`What is new in ${v(latest.version)}`} /> : <p className="fld-note">No release notes for this version.</p>}

                  {latest.migration ? (
                    <p className="fld-note">
                      <span className="srv-up-key">Database</span> {latest.migration}
                    </p>
                  ) : null}
                  {notesUrl ? (
                    <ExternalLink className="srv-up-link" href={notesUrl}>
                      Full release notes
                    </ExternalLink>
                  ) : null}
                </div>
              ) : !shownJob ? (
                <p className="srv-up-latest">
                  <Icon name="checkCircle" size={16} />
                  You run the newest {channel.toLowerCase()} release
                </p>
              ) : null}

              {latest && !justDone && manage ? (
                <div className="srv-up-acts">
                  <div className="srv-up-act">
                    <PendingButton
                      className="btn btn-primary"
                      onClick={() => setConfirming("apply")}
                      pending={running || starting === "update"}
                      disabled={!latest.signed || (starting !== null && starting !== "update")}
                      icon="download"
                    >
                      Update now
                    </PendingButton>
                    <PendingButton className="btn" onClick={() => void skip(skipped ? null : latest.version)} pending={acting === "skip"} disabled={running || acting === "pause"}>
                      {skipped ? "Undo skip" : "Skip this version"}
                    </PendingButton>
                  </div>
                  <p className="fld-note">Backs up the database first and rolls back on any failure</p>
                  {skipped ? (
                    <p className="fld-note">Skipped. Automatic installs leave {v(latest.version)} alone.</p>
                  ) : status.autoAt ? (
                    <p className="fld-note srv-up-when">
                      <Icon name="clock" size={14} />
                      <Until iso={status.autoAt} now={now} prefix="Installs automatically" expired="Installs automatically soon" />
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="srv-up-side">
              {policy && policy.mode !== "manual" ? (
                <div className="srv-up-row">
                  <span className="two">
                    <span className="two-main">Automatic updates</span>
                    <span className="two-sub">
                      {paused && policy.pausedUntil ? <Until iso={policy.pausedUntil} now={now} prefix="Paused, resumes" /> : "Install in their window, from Settings, Updates"}
                    </span>
                  </span>
                  {manage ? (
                    <PendingButton className="btn btn-sm" onClick={() => void pause(paused ? 0 : 7)} pending={acting === "pause"} disabled={acting === "skip"}>
                      {paused ? "Resume" : "Pause 7 days"}
                    </PendingButton>
                  ) : null}
                </div>
              ) : null}

              {status.blocked ? (
                <div className="srv-up-row">
                  <span className="two">
                    <span className="two-main">Dockify {v(status.blocked.version)} is out</span>
                    <span className="two-sub">Offered once {v(status.blocked.minFrom)} is installed</span>
                  </span>
                  <Chip size="xs" tone="idle">
                    Needs {v(status.blocked.minFrom)} first
                  </Chip>
                </div>
              ) : null}

              {rollback ? (
                <div className="srv-up-row">
                  <span className="two">
                    <span className="two-main">Return to {v(rollback.version)}</span>
                    <span className="two-sub">
                      <Until iso={rollback.until} now={now} prefix="Expires" expired="No longer available" />
                    </span>
                  </span>
                  {manage ? (
                    <PendingButton
                      className="btn btn-sm"
                      onClick={() => setConfirming("rollback")}
                      pending={starting === "rollback"}
                      disabled={running || starting === "update"}
                    >
                      Roll back to {v(rollback.version)}
                    </PendingButton>
                  ) : null}
                </div>
              ) : null}

              <p className="fld-note srv-up-foot">
                Policy, channel and window live in <Link href="/settings?section=updates">Settings, Updates</Link>.
              </p>
            </div>
          </div>

          <History jobs={status.history} now={now} />
        </div>
      )}

      {status && latest ? (
        <ConfirmDialog
          open={confirming === "apply"}
          onClose={() => setConfirming(null)}
          title={`Update to ${v(latest.version)}`}
          sub={`From ${v(status.current)}, ${status.channel} channel`}
          confirmLabel="Update now"
          confirmIcon="download"
          onConfirm={() => {
            setConfirming(null);
            void start("update");
          }}
          body={
            <>
              <p className="dlg-text">Dockify restarts its own services during the update. Running apps keep serving; new deploys wait until it is back.</p>
              <ol className="sb-dlg-list srv-up-plan">
                {UPDATE_STEPS.filter((id) => PLAN[id]).map((id) => (
                  <li key={id}>
                    <span className="sb-dlg-li-hd">{PLAN[id]}</span>
                  </li>
                ))}
              </ol>
              <p className="sb-dlg-note">
                If any step fails, Dockify rolls back on its own to the {v(status.current)} image digests, and restores the database backup when migrations ran.
              </p>
            </>
          }
        />
      ) : null}

      {status && rollback ? (
        // A rollback takes a fresh backup first, so nothing is lost for good: the default key, not the red one.
        <ConfirmDialog
          open={confirming === "rollback"}
          onClose={() => setConfirming(null)}
          title={`Roll back to ${v(rollback.version)}`}
          sub={`From ${v(status.current)}`}
          confirmLabel={`Roll back to ${v(rollback.version)}`}
          confirmIcon="rollback"
          onConfirm={() => {
            setConfirming(null);
            void start("rollback");
          }}
          body={
            <>
              <p className="dlg-text">
                The control-plane database returns to its state before the update to {v(status.current)}. Changes made in Dockify since then (settings, projects, deploy records) are lost. A fresh backup is taken first, so nothing is deleted for good.
              </p>
              <p className="sb-dlg-note">The {v(rollback.version)} images come back for the API, worker and dashboard, one at a time. Running apps keep serving.</p>
            </>
          }
        />
      ) : null}
    </section>
  );
}

/**
 * The pending security release from the signed feed, over the release it ships in: its level, what
 * it fixes, the CVE ids and the advisory. The same release the console's popup and banner announce.
 */
function SecurityNote({ security }: { security: SecurityRelease }) {
  const advisory = security.advisory ? safeHref(security.advisory) : null;
  return (
    <Callout tone="bad" icon="alert" className="srv-up-sec">
      <b>
        {levelLabel(security.level)} security release {v(security.version)}
      </b>
      <span>{security.summary}</span>
      {security.cves.length || advisory ? (
        <span className="srv-up-sec-meta">
          {security.cves.length ? <span className="num">{security.cves.join(", ")}</span> : null}
          {advisory ? (
            <ExternalLink className="srv-up-link" href={advisory}>
              Read the advisory
            </ExternalLink>
          ) : null}
        </span>
      ) : null}
    </Callout>
  );
}
