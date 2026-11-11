import { guardWrite, json, readJsonObject, refuse } from "@/lib/http";
import { createRule, parseRule, type RuleInput } from "@/lib/pages/alerts";

/** The rule is checked in full before it is forwarded. */
export async function POST(req: Request) {
  const refused = guardWrite(req);
  if (refused) return refused;
  const parsed = parseRule(await readJsonObject(req), false);
  if (!parsed.ok) return refuse(400, parsed.error);
  const { status, body } = await createRule(parsed.input as RuleInput);
  return json(body, status);
}
