// The minimum mirrors NewPassword in packages/contracts/src/common.ts, which the API enforces.

export const MIN_PASSWORD = 12;

/** The API's upper bound (contracts NewPassword). */
const MAX_PASSWORD = 256;

export const SHORT_PASSWORD = `Use at least ${MIN_PASSWORD} characters`;

export const PASSWORD_MISMATCH = "Passwords do not match";

const COMMON = /^(password|dockify|qwerty|letmein|welcome|admin|123456|abc123|iloveyou)/i;

/** 0 empty, 1 too short or weak, up to 4 strong. A guide, not a gate: the API sets the rules. */
export function scorePassword(pw: string): { score: 0 | 1 | 2 | 3 | 4; label: string; tone: "bad" | "warn" | "ok" } {
  if (!pw) return { score: 0, label: "", tone: "bad" };
  if (pw.length < MIN_PASSWORD) return { score: 1, label: "Too short", tone: "bad" };
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (COMMON.test(pw) || /^(.)\1+$/.test(pw) || kinds === 1) return { score: 1, label: "Weak", tone: "bad" };
  let s = 1;
  if (pw.length >= 16) s++;
  if (pw.length >= 20) s++;
  if (kinds >= 3) s++;
  const score = Math.min(4, s) as 1 | 2 | 3 | 4;
  return { score, label: ["", "Weak", "Fair", "Good", "Strong"][score]!, tone: score === 1 ? "bad" : score === 2 ? "warn" : "ok" };
}

/** The first problem with a new password, or null when the API will take it. */
export function newPasswordProblem(pw: string): string | null {
  if (pw.length < MIN_PASSWORD) return SHORT_PASSWORD;
  if (pw.length > MAX_PASSWORD) return `Use at most ${MAX_PASSWORD} characters`;
  return null;
}
