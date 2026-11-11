import { readJobInput } from "@/lib/job-input";
import { guardWrite, json, readJsonBody, refuse, type RouteAnswer } from "@/lib/http";
import { createJob, deleteJob, getRun, listJobs, listRuns, runJob, updateJob } from "@/lib/pages/jobs";

/* Every id is checked, so a request can never steer the upstream path. Same origin throughout: a run's output is tenant data. */
/** Letters, digits, _ and - only: an id can never add a path segment. The api checks each is a UUID. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
type Ctx = { params: Promise<{ id: string; path?: string[] }> };

const answer = <T,>(r: RouteAnswer<T>) => json(r.body, r.status);

async function ids({ params }: Ctx) {
  const { id, path = [] } = await params;
  const [job, tail, run, extra] = path;
  if (!ID.test(id) || (job && !ID.test(job)) || (run && !ID.test(run)) || extra) return null;
  return { id, job, tail, run };
}

export async function GET(request: Request, ctx: Ctx) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return refuse(403, "Cross-site request refused");
  const p = await ids(ctx);
  if (!p) return refuse(404, "Not found");
  if (!p.job) return answer(await listJobs(p.id));
  if (p.tail === "runs" && !p.run) return answer(await listRuns(p.id, p.job));
  if (p.tail === "runs" && p.run) return answer(await getRun(p.id, p.job, p.run));
  return refuse(404, "Not found");
}

export async function POST(request: Request, ctx: Ctx) {
  const refused = guardWrite(request);
  if (refused) return refused;
  const p = await ids(ctx);
  if (!p || p.run) return refuse(404, "Not found");
  if (p.job && p.tail === "run") return answer(await runJob(p.id, p.job));
  if (p.job || p.tail) return refuse(404, "Not found");
  const body = await readJsonBody(request);
  if (!body.ok) return refuse(body.status, body.error);
  const input = readJobInput(body.value, false);
  if (typeof input === "string") return refuse(400, input);
  return answer(await createJob(p.id, input as Parameters<typeof createJob>[1]));
}

export async function PATCH(request: Request, ctx: Ctx) {
  const refused = guardWrite(request);
  if (refused) return refused;
  const p = await ids(ctx);
  if (!p?.job || p.tail) return refuse(404, "Not found");
  const body = await readJsonBody(request);
  if (!body.ok) return refuse(body.status, body.error);
  const input = readJobInput(body.value, true);
  if (typeof input === "string") return refuse(400, input);
  return answer(await updateJob(p.id, p.job, input));
}

export async function DELETE(request: Request, ctx: Ctx) {
  const refused = guardWrite(request, { json: false });
  if (refused) return refused;
  const p = await ids(ctx);
  if (!p?.job || p.tail) return refuse(404, "Not found");
  return answer(await deleteJob(p.id, p.job));
}
