import { guardWrite, json, readJsonObject, refuse } from "@/lib/http";
import { patchSchedule, type TierPatch } from "@/lib/pages/server-backups";

const CRON = /^[\d*/,\- ]{9,100}$/;
const count = (v: unknown, max: number) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max;

/**
 * PATCH { tier, enabled?, cron?, keep?, keepDays?, destination? }: one backup tier of a database.
 * Elevated on the API, which checks the cron and the destination again.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = guardWrite(req);
  if (refused) return refused;
  const body = await readJsonObject(req);
  if (body.tier !== "local" && body.tier !== "offsite") return refuse(400, "Expected a tier, local or offsite");
  const patch: TierPatch = { tier: body.tier };
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return refuse(400, "enabled must be true or false");
    patch.enabled = body.enabled;
  }
  if (body.cron !== undefined) {
    if (typeof body.cron !== "string" || !CRON.test(body.cron.trim()) || body.cron.trim().split(/\s+/).length !== 5) return refuse(400, "Use a five field cron, like 0 3 * * *");
    patch.cron = body.cron.trim();
  }
  if (body.keep !== undefined) {
    if (!count(body.keep, 1000)) return refuse(400, "Keep 1 to 1000 backups");
    patch.keep = body.keep as number;
  }
  if (body.keepDays !== undefined) {
    if (body.keepDays !== null && !count(body.keepDays, 3650)) return refuse(400, "Keep 1 to 3650 days, or none");
    patch.keepDays = body.keepDays as number | null;
  }
  if (body.destination !== undefined) {
    if (body.tier !== "offsite" || typeof body.destination !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(body.destination)) return refuse(400, "Only the offsite tier picks a destination");
    patch.destination = body.destination;
  }
  const r = await patchSchedule((await params).id, patch);
  return json(r.body, r.status);
}
