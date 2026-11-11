/* The repeatable randomness behind every preview fixture, so a sample looks the same on each load. */

export function seeded(seed: number) {
  let s = seed;
  return () => (s = (s * 9301 + 49297) % 233280) / 233280;
}

/** `n` random hex digits, for sample commits and ids. */
export const hex = (rnd: () => number, n: number) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join("");
