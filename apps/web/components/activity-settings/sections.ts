import type { IconName } from "@/components/icon";

/* Settings sections, shared by the server page (to read ?section=) and the client view. */
export const SECTION_IDS = ["profile", "preferences", "security", "team", "integrations", "notifications", "instance", "updates", "tokens"] as const;

export type SectionId = (typeof SECTION_IDS)[number];

export const isSectionId = (v: unknown): v is SectionId => SECTION_IDS.some((id) => id === v);

interface SectionMeta {
  id: SectionId;
  label: string;
  icon: IconName;
}

/** Instance reset is not here on purpose: it is an SSH command, so no web session can erase the server. */
export const SECTION_GROUPS: Array<{ label: string; sections: SectionMeta[] }> = [
  {
    label: "Account",
    sections: [
      { id: "profile", label: "Profile", icon: "user" },
      { id: "preferences", label: "Preferences", icon: "sliders" },
      { id: "security", label: "Security", icon: "shieldCheck" },
    ],
  },
  {
    label: "Workspace",
    sections: [
      { id: "team", label: "Team", icon: "users" },
      { id: "integrations", label: "Integrations", icon: "link" },
      { id: "notifications", label: "Notifications", icon: "bell" },
      { id: "instance", label: "Instance", icon: "server" },
      { id: "updates", label: "Updates", icon: "download" },
      { id: "tokens", label: "API tokens", icon: "key" },
    ],
  },
];

export const SECTIONS: SectionMeta[] = SECTION_GROUPS.flatMap((g) => g.sections);

interface TabMeta {
  value: string;
  label: string;
  /** The id of the block this segment holds, so a #set-2fa style link opens the right segment. */
  group: string;
}

/** The open segment lives in ?tab= and the first one is the bare URL, so plain ?section= links still land. */
export const SECTION_TABS: Partial<Record<SectionId, readonly TabMeta[]>> = {
  preferences: [
    { value: "time", label: "Time and date", group: "set-time" },
    { value: "email", label: "Email", group: "set-mail" },
    { value: "keyboard", label: "Keyboard", group: "set-keys" },
  ],
  security: [
    { value: "two-factor", label: "Two-factor", group: "set-2fa" },
    { value: "password", label: "Password", group: "set-password" },
    { value: "sessions", label: "Sessions", group: "set-sessions" },
  ],
  team: [
    { value: "members", label: "Members", group: "set-team" },
    { value: "invites", label: "Invites", group: "set-invites" },
  ],
  notifications: [
    { value: "events", label: "Events", group: "set-events" },
    { value: "channels", label: "Channels", group: "set-channels" },
  ],
  instance: [
    { value: "general", label: "General", group: "set-instance" },
    { value: "domain", label: "Dashboard domain", group: "set-dashboard-domain" },
  ],
};

export const firstTab = (section: SectionId): string | null => SECTION_TABS[section]?.[0]?.value ?? null;

/** Null for a section without segments. */
export const tabFor = (section: SectionId, asked: unknown): string | null => SECTION_TABS[section]?.find((t) => t.value === asked)?.value ?? firstTab(section);

/** Where a #set-2fa style link lands, or null when the hash names no segmented block. */
export function groupTarget(hash: string): { section: SectionId; tab: string } | null {
  const id = hash.replace(/^#/, "");
  for (const section of SECTION_IDS) {
    const tab = SECTION_TABS[section]?.find((t) => t.group === id);
    if (tab) return { section, tab: tab.value };
  }
  return null;
}
