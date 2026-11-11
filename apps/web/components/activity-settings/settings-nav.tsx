"use client";

import { Icon } from "@/components/icon";
import { DOCS_URL } from "@/components/shell/nav";
import { v } from "@/components/server-backups/util";
import { Node } from "@/components/ui/rule";
import type { SettingsData } from "@/lib/pages/activity-settings";
import type { IntegrationsSummary } from "@/lib/pages/integrations";
import type { UpdateMode } from "@/lib/pages/server-backups";
import { SECTION_GROUPS, type SectionId } from "./sections";

/* Wide pages only: narrow ones get the section dropdown in the content column. */

interface NavMeta {
  text: string;
  tone?: "ok" | "idle";
  /** Read after the visible text, never instead of it, so the name starts with what is shown ("Off, two-factor"). */
  sr?: string;
}

function connected(i: IntegrationsSummary, emailOn: boolean): number {
  const c = i.connected;
  if (c) return [c.github, c.vercel, c.cloudflare, c.registries, c.storage, c.webhooks, c.email].filter(Boolean).length;
  return [
    i.github.accounts > 0,
    i.vercel !== null,
    i.cloudflare !== null,
    i.registries.length > 0,
    i.storage.length > 0,
    i.webhooks.length > 0,
    emailOn,
  ].filter(Boolean).length;
}

export function navMeta(data: SettingsData | null, integrations: IntegrationsSummary, emailOn: boolean, updates: UpdateMode | null): Partial<Record<SectionId, NavMeta>> {
  const n = connected(integrations, emailOn);
  const meta: Partial<Record<SectionId, NavMeta>> = { integrations: { text: `${n} of 7`, sr: " connected" } };
  if (updates) meta.updates = updates === "manual" ? { text: "Manual", sr: ", installs by hand" } : { text: "Auto", sr: ", installs automatically" };
  if (!data) return meta;
  const members = data.team.members.length;
  const tokens = data.tokens.length;
  const tfa = data.me.twoFactor.enabled;
  meta.security = { text: tfa ? "On" : "Off", tone: tfa ? "ok" : "idle", sr: ", two-factor" };
  meta.team = { text: members.toLocaleString("en-US"), sr: members === 1 ? " member" : " members" };
  meta.tokens = { text: tokens.toLocaleString("en-US"), sr: tokens === 1 ? " token" : " tokens" };
  return meta;
}

export function SettingsNav({
  active,
  dirty,
  meta,
  version,
  onGo,
}: {
  active: SectionId;
  dirty: Partial<Record<SectionId, boolean>>;
  meta: Partial<Record<SectionId, NavMeta>>;
  version: string | null;
  onGo: (id: SectionId) => void;
}) {
  return (
    <nav className="set-snav" aria-label="Settings sections">
      <Node pos="tr" />
      {SECTION_GROUPS.map((g) => {
        const labelId = `set-snav-${g.label.toLowerCase()}`;
        return (
          <div key={g.label} className="set-snav-group">
            {/* A list label, not a heading: the section's own title is the heading beside it. */}
            <p id={labelId} className="set-snav-hd">
              {g.label}
            </p>
            <ul className="set-snav-list" aria-labelledby={labelId}>
              {g.sections.map((s) => {
                const m = meta[s.id];
                return (
                  <li key={s.id}>
                    <a
                      href={`?section=${s.id}`}
                      className="set-snav-item"
                      aria-current={active === s.id ? "page" : undefined}
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                        e.preventDefault();
                        onGo(s.id);
                      }}
                    >
                      <Icon name={s.icon} />
                      <span className="set-snav-label">{s.label}</span>
                      {dirty[s.id] ? (
                        <>
                          <span className="dot set-nav-dirty" data-tone="live" data-tip="Unsaved changes" aria-hidden="true" />
                          <span className="sr">, unsaved changes</span>
                        </>
                      ) : m ? (
                        <span className="set-snav-meta num">
                          {m.tone ? <span className="dot" data-tone={m.tone} aria-hidden="true" /> : null}
                          {m.text}
                          {m.sr ? <span className="sr">{m.sr}</span> : null}
                        </span>
                      ) : null}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      <div className="set-snav-foot">
        <Node pos="br" />
        {version ? <span className="set-snav-ver num">Dockify {v(version)}</span> : null}
        <a className="set-snav-docs" href={DOCS_URL} target="_blank" rel="noreferrer">
          Docs
          <Icon name="external" size={14} />
        </a>
      </div>
    </nav>
  );
}
