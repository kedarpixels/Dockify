import { guardWrite, json, readJsonObject, refuse } from "@/lib/http";
import { snoozeSecurityAlert } from "@/lib/pages/security-release";
import { SNOOZE_DAYS, type SnoozeDays } from "@/lib/security-release";

const VERSION_RE = /^v?\d+\.\d+\.\d+(?:-[\w.]+)?$/;

/** POST { version, days: 1 | 3 | 7 }. The API caps it by the release's level. */
export async function POST(req: Request) {
  const refused = guardWrite(req);
  if (refused) return refused;
  const { version, days } = await readJsonObject(req);
  if (typeof version !== "string" || !VERSION_RE.test(version)) return refuse(400, "Expected { version } such as 0.9.2");
  if (!SNOOZE_DAYS.includes(days as SnoozeDays)) return refuse(400, "Expected { days } of 1, 3 or 7");
  const r = await snoozeSecurityAlert(version, days as SnoozeDays);
  return json(r.body, r.status);
}
