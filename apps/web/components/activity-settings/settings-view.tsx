"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Topbar } from "@/components/shell/topbar";
import { NoSource } from "@/components/ui/no-source";
import { Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { useLeaveGuard } from "@/components/ui/leave-guard";
import { Select } from "@/components/ui/select";
import { deriveNotices } from "@/lib/derive";
import { useNow, useOverview } from "@/lib/hooks";
import type { SettingsData, SettingsResult } from "@/lib/pages/activity-settings";
import type { IntegrationsResult } from "@/lib/pages/integrations";
import type { UpdateMode } from "@/lib/pages/server-backups";
import type { OverviewResult } from "@/lib/types";
import { InstanceSection } from "./instance-section";
import { IntegrationsSection } from "./integrations/integrations-section";
import { NotificationsSection } from "./notifications-section";
import { PreferencesSection } from "./preferences-section";
import { ProfileSection } from "./profile-section";
import { firstTab, groupTarget, isSectionId, SECTION_IDS, SECTIONS, tabFor, type SectionId } from "./sections";
import { SecuritySection } from "./security-section";
import { navMeta, SettingsNav } from "./settings-nav";
import { useStepUp, type Elevate } from "@/components/step-up/step-up";
import { TeamSection } from "./team-section";
import { TokensSection } from "./tokens-section";
import { UpdatesSection } from "./updates-section";

export interface SectionProps {
  data: SettingsData;
  update: (patch: Partial<SettingsData>) => void;
  onDirty: (dirty: boolean) => void;
  now: number;
  preview: boolean;
  go: (id: SectionId) => void;
  tab: string;
  onTab: (next: string) => void;
  /** An email integration is connected: invites can be emailed, email changes need a code. */
  emailEnabled: boolean;
  /** Runs a write, asking "Confirm it is you" when the API wants a fresh step-up. */
  elevate: Elevate;
  /** Empty when the list did not load. */
  projects: string[];
}

/** Every section and segment stays mounted (only one shows), so unsaved edits survive a visit to another. */
export function SettingsView({
  overview,
  initial,
  integrations,
  section,
  tab,
  version = null,
}: {
  overview: OverviewResult;
  initial: SettingsResult;
  integrations: IntegrationsResult;
  section: SectionId;
  /** An unknown ?tab= opens the section's first segment. */
  tab?: string;
  /** Null when the build does not say. */
  version?: string | null;
}) {
  const { result } = useOverview(overview);
  const now = useNow(30_000, initial.fetchedAt);
  const notices = useMemo(() => (result.data ? deriveNotices(result.data, now) : null), [result.data, now]);

  const [active, setActive] = useState<SectionId>(section);
  // The open segment per section, so coming back to a section finds it as it was left.
  const [tabs, setTabs] = useState<Partial<Record<SectionId, string>>>(() => {
    const open = tabFor(section, tab);
    return open ? { [section]: open } : {};
  });
  const [data, setData] = useState<SettingsData | null>(initial.data);
  const [dirty, setDirty] = useState<Partial<Record<SectionId, boolean>>>({});
  const [emailEnabled, setEmailEnabled] = useState(integrations.data.connected?.email ?? integrations.data.email !== null);
  const [updateMode, setUpdateMode] = useState<UpdateMode | null>(null);
  const { elevate } = useStepUp();
  const col = useRef<HTMLDivElement>(null);

  const openTab = tabs[active];

  useEffect(() => {
    col.current?.querySelectorAll(".set-pane, .set-tabpanel, .set-body").forEach((el) => el.scrollTo(0, 0));
  }, [active, openTab]);

  /** Keeps any other query (github=installed); the first segment is the bare URL. */
  const pushView = (id: SectionId, t: string | undefined) => {
    const url = new URL(window.location.href);
    url.searchParams.set("section", id);
    if (t && t !== firstTab(id)) url.searchParams.set("tab", t);
    else url.searchParams.delete("tab");
    window.history.pushState(null, "", url);
  };

  const go = (id: SectionId) => {
    if (id === active) return;
    setActive(id);
    pushView(id, tabs[id]);
    // The focus moves into the new section, so the switch is heard and Tab goes on into it, not down the nav.
    requestAnimationFrame(() => {
      const pane = `[data-pane="${id}"]`;
      const key = document.querySelector<HTMLElement>(`${pane} [role="tab"][aria-selected="true"]`);
      if (key?.offsetWidth) return key.focus({ preventScroll: true });
      const h = document.querySelector<HTMLElement>(`${pane} h2`);
      if (!h) return;
      h.tabIndex = -1;
      h.focus({ preventScroll: true });
    });
  };

  const goTab = (id: SectionId, next: string) => {
    if (next === tabs[id]) return;
    setTabs((t) => ({ ...t, [id]: next }));
    pushView(id, next);
  };

  useEffect(() => {
    const onPop = () => {
      const q = new URL(window.location.href).searchParams;
      const s = q.get("section");
      const id = isSectionId(s) ? s : "profile";
      setActive(id);
      const open = tabFor(id, q.get("tab"));
      if (open) setTabs((t) => ({ ...t, [id]: open }));
    };
    const onHash = () => {
      const target = groupTarget(window.location.hash);
      if (!target) return;
      setActive(target.section);
      setTabs((t) => ({ ...t, [target.section]: target.tab }));
    };
    onHash();
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", onHash);
    };
  }, []);

  // Every section stays mounted, so switching sections never asks; only leaving the page does.
  const anyDirty = Object.values(dirty).some(Boolean);
  const leaveGuard = useLeaveGuard(anyDirty, { ignoreQuery: true });

  const update = useCallback((patch: Partial<SettingsData>) => setData((d) => (d ? { ...d, ...patch } : d)), []);
  const dirtyFor = useMemo(
    () => Object.fromEntries(SECTION_IDS.map((id) => [id, (v: boolean) => setDirty((s) => (s[id] === v ? s : { ...s, [id]: v }))])) as Record<SectionId, (v: boolean) => void>,
    [],
  );

  const current = SECTIONS.find((s) => s.id === active)!;
  const meta = useMemo(() => navMeta(data, integrations.data, emailEnabled, updateMode), [data, integrations.data, emailEnabled, updateMode]);
  const o = result.data;
  const projects = useMemo(() => (o ? (o.projects?.map((p) => p.slug) ?? [...new Set(o.resources.map((r) => r.projectSlug))]) : []), [o]);

  return (
    <>
      <Topbar trail={["Settings"]} notices={notices} now={now} />
      <main className="page" id="main" tabIndex={-1}>
        <SectionHead level={1} title="Settings" lead="Your account, your team and how this Dockify instance behaves." />
        <Rule />

        <div className="set-layout">
          <SettingsNav active={active} dirty={dirty} meta={meta} version={version} onGo={go} />

          <section className="set-main" aria-label={current.label}>
            <div ref={col} className="set-col">
              <div className="set-pick">
                <Select
                  label="Settings section"
                  value={active}
                  onChange={go}
                  fullHeight
                  options={SECTIONS.map((s) => ({ value: s.id, label: dirty[s.id] ? `${s.label}, unsaved` : s.label, icon: s.icon, hint: dirty[s.id] ? undefined : meta[s.id]?.text }))}
                />
              </div>
              {SECTIONS.map((s) => {
                const props: SectionProps | null = data ? { data, update, onDirty: dirtyFor[s.id], now, preview: initial.source === "preview", go, tab: tabs[s.id] ?? firstTab(s.id) ?? "", onTab: (next) => goTab(s.id, next), emailEnabled, elevate, projects } : null;
                return (
                  <div key={s.id} className="set-pane" data-pane={s.id} hidden={active !== s.id}>
                    {s.id === "integrations" ? (
                      <IntegrationsSection initial={integrations} overview={result.data} now={now} onEmail={setEmailEnabled} />
                    ) : !props ? (
                      <NoSource error={initial.error} />
                    ) : (
                      <>
                        {s.id === "profile" ? <ProfileSection {...props} /> : null}
                        {s.id === "preferences" ? <PreferencesSection {...props} /> : null}
                        {s.id === "security" ? <SecuritySection {...props} /> : null}
                        {s.id === "team" ? <TeamSection {...props} /> : null}
                        {s.id === "notifications" ? <NotificationsSection {...props} /> : null}
                        {s.id === "instance" ? <InstanceSection {...props} /> : null}
                        {s.id === "updates" ? <UpdatesSection {...props} onMode={setUpdateMode} /> : null}
                        {s.id === "tokens" ? <TokensSection {...props} /> : null}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </div>
        <Spacer end />
      </main>
      {leaveGuard}
    </>
  );
}
