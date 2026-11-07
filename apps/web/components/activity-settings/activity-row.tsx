"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon, type IconName } from "@/components/icon";
import { ActorAvatar } from "@/components/ui/actor-avatar";
import { IconTile } from "@/components/ui/icon-tile";
import { When } from "@/components/ui/when";
import type { ActivityCategory, ActivityChange, ActivityEvent } from "@/lib/pages/activity-settings";

/* One activity log row, with its diff. The time reads like every day-grouped list: relative, with
   the absolute moment in the reader's zone in its tip. */

/** Who a row names when Dockify itself acted: backups, prunes, renewals, failed builds. */
export const SYSTEM_NAME = "Dockify";

const CATEGORY_ICON: Record<ActivityCategory, IconName> = { deploys: "deploy", config: "sliders", access: "key", system: "server" };

/**
 * A glyph per kind of event; anything unknown falls back to its category glyph. Keys are the audit
 * action names the API and worker write, then the few that only the preview fixtures use.
 */
const ACTION_ICON: Record<string, IconName> = {
  "deployment.redeploy": "refresh",
  "deployment.rollback": "rollback",
  "deployment.cancel": "slash",
  "app.start": "play",
  "app.stop": "stop",
  "app.restart": "refresh",
  "env.apply": "code",
  "env.rollback": "rollback",
  "env.reveal": "eye",
  "domain.create": "globe",
  "domain.delete": "globe",
  "settings.update": "sliders",
  "alert.rule.create": "bell",
  "alert.rule.update": "bell",
  "alert.rule.delete": "bell",
  "alert.mute": "pause",
  "alert.unmute": "bell",
  "auth.login": "user",
  "auth.login.denied": "lock",
  "auth.logout": "logout",
  "auth.mfa.enable": "shieldCheck",
  "auth.mfa.disable": "shield",
  "me.sessions.revoke": "logout",
  "me.sessions.revokeOthers": "logout",
  "token.create": "key",
  "team.invite": "mail",
  "team.join": "users",
  "backup.run": "archive",
  "backup.restore": "archive",
  "backup.test": "archive",
  "backup.download": "download",
  // Preview fixtures.
  "deploy.redeploy": "refresh",
  "deploy.rollback": "rollback",
  "deploy.cancelled": "slash",
  "env.update": "code",
  "domain.add": "globe",
  "domain.remove": "globe",
  "auth.login_failed": "lock",
  "auth.2fa_enabled": "shieldCheck",
  "session.revoke": "logout",
  "backup.failed": "archive",
  prune: "trash",
  "tls.renew": "lock",
};

/** Full ids in a sentence ("deployment:a52c374d-8dbc-...") read by their first 8 characters. */
const UUID = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const shortIds = (text: string) => text.replace(UUID, "$1");

function where(e: ActivityEvent) {
  return [e.ip, e.location].filter(Boolean).join(", ");
}

/**
 * How the suffix joins the sentence: after a preposition it simply runs on ("to fieldnote / api",
 * "as Viewer"); a fact about the target (a size, a reason) follows a comma ("inkwell / postgres,
 * 412 MB").
 */
const RUNS_ON = /^(from|to|with|as|for|on|in|into|by|at|via|of)\b/;
const joinSuffix = (e: ActivityEvent, suffix: string) => (e.target && !RUNS_ON.test(suffix) ? `, ${suffix}` : ` ${suffix}`);

/** Old value, an arrow, the new value. Values arrive masked; a missing side reads added or removed. */
function Diff({ id, changes }: { id: string; changes: ActivityChange[] }) {
  return (
    <div id={id} className="act-diff">
      <dl className="act-diff-list">
        {changes.map((c) => (
          <div key={c.key} className="act-diff-row">
            <dt className="act-diff-key">{c.key}</dt>
            <dd className="act-diff-vals num">
              {c.before === null ? <span className="none act-diff-none">Not set</span> : <span className="act-diff-old">{c.before}</span>}
              <Icon name="arrowRight" size={14} className="act-diff-arrow" />
              {c.after === null ? <span className="none act-diff-none">Removed</span> : <span className="act-diff-new">{c.after}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function EventRow({ e, now, open, fresh, onToggle }: { e: ActivityEvent; now: number; open: boolean; fresh: boolean; onToggle: () => void }) {
  const router = useRouter();
  const diffId = `diff-${e.id}`;
  const changes = e.changes ?? [];
  const detail = changes.length > 0;
  const place = where(e);
  return (
    <li className={fresh ? "act-item act-fresh" : "act-item"} data-open={open || undefined}>
      <div
        className="soft-row act-row"
        // Only a row that opens something lights up under the pointer: its diff, or its target page.
        data-hover={detail || !!e.target?.href || undefined}
        data-expandable={detail || undefined}
        tabIndex={-1}
        onKeyDown={(ev) => {
          // Enter on a focused row opens it: the diff when it has one, else the target page.
          if (ev.key !== "Enter" || ev.target !== ev.currentTarget) return;
          ev.preventDefault();
          if (detail) onToggle();
          else if (e.target?.href) router.push(e.target.href);
        }}
        onClick={(ev) => {
          // The row toggles its diff, except when the click lands on the target link or the key.
          if (detail && !(ev.target instanceof Element && ev.target.closest("a, button"))) onToggle();
        }}
      >
        <IconTile data-tone={e.tone ?? undefined}>
          <Icon name={ACTION_ICON[e.action] ?? CATEGORY_ICON[e.category]} />
        </IconTile>
        <p className="act-text">
          <span className="act-who">
            <ActorAvatar kind={e.actor ? (e.actor.kind ?? "user") : "system"} url={e.actor?.avatarUrl} name={e.actor?.name} />
            <span className="act-actor">{e.actor?.name ?? SYSTEM_NAME}</span>
          </span>{" "}
          <span className={e.tone === "bad" ? "tone-bad" : undefined}>{e.verb}</span>
          {e.target ? (
            <>
              {" "}
              {e.target.href ? (
                <Link href={e.target.href} className="act-target">
                  {e.target.label}
                </Link>
              ) : (
                <span className="act-target">{e.target.label}</span>
              )}
            </>
          ) : null}
          {e.suffix ? <span className="act-suffix">{joinSuffix(e, shortIds(e.suffix))}</span> : null}
        </p>
        <span className="act-where num">{place || (e.actor ? "" : "Automatic")}</span>
        <When iso={e.at} now={now} className="act-time num" tipAlign="end" />
        <span className="act-exp">
          {detail ? (
            <button
              type="button"
              className="btn btn-xs btn-icon act-exp-key"
              aria-expanded={open}
              // Points at the changes only while they are in the page.
              aria-controls={open ? diffId : undefined}
              aria-label={`${open ? "Hide" : "Show"} changes${e.target ? ` to ${e.target.label}` : ""}`}
              onClick={onToggle}
            >
              <Icon name="chevronDown" />
            </button>
          ) : null}
        </span>
      </div>
      {detail && open ? <Diff id={diffId} changes={changes} /> : null}
    </li>
  );
}
