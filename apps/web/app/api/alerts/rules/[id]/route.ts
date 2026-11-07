import { guardWrite, json, readJsonObject, refuse } from "@/lib/http";
import { deleteRule, isAlertId, parseRule, patchRule } from "@/lib/pages/alerts";

/**
 * PATCH /api/alerts/rules/:id. The switch sends `{ enabled }` alone; the editor sends the whole
 * rule, which is checked in full so a half-valid edit never reaches the API.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = guardWrite(req);
  if (refused) return refused;
  const { id } = await params;
  if (!isAlertId(id)) return refuse(404, "Unknown rule");
  const body = await readJsonObject(req);
  const onlySwitch = Object.keys(body).length === 1 && "enabled" in body;
  const parsed = parseRule(body, onlySwitch);
  if (!parsed.ok) return refuse(400, parsed.error);
  const { status, body: out } = await patchRule(id, parsed.input);
  return json(out, status);
}

/** DELETE /api/alerts/rules/:id. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = guardWrite(req, { json: false });
  if (refused) return refused;
  const { id } = await params;
  if (!isAlertId(id)) return refuse(404, "Unknown rule");
  const { status, body } = await deleteRule(id);
  return json(body, status);
}
