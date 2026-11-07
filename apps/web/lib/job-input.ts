import type { JobInput } from "@/components/app-detail/jobs-shared";

/**
 * A job body from the browser, keeping only known fields of the right type, so nothing else is ever
 * forwarded. The api validates the values. `partial`: a patch, where each field is optional.
 */
export function readJobInput(v: unknown, partial: boolean): Partial<JobInput> | string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "That request is not valid";
  const b = v as Record<string, unknown>;
  const out: Partial<JobInput> = {};
  for (const k of ["name", "schedule", "timezone", "command"] as const) {
    const value = b[k];
    if (value === undefined) {
      if (!partial) return `The ${k} is missing`;
      continue;
    }
    if (typeof value !== "string" || value.length > 1000) return `The ${k} is not valid`;
    out[k] = value;
  }
  if (b.timeoutSeconds !== undefined) {
    if (typeof b.timeoutSeconds !== "number") return "The timeout is not valid";
    out.timeoutSeconds = b.timeoutSeconds;
  } else if (!partial) return "The timeout is missing";
  if (b.overlap !== undefined) {
    if (b.overlap !== "skip" && b.overlap !== "replace") return "The overlap policy is not valid";
    out.overlap = b.overlap;
  } else if (!partial) return "The overlap policy is missing";
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") return "The on or off value is not valid";
    out.enabled = b.enabled;
  } else if (!partial) return "The on or off value is missing";
  return out;
}
