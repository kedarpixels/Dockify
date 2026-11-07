import type { Metadata } from "next";
import { ActivityView } from "@/components/activity-settings/activity-view";
import { getOverview } from "@/lib/data";
import { getActivity } from "@/lib/pages/activity-settings";

export const metadata: Metadata = { title: "Activity" };

export default async function ActivityPage() {
  // The overview is read once per request (the layout reads it too), so waiting for it costs nothing.
  const overview = await getOverview();
  // The activity log is an admin's (activity.list is admin only): a Viewer gets the page's
  // admins-only card, and the API is not asked for a list it would refuse.
  const viewer = overview.data?.viewer?.role?.trim().toLowerCase() === "viewer";
  const activity = viewer
    ? { source: overview.source, data: { items: [], nextCursor: null, actors: [] }, fetchedAt: overview.fetchedAt }
    : await getActivity();
  return <ActivityView overview={overview} initial={activity} />;
}
