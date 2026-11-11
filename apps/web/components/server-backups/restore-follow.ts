import type { RestoreAccepted, RestoreOutcome, RestoreProgress } from "@/lib/pages/server-backups";

const POLL_MS = 5_000;

type Read = { ok: true; data: RestoreProgress | null } | { ok: false; status: number; error: string };

// A restore that outlasts the request keeps its toast pending until the job says how it ended. A
// failed read says nothing about the restore and is asked again; only a 4xx ends the wait.
export async function followRestore(first: RestoreOutcome | RestoreAccepted, read: (jobId: string) => Promise<Read>, sleep: (ms: number) => Promise<unknown> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<RestoreOutcome> {
  if (!("jobId" in first)) return first;
  for (;;) {
    await sleep(POLL_MS);
    const r = await read(first.jobId);
    if (!r.ok) {
      if (r.status >= 400 && r.status < 500 && r.status !== 429) throw new Error(r.error);
      continue;
    }
    if (!r.data) continue;
    if ("ok" in r.data) return r.data;
    if (r.data.status === "failed") throw new Error(r.data.error ?? "The restore failed");
  }
}
