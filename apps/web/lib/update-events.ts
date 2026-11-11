import type { UpdateJob } from "./pages/server-backups";

// Hands an update started outside the Server page to its Updates card, and the card's news back to the
// banner. In memory: a client navigation keeps it; after a reload the page reads the job from the API.

type Listener = (job: UpdateJob) => void;

/** A handed over job no card picked up is dropped after this long. */
const FRESH_MS = 120_000;

let started: UpdateJob | null = null;
let dropTimer: ReturnType<typeof setTimeout> | undefined;
const storeListeners = new Set<() => void>();
const jobListeners = new Set<Listener>();

const live = (j: UpdateJob) => j.state === "waiting" || j.state === "running";

function setStarted(next: UpdateJob | null) {
  if (next === started) return;
  started = next;
  clearTimeout(dropTimer);
  if (next) dropTimer = setTimeout(() => setStarted(null), FRESH_MS);
  for (const fn of storeListeners) fn();
}

/** The popup or the banner started `job`. */
export function updateStarted(job: UpdateJob): void {
  setStarted(live(job) ? job : null);
  for (const fn of jobListeners) fn(job);
}

/** The Updates card's next step or end of a job. A finished job is no longer handed over. */
export function updateChanged(job: UpdateJob): void {
  if (started?.id === job.id && !live(job)) setStarted(null);
  for (const fn of jobListeners) fn(job);
}

/** The job handed over and not finished yet, for useSyncExternalStore. */
export const startedUpdate = (): UpdateJob | null => started;

export function subscribeStarted(fn: () => void): () => void {
  storeListeners.add(fn);
  return () => {
    storeListeners.delete(fn);
  };
}

/** Hears every job the popup started and every step the Updates card saw. */
export function onUpdateJob(fn: Listener): () => void {
  jobListeners.add(fn);
  return () => {
    jobListeners.delete(fn);
  };
}
