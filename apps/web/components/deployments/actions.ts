import { callJson } from "@/lib/client-api";
import type { ActionResult, DeploymentAction } from "@/lib/pages/deployments";

/*
 * What a deployment's keys say and send, shared by the rows on every list and the deployment page,
 * so a redeploy reads the same wherever it starts: one trigger name, one confirm, one toast set.
 */

/** What started a deployment. */
const TRIGGER_LABEL: Record<string, string> = { push: "Push", manual: "Manual", redeploy: "Redeploy", rollback: "Rollback", webhook: "Webhook" };

/** "Push", "Manual", "Redeploy", "Rollback", "Webhook"; anything newer reads capitalised. */
export const triggerLabel = (trigger: string) => TRIGGER_LABEL[trigger] ?? trigger.charAt(0).toUpperCase() + trigger.slice(1);

/** Toast copy per action: sentence case titles, no full stops. */
export const ACTION_TOAST: Record<DeploymentAction, { loading: string; success: string; error: string }> = {
  redeploy: { loading: "Starting redeploy", success: "Redeploy started", error: "Could not redeploy" },
  rollback: { loading: "Rolling back", success: "Rollback started", error: "Could not roll back" },
  cancel: { loading: "Cancelling deployment", success: "Deployment cancelled", error: "Could not cancel the deployment" },
};

/** "horseai / web, main 9c0d4e2": what a toast names. The branch and the hash only when there are any. */
export function deployWhere(d: { projectSlug: string; app: { name: string }; branch?: string | null; commit?: string | null }): string {
  const short = d.commit?.slice(0, 7);
  const ref = [d.branch, short].filter(Boolean).join(" ");
  return `${d.projectSlug} / ${d.app.name}${ref ? `, ${ref}` : ""}`;
}

/**
 * The confirm for an action on one deployment: a statement for the title, what will happen, the
 * key as a verb, and a dismiss key that never reads like the action ("Keep running" for a cancel).
 */
export function actionQuestion(
  action: DeploymentAction,
  { label, short, ago, queued = false, vercel = false }: { label: string; short?: string | null; ago?: string; queued?: boolean; vercel?: boolean },
): { title: string; body: string; confirm: string; keep: string } {
  const what = short ?? "this build";
  if (action === "redeploy") {
    return { title: `Redeploy ${what}`, body: `${label} deploys ${what} again with the variables its environment has now.`, confirm: "Redeploy", keep: "Cancel" };
  }
  if (action === "rollback") {
    // What the worker restores (deploy/pipeline.ts, rollbackEnv): the image, and the plain values the
    // target shipped with. Secrets, deleted variables and the app's settings stay as they are now.
    return {
      title: `Roll back to ${what}`,
      body: `${label} runs the image of ${what}${ago ? ` from ${ago}` : ""} again; nothing is rebuilt. Plain variables go back to the values it shipped with. Secrets, deleted variables and the app’s settings stay as they are now.`,
      confirm: "Roll back",
      keep: "Cancel",
    };
  }
  return {
    title: queued ? "Cancel this queued deployment" : "Cancel this build",
    body: vercel ? "Vercel stops this build. The version Vercel is serving now keeps running." : `${label} stops where it is. The version serving traffic now keeps running.`,
    confirm: "Cancel deployment",
    keep: "Keep running",
  };
}

/**
 * Sends an action through this dashboard's route (POST /api/deployments/:id/:action). Resolves with
 * the answer; throws the API's reason on a failure, so `toast.promise` can say it.
 */
export async function sendDeploymentAction(id: string, action: DeploymentAction): Promise<ActionResult> {
  const r = await callJson<ActionResult>(`/api/deployments/${encodeURIComponent(id)}/${action}`, { method: "POST" });
  if (!r.ok) throw new Error(r.error);
  if (!r.data?.ok) throw new Error(r.data?.error ?? "The API did not answer");
  return r.data;
}
