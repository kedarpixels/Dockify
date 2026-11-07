import { guardWrite, json, readJsonObject, refuse } from "@/lib/http";
import { isAlertId, isMuteHours, muteApp, unmuteApp } from "@/lib/pages/alerts";

/** PUT /api/alerts/mutes/:appId { hours: 1 | 8 | 24 }: mutes the app's alerts, replacing any mute it had. */
export async function PUT(req: Request, { params }: { params: Promise<{ appId: string }> }) {
  const refused = guardWrite(req);
  if (refused) return refused;
  const { appId } = await params;
  if (!isAlertId(appId)) return refuse(404, "Unknown app");
  const { hours } = await readJsonObject(req);
  if (!isMuteHours(hours)) return refuse(400, "Mute for 1, 8 or 24 hours");
  const { status, body } = await muteApp(appId, hours);
  return json(body, status);
}

/** DELETE /api/alerts/mutes/:appId: ends the mute now. */
export async function DELETE(req: Request, { params }: { params: Promise<{ appId: string }> }) {
  const refused = guardWrite(req, { json: false });
  if (refused) return refused;
  const { appId } = await params;
  if (!isAlertId(appId)) return refuse(404, "Unknown app");
  const { status, body } = await unmuteApp(appId);
  return json(body, status);
}
