import "server-only";
import type { DeploymentStep } from "./pages/deployments";
import type { VercelEnvList, VercelProjectView } from "./pages/project-detail";
import type { RecentDeployment } from "./types";

// Design preview only: inkwell / web is the one app on Vercel; every other row is a build on this server.

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

/** Production is the newest ready production row of the app's own list, so the Overview and the Deployments tab agree. */
const COMMIT = "4f9c2a1e7b3d5f8a0c6e2b4d9f1a3c5e7b9d0f2a";

export function previewVercelProject(rows: RecentDeployment[]): VercelProjectView {
  const base = "https://vercel.com/acme-labs/inkwell-web";
  const prod = rows.find((d) => d.status === "ready" && d.external?.target === "production");
  const at = prod ? Date.parse(prod.createdAt) : Date.now() - 3 * 3_600_000;
  const id = prod?.external?.id ?? "dpl_4kq2m8vtx";
  return {
    id: PREVIEW_VERCEL_PROJECT,
    name: "inkwell-web",
    framework: "nextjs",
    nodeVersion: "22.x",
    rootDirectory: "apps/web",
    buildCommand: "pnpm build",
    installCommand: null,
    outputDirectory: null,
    repo: { provider: "github", slug: "acme-labs/inkwell", url: "https://github.com/acme-labs/inkwell", productionBranch: "main" },
    links: { project: base, deployments: `${base}/deployments`, domains: `${base}/settings/domains`, env: `${base}/settings/environment-variables`, settings: `${base}/settings` },
    production: {
      id,
      url: prod?.external?.url ?? null,
      inspectorUrl: prod?.external?.inspectorUrl ?? `${base}/${id.replace(/^dpl_/, "")}`,
      status: "ready",
      target: "production",
      branch: prod?.branch ?? "main",
      // With no ready production row in the fixture's window, a fictional one stands in for it.
      commit: prod ? prod.commit : COMMIT,
      message: prod ? prod.message : "Cache the raffle results page for a minute",
      commitUrl: prod && !prod.commit ? null : `https://github.com/acme-labs/inkwell/commit/${prod?.commit ?? COMMIT}`,
      author: prod?.author?.login ?? "rowanpike",
      createdAt: new Date(at).toISOString(),
      readyAt: new Date(at + 96_000).toISOString(),
      durationMs: 94_800,
      aliases: ["inkwell.example", "www.inkwell.example", "inkwell-web.vercel.app", "inkwell-web-git-main-acme-labs.vercel.app"],
      deploymentId: prod?.id ?? null,
    },
    domains: [
      { name: "inkwell.example", verified: true, redirect: null, redirectStatusCode: null, gitBranch: null, createdAt: "2026-09-14T10:12:00.000Z" },
      { name: "www.inkwell.example", verified: true, redirect: "inkwell.example", redirectStatusCode: 308, gitBranch: null, createdAt: "2026-09-14T10:12:00.000Z" },
      { name: "beta.inkwell.example", verified: false, redirect: null, redirectStatusCode: null, gitBranch: "beta", createdAt: "2026-11-02T16:40:00.000Z" },
      { name: "inkwell-web.vercel.app", verified: true, redirect: null, redirectStatusCode: null, gitBranch: null, createdAt: "2026-09-14T09:58:00.000Z" },
    ],
    domainsError: null,
    fetchedAt: new Date().toISOString(),
  };
}

/** Its environment variables as an admin reads them: plain values shown, the rest never. */
export function previewVercelEnv(): VercelEnvList {
  const day = 86_400_000;
  const ago = (d: number) => new Date(Date.now() - d * day).toISOString();
  return {
    values: true,
    hiddenProductionCount: 0,
    manageUrl: "https://vercel.com/acme-labs/inkwell-web/settings/environment-variables",
    fetchedAt: new Date().toISOString(),
    variables: [
      { id: "env_1", key: "DATABASE_URL", targets: ["production", "preview"], type: "encrypted", gitBranch: null, comment: null, updatedAt: ago(12), value: null },
      { id: "env_2", key: "NEXT_PUBLIC_SITE_URL", targets: ["production"], type: "plain", gitBranch: null, comment: "Canonical address for links and the sitemap", updatedAt: ago(40), value: "https://inkwell.example" },
      { id: "env_3", key: "NEXT_PUBLIC_SITE_URL", targets: ["preview"], type: "plain", gitBranch: "beta", comment: null, updatedAt: ago(3), value: "https://beta.inkwell.example" },
      { id: "env_4", key: "REDIS_URL", targets: ["production", "preview"], type: "encrypted", gitBranch: null, comment: null, updatedAt: ago(12), value: null },
      { id: "env_5", key: "SESSION_SECRET", targets: ["production"], type: "sensitive", gitBranch: null, comment: "Rotated each quarter", updatedAt: ago(21), value: null },
      { id: "env_6", key: "NEXT_PUBLIC_ANALYTICS_ID", targets: ["production", "preview", "development"], type: "plain", gitBranch: null, comment: null, updatedAt: ago(64), value: "ink-web-3f9a" },
    ],
  };
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
