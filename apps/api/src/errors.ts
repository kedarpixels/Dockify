import type { FastifyReply } from "fastify";
import type { z } from "zod";

/** The body always has the shared shape { error, code?, field?, ... }. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(status: number, message: string, code: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const unauthenticated = (message = "Sign in to continue") => new HttpError(401, message, "UNAUTHENTICATED");
export const forbidden = (message = "You do not have access to this") => new HttpError(403, message, "FORBIDDEN");
/** The web looks for this exact error string to open its step-up dialog. */
export const stepUpRequired = () => new HttpError(403, "step_up_required", "STEP_UP_REQUIRED");
/** A 400 the UI shows beside one field. */
export const badField = (message: string, field: string) => new HttpError(400, message, "INVALID_REQUEST", { field });
export const notImplemented = () => new HttpError(501, "Not implemented yet", "NOT_IMPLEMENTED");

/** Fastify's validationContext, as the error names that part. */
const PART: Record<string, string> = { body: "body", querystring: "query", params: "params", headers: "headers" };

/**
 * The first issue drives the one-line error the UI shows. An issue about a whole part (an unknown
 * query key, say) is labelled with that part, so a bad query reads "query", never "body".
 */
export function zodFields(error: z.ZodError, part = "body"): { message: string; field?: string; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".") || (PART[part] ?? "body");
    fields[path] ??= issue.message;
  }
  const first = error.issues[0];
  const field = first && first.path.length ? String(first.path[0]) : undefined;
  return { message: first?.message ?? "Invalid request", field, fields };
}

export function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

/** A 429 with Retry-After set on the reply and in the body. */
export function rateLimited(reply: FastifyReply, retryAfter: number): HttpError {
  reply.header("Retry-After", String(retryAfter));
  return new HttpError(429, "Too many attempts. Try again shortly.", "RATE_LIMITED", { retryAfter });
}
