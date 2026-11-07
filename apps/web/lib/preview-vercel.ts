import "server-only";
import type { DeploymentStep } from "./pages/deployments";
import type { RecentDeployment } from "./types";

/*
 * The design preview's one app on Vercel (DOCKIFY_PREVIEW only, never a real record): inkwell / web,
 * linked to the Vercel project the Settings fixture lists. Every other row stays a build on this server.
 */

export const PREVIEW_VERCEL_PROJECT = "prj_ink_web";

export const isPreviewVercelApp = (project: string, app: string) => project === "inkwell" && app === "web";

const short = (id: string) => id.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(-9).padStart(9, "x");

/** Rows of that app as the API sends them for a mirrored deployment. Every fifth is a preview. */
export function previewVercelRows<T extends RecentDeployment>(rows: T[]): T[] {
  let n = 0;
  return rows.map((d) => {
    if (!isPreviewVercelApp(d.projectSlug, d.app.name)) return d;
    n += 1;
    const preview = n % 5 === 0;
    const slug = short(d.id);
    return {
      ...d,
      branch: preview ? `feature/${slug.slice(0, 5)}` : d.branch,
      external: {
        provider: "vercel" as const,
        id: `dpl_${slug}`,
        url: d.status === "queued" ? null : `https://inkwell-web-${slug}.vercel.app`,
        inspectorUrl: `https://vercel.com/acme-labs/inkwell-web/${slug}`,
        target: preview ? ("preview" as const) : ("production" as const),
        source: "git",
        creator: "acme-labs",
      },
    };
  });
}

export function previewVercelSteps(d: RecentDeployment, now: Date): DeploymentStep[] {
  const created = d.createdAt;
  const started = new Date(Date.parse(created) + 4_000).toISOString();
  const nowIso = now.toISOString();
  const end = d.finishedAt ?? nowIso;
  if (d.status === "queued") {
    return [
      { id: "queued", status: "running", startedAt: created, finishedAt: null },
      { id: "build", status: "pending", startedAt: null, finishedAt: null },
      { id: "deploy", status: "pending", startedAt: null, finishedAt: null },
    ];
  }
  const stopped = d.status === "failed" || d.status === "cancelled";
  const running = d.status === "building" || d.status === "deploying";
  return [
    { id: "queued", status: "done", startedAt: created, finishedAt: started },
    { id: "build", status: stopped ? (d.status === "failed" ? "failed" : "cancelled") : running ? "running" : "done", startedAt: started, finishedAt: running ? null : end },
    { id: "deploy", status: stopped ? "skipped" : running ? "pending" : "done", startedAt: running || stopped ? null : end, finishedAt: running || stopped ? null : end },
  ];
}

export function previewVercelLog(d: RecentDeployment): Array<["stdout" | "stderr", string]> {
  const failed = d.status === "failed";
  return [
    ["stdout", `Cloning github.com/acme-labs/inkwell (Branch: ${d.branch ?? "main"}, Commit: ${d.commit ?? ""})`],
    ["stdout", "Cloning completed: 1.204s"],
    ["stdout", "Running \"vercel build\""],
    ["stdout", "Detected Next.js version: 16.3.2"],
    ["stdout", "Running \"pnpm install\""],
    ["stdout", "Lockfile is up to date, resolution step is skipped"],
    ["stdout", "Done in 6.2s using pnpm v10.11.0"],
    ["stdout", "Running \"pnpm build\""],
    ["stdout", "   Creating an optimized production build ..."],
    ...(failed
      ? ([
          ["stderr", "Failed to compile."],
          ["stderr", "Type error: Property 'month' does not exist on type 'Promise<any>'."],
          ["stderr", "Error: Command \"pnpm build\" exited with 1"],
        ] as Array<["stderr", string]>)
      : ([
          ["stdout", " ✓ Compiled successfully in 38.4s"],
          ["stdout", " ✓ Generating static pages (24/24)"],
          ["stdout", "Traced Next.js server files in: 412ms"],
          ["stdout", "Deploying outputs..."],
          ["stdout", "Deployment completed"],
        ] as Array<["stdout", string]>)),
  ];
}
