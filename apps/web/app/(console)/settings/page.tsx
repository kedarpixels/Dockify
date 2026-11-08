import type { Metadata } from "next";
import { isSectionId } from "@/components/activity-settings/sections";
import { SettingsView } from "@/components/activity-settings/settings-view";
import { getOverview } from "@/lib/data";
import { getSettings } from "@/lib/pages/activity-settings";
import { getIntegrations } from "@/lib/pages/integrations";
import { isPreviewMode } from "@/lib/preview-mode";

export const metadata: Metadata = { title: "Settings" };

type Params = Record<string, string | string[] | undefined>;

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const asked = Array.isArray(params.section) ? params.section[0] : params.section;
  const askedTab = Array.isArray(params.tab) ? params.tab[0] : params.tab;

  // The release the image was built as (deploy/Dockerfile bakes it, nothing at runtime changes it);
  // the design preview shows the version its Server page runs.
  const version = process.env.DOCKIFY_IMAGE_VERSION || process.env.DOCKIFY_VERSION || (isPreviewMode() ? "0.9.0" : null);
  const [overview, settings, integrations] = await Promise.all([getOverview(), getSettings(), getIntegrations()]);
  return <SettingsView overview={overview} initial={settings} integrations={integrations} section={isSectionId(asked) ? asked : "profile"} tab={askedTab} version={version} />;
}
