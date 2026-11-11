/* A plain module (no "use client"), so a server loading.tsx reads the values themselves. */

import type { SkelCol } from "@/components/ui/skeleton";

/** The deploy row's own columns, which the list holds at every width (overview-data.css, .dep-list). */
export const DEPLOY_ROW_TEMPLATE = "var(--dep-cols)";

/** One bar per column: the status tile, app, message, branch, hash, duration, time, the Redeploy key. */
export const DEPLOY_ROW_BARS: SkelCol[] = [24, "62%", "78%", "64%", 56, 40, 48, 24];
