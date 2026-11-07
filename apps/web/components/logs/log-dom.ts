/* Shared by the runtime log explorer and the build log viewer. */

/** Lines per virtualised chunk, and the height of one unwrapped line. */
export const CHUNK = 200;
export const ROW = 20;

/**
 * Two slices of one log hold the same lines when they have the same length and the same first and
 * last line. Both viewers slice their mounted chunks afresh every render (no cache read during
 * render), so a chunk compares what it holds instead of the array. Lines are never edited in
 * place: a log only grows at its ends, or is replaced whole.
 */
export const sameLines = <T>(a: readonly T[], b: readonly T[]) => a === b || (a.length === b.length && a[0] === b[0] && a.at(-1) === b.at(-1));
