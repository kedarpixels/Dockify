"use client";

import { useMemo } from "react";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { SECTION_TABS, SECTIONS, type SectionId } from "./sections";

/**
 * A long section's segments, the one way Settings splits a section that would not fit the fixed
 * panel: the shared Tabs strip, ruled off above the blocks and held in place while a long list
 * scrolls under it. Every segment stays mounted inside the one panel, which is named by the open
 * tab, so unsaved edits survive a switch. The save bar sits outside, after this, so it shows on
 * every segment.
 *
 *   <SectionTabs section="team" tab={tab} onTab={onTab} counts={{ members: 3 }}>
 *     <Segment value="members" tab={tab}>...</Segment>
 *   </SectionTabs>
 */
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
  /** How many things a segment holds, by its value. */
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

/** One segment of a SectionTabs: always mounted, shown while it is the open one. */
export function Segment({ value, tab, children }: { value: string; tab: string; children: React.ReactNode }) {
  return (
    <div className="set-seg" hidden={value !== tab}>
      {children}
    </div>
  );
}
