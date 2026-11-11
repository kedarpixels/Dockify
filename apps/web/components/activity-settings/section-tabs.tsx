"use client";

import { useMemo } from "react";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { SECTION_TABS, SECTIONS, type SectionId } from "./sections";

/** Every segment stays mounted, so unsaved edits survive a switch. The save bar sits outside, so it shows on every segment. */
export function SectionTabs({
  section,
  tab,
  onTab,
  counts,
  children,
}: {
  section: SectionId;
  tab: string;
  onTab: (next: string) => void;
  counts?: Record<string, number>;
  children: React.ReactNode;
}) {
  const id = `set-${section}`;
  const name = SECTIONS.find((s) => s.id === section)?.label ?? section;
  const key = JSON.stringify(counts ?? null);
  const tabs = useMemo(() => {
    const known: Record<string, number> | null = JSON.parse(key);
    return (SECTION_TABS[section] ?? []).map((t) => ({ value: t.value, label: t.label, count: known?.[t.value] }));
  }, [section, key]);
  return (
    <>
      <div className="set-tabs">
        <Tabs id={id} label={`${name} sections`} value={tab} onChange={onTab} tabs={tabs} />
      </div>
      <TabPanel id={id} value={tab} className="set-tabpanel">
        {children}
      </TabPanel>
    </>
  );
}

export function Segment({ value, tab, children }: { value: string; tab: string; children: React.ReactNode }) {
  return (
    <div className="set-seg" hidden={value !== tab}>
      {children}
    </div>
  );
}
