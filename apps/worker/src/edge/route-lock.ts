/**
 * One app's route file has two writers in this process: the deploy swap and edge_route_sync, which run on
 * different claim loops. Each takes this around its read-modify-write, so neither writes over what the
 * other just wrote. In process is enough: one worker runs every loop of a server.
 */
const tails = new Map<string, Promise<void>>();

export async function withRouteLock<T>(appId: string, fn: () => Promise<T>): Promise<T> {
  const before = tails.get(appId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = before.then(() => mine);
  tails.set(appId, tail);
  await before;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(appId) === tail) tails.delete(appId);
  }
}
