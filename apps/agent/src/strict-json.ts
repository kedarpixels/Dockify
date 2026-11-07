/**
 * What every JSON document the agent passes on goes through first. The rule behind it: the next parser
 * must read the bytes this module wrote, never the caller's. JSON.parse keeps the last of two equal keys
 * where Go's decoder merges them, and Go matches a struct field's name whatever its case, so what a check
 * saw in the caller's bytes need not be what Docker or Traefik reads from them.
 */

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/** Deeper than anything Dockify writes, and short of what a recursive reader could overflow on. */
const MAX_DEPTH = 16;

/** Go folds Unicode too: the Kelvin sign is a k and a long s is an s. Going through upper case catches both. */
const fold = (key: string): string => key.toUpperCase().toLowerCase();

/** The first problem in a parsed document: two keys one case-insensitive reader would merge, or too much depth. */
export function foldedKeyProblem(value: unknown, depth = 0): string | null {
  if (typeof value !== "object" || value === null) return null;
  if (depth >= MAX_DEPTH) return "it is nested too deeply";
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = foldedKeyProblem(v, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(value)) {
    const f = fold(k);
    if (seen.has(f)) return `it has the key ${JSON.stringify(k).slice(0, 80)} twice, in different cases`;
    seen.add(f);
    const found = foldedKeyProblem(v, depth + 1);
    if (found) return found;
  }
  return null;
}
