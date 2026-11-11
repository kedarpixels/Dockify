/** Lines per virtualised chunk, and the height of one unwrapped line. */
export const CHUNK = 200;
export const ROW = 20;

/** Both viewers slice their chunks afresh every render, so a chunk compares first, last and length. Lines are never edited in place. */
export const sameLines = <T>(a: readonly T[], b: readonly T[]) => a === b || (a.length === b.length && a[0] === b[0] && a.at(-1) === b.at(-1));
