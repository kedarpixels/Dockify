import type { Images } from "./release.ts";

export type { Images } from "./release.ts";

/*
 * One self-update or rollback as a resumable journal. The journal is saved after every transition
 * and every step is safe to repeat, so a takeover continues from the recorded phase. Before the
 * backup nothing durable has changed; from the backup on, any failure rolls back.
 */

export const STEP_ORDER = ["preflight", "pull", "backup", "migrate", "swap_api", "swap_worker", "swap_web", "health"] as const;
export type StepId = (typeof STEP_ORDER)[number] | "rollback";
export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type JournalState = "waiting" | "running" | "done" | "failed" | "rolled_back";
export type Service = "api" | "worker" | "web";

export interface StepRow {
  id: StepId;
  status: StepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  detail: string | null;
}

export interface Journal {
  id: string;
  kind: "update" | "rollback";
  fromVersion: string;
  version: string;
  manifestSha256: string | null;
  fromImages: Images | null;
  toImages: Images | null;
  phase: StepId;
  state: JournalState;
  dumpBackupId: string | null;
  dumpSha256: string | null;
  dumpBytes: number | null;
  migrationStarted: boolean;
  rollbackOfId: string | null;
  steps: StepRow[];
  attempt: number;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export type Preflight = { ok: true } | { ok: false; wait: boolean; reason: string };

export interface Dump {
  id: string;
  sha256: string;
  bytes: number;
}

/** Every step must be safe to repeat: a takeover reruns the one that was in flight. */
export interface UpdateSteps {
  preflight(): Promise<Preflight>;
  /** Re-fetches and re-verifies the signed feed; returns this host's digests if its hash still matches. */
  resolve(version: string, manifestSha256: string): Promise<Images>;
  currentImages(): Promise<Images>;
  pull(images: Images): Promise<void>;
  /** Stops api and worker so the dump is the last write. Web stays up and shows the outage. */
  quiesce(): Promise<void>;
  dump(updateId: string): Promise<Dump>;
  migrate(images: Images): Promise<void>;
  pin(images: Images): Promise<void>;
  swap(service: Service, since: Date): Promise<void>;
  /** Null when healthy, else the reason. */
  healthy(since: Date): Promise<string | null>;
  /** Verifies the dump's sha256, then drops and rebuilds the schema from it in one transaction. */
  restoreDump(dump: { id: string; sha256: string }): Promise<void>;
}

export interface UpdateRecorder {
  /** Must be an upsert: the row has to survive a dump restore. */
  save(j: Journal): Promise<void>;
  audit(j: Journal, step: StepId, status: "done" | "failed" | "skipped", detail: string | null): Promise<void>;
  /** Together they carry the update history and its audit rows across a dump restore. */
  beforeRestore(): Promise<void>;
  afterRestore(j: Journal): Promise<void>;
  /**
   * Called only after the health check passed. After a rollback `skipVersion` is the version left,
   * so automatic updates do not put it straight back; the restore resets that column, so it is set here.
   */
  finish(version: string, skipVersion?: string): Promise<void>;
  log(line: string): void;
  now(): Date;
}

export interface RunContext {
  /** A rollback job restores this dump where an update would migrate. */
  restoreTarget?: { id: string; sha256: string } | null;
  maxWaitMs?: number;
}

export type Outcome = "done" | "failed" | "rolled_back" | "waiting";
export interface RunResult {
  outcome: Outcome;
  error?: string;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);
const same = (a: Images, b: Images) => a.control === b.control && a.web === b.web;
const SWAP: Record<"swap_api" | "swap_worker" | "swap_web", Service> = { swap_api: "api", swap_worker: "worker", swap_web: "web" };
const DEFAULT_MAX_WAIT = 2 * 3_600_000;

export const plannedSteps = (): StepRow[] => STEP_ORDER.map((id) => ({ id, status: "pending", startedAt: null, finishedAt: null, detail: null }));

export class Run {
  private j: Journal;
  private steps: UpdateSteps;
  private rec: UpdateRecorder;
  private ctx: RunContext;
  constructor(j: Journal, steps: UpdateSteps, rec: UpdateRecorder, ctx: RunContext = {}) {
    this.j = j;
    this.steps = steps;
    this.rec = rec;
    this.ctx = ctx;
  }

  get journal(): Journal {
    return this.j;
  }

  private row(id: StepId): StepRow {
    let r = this.j.steps.find((s) => s.id === id);
    if (!r) {
      r = { id, status: "pending", startedAt: null, finishedAt: null, detail: null };
      this.j.steps.push(r);
    }
    return r;
  }

  private async mark(id: StepId, status: StepStatus, detail: string | null = null): Promise<void> {
    const r = this.row(id);
    const at = this.rec.now().toISOString();
    if (status === "running") {
      // A resumed step keeps its first start time.
      r.startedAt ??= at;
      r.finishedAt = null;
    } else if (status !== "pending") {
      r.startedAt ??= at;
      r.finishedAt = at;
    }
    r.status = status;
    r.detail = detail;
    if (status === "running") this.j.phase = id;
    await this.rec.save(this.j);
    if (status === "done" || status === "failed" || status === "skipped") await this.rec.audit(this.j, id, status, detail);
  }

  private async settle(state: "done" | "failed" | "rolled_back", error: string | null): Promise<RunResult> {
    this.j.state = state;
    this.j.error = error;
    this.j.finishedAt = this.rec.now();
    await this.rec.save(this.j);
    this.rec.log(state === "done" ? `now on ${this.j.version}` : `${state}: ${error}`);
    return error ? { outcome: state, error } : { outcome: state };
  }

  private async skipRest(after: StepId): Promise<void> {
    const i = STEP_ORDER.indexOf(after as (typeof STEP_ORDER)[number]);
    for (const id of STEP_ORDER.slice(i + 1)) {
      const r = this.row(id);
      if (r.status === "pending") r.status = "skipped";
    }
  }

  async run(): Promise<RunResult> {
    const j = this.j;
    if (j.state === "done" || j.state === "failed" || j.state === "rolled_back") return { outcome: j.state, ...(j.error ? { error: j.error } : {}) };
    if (j.phase === "rollback") return this.rollback(j.error ?? "resuming an interrupted rollback");
    if (!j.steps.length) j.steps = plannedSteps();
    j.state = "running";
    this.rec.log(`${j.kind === "rollback" ? "rolling back" : "updating"} ${j.fromVersion} to ${j.version} (attempt ${j.attempt}, from ${j.phase})`);

    for (const id of STEP_ORDER.slice(Math.max(0, STEP_ORDER.indexOf(j.phase as (typeof STEP_ORDER)[number])))) {
      if (this.row(id).status === "done") continue;
      const res = await this.step(id);
      if (res) return res;
    }
    await this.rec.finish(j.version, j.kind === "rollback" ? j.fromVersion : undefined);
    return this.settle("done", null);
  }

  /** Returns a result to stop the run, or null to go on. */
  private async step(id: (typeof STEP_ORDER)[number]): Promise<RunResult | null> {
    const j = this.j;
    await this.mark(id, "running", this.row(id).detail);
    try {
      switch (id) {
        case "preflight": {
          const p = await this.steps.preflight();
          if (p.ok) break;
          const started = Date.parse(this.row("preflight").startedAt ?? "") || this.rec.now().getTime();
          if (p.wait && this.rec.now().getTime() - started < (this.ctx.maxWaitMs ?? DEFAULT_MAX_WAIT)) {
            j.state = "waiting";
            await this.mark("preflight", "running", `waiting: ${p.reason}`);
            return { outcome: "waiting", error: p.reason };
          }
          throw new Error(p.wait ? `still busy after waiting: ${p.reason}` : p.reason);
        }
        case "pull": {
          j.state = "running";
          const to = j.kind === "rollback" ? j.toImages : await this.steps.resolve(j.version, j.manifestSha256 ?? "");
          if (!to) throw new Error("the rollback has no previous images recorded");
          if (j.toImages && !same(j.toImages, to)) throw new Error("the signed manifest no longer matches the release that was approved");
          j.toImages = to;
          // Read from release.env, never from the row, which a database write could have forged.
          // Nothing is pinned before this step, so a retry reads the same value.
          j.fromImages = await this.steps.currentImages();
          await this.rec.save(j);
          await this.steps.pull(to);
          break;
        }
        case "backup": {
          await this.steps.quiesce();
          const d = await this.steps.dump(j.id);
          j.dumpBackupId = d.id;
          j.dumpSha256 = d.sha256;
          j.dumpBytes = d.bytes;
          await this.rec.save(j);
          await this.mark("backup", "done", `dump ${d.id}, sha256 ${d.sha256.slice(0, 12)}`);
          return null;
        }
        case "migrate": {
          j.migrationStarted = true;
          await this.rec.save(j);
          if (j.kind === "rollback") {
            const t = this.ctx.restoreTarget;
            if (!t) throw new Error("the dump of the update being rolled back is gone");
            await this.restore(t);
            await this.mark("migrate", "done", `database restored from dump ${t.id}`);
            return null;
          }
          await this.steps.migrate(j.toImages!);
          break;
        }
        case "swap_api":
        case "swap_worker":
        case "swap_web": {
          await this.steps.pin(j.toImages!);
          await this.steps.swap(SWAP[id], new Date(Date.parse(this.row(id).startedAt ?? "") || this.rec.now().getTime()));
          break;
        }
        case "health": {
          const since = new Date(Date.parse(this.row("swap_api").startedAt ?? "") || this.rec.now().getTime());
          const bad = await this.steps.healthy(since);
          if (bad) throw new Error(bad);
          break;
        }
      }
      await this.mark(id, "done");
      return null;
    } catch (e) {
      const reason = `${id === "health" ? "health check failed" : `${id.replace("_", " ")} failed`}: ${msg(e)}`;
      await this.mark(id, "failed", msg(e));
      const before = STEP_ORDER.indexOf(id) < STEP_ORDER.indexOf("backup");
      if (before) {
        await this.skipRest(id);
        return this.settle("failed", `${reason}. Nothing was changed.`);
      }
      if (id === "backup") {
        // The dump failed: nothing migrated, so the previous version just starts again.
        await this.skipRest(id);
        try {
          await this.bringBack(this.j.fromImages);
        } catch (e2) {
          return this.settle("failed", `${reason}; starting the previous version again also failed: ${msg(e2)}`);
        }
        return this.settle("failed", `${reason}. The previous version is running again.`);
      }
      await this.skipRest(id);
      return this.rollback(reason);
    }
  }

  private async bringBack(images: Images | null): Promise<void> {
    if (!images) throw new Error("the previous images were never recorded");
    await this.steps.pin(images);
    const since = this.rec.now();
    for (const s of ["api", "worker", "web"] as const) await this.steps.swap(s, since);
  }

  private async restore(dump: { id: string; sha256: string }): Promise<void> {
    await this.steps.quiesce();
    await this.rec.beforeRestore();
    await this.steps.restoreDump(dump);
    await this.rec.afterRestore(this.j);
  }

  /** Back to the previous digests, restoring the dump first once the migration has started. */
  private async rollback(reason: string): Promise<RunResult> {
    const j = this.j;
    j.state = "running";
    j.error = reason;
    this.rec.log(`rolling back: ${reason}`);
    await this.mark("rollback", "running", reason);
    try {
      if (j.migrationStarted) {
        if (!j.dumpBackupId || !j.dumpSha256) throw new Error("no pre-update dump was recorded");
        await this.restore({ id: j.dumpBackupId, sha256: j.dumpSha256 });
      } else {
        await this.steps.quiesce();
      }
      await this.bringBack(j.fromImages);
      const bad = await this.steps.healthy(this.rec.now());
      if (bad) throw new Error(`the previous version did not pass its health check: ${bad}`);
    } catch (e) {
      const where = j.dumpBackupId ? ` Restore dump ${j.dumpBackupId} by hand (sha256 ${j.dumpSha256 ?? "unknown"}).` : "";
      await this.mark("rollback", "failed", msg(e));
      return this.settle("failed", `${reason}; ROLLBACK FAILED: ${msg(e)}.${where}`);
    }
    await this.mark("rollback", "done", j.migrationStarted ? "previous images and the pre-update database are back" : "previous images are back");
    return this.settle("rolled_back", reason);
  }
}

export const runUpdate = (j: Journal, steps: UpdateSteps, rec: UpdateRecorder, ctx: RunContext = {}): Promise<RunResult> => new Run(j, steps, rec, ctx).run();
