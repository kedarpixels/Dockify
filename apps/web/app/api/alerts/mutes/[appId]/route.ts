import { guardWrite, json, readJsonObject, refuse } from "@/lib/http";
import { isAlertId, isMuteHours, muteApp, unmuteApp } from "@/lib/pages/alerts";

/** PUT { hours: 1 | 8 | 24 }: replaces any mute the app had. */
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

export async function DELETE(req: Request, { params }: { params: Promise<{ appId: string }> }) {
  const refused = guardWrite(req, { json: false });
  if (refused) return refused;
  const { appId } = await params;
  if (!isAlertId(appId)) return refuse(404, "Unknown app");
  const { status, body } = await unmuteApp(appId);
  return json(body, status);
}
