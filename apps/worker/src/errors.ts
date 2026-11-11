export const stderrLog = (msg: string, extra?: object): void => {
  process.stderr.write(`${JSON.stringify({ level: "warn", msg, ...extra })}\n`);
};

/** A failure retrying cannot fix: a health check, a release command, bad input. */
export class PermanentJobError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

/** Not a failure: the job cannot run yet and is tried again later without spending an attempt. */
export class DeferJobError extends Error {
  readonly delayMs: number;
  constructor(message: string, delayMs: number) {
    super(message);
    this.name = "DeferJobError";
    this.delayMs = delayMs;
  }
}

/** The one test for "do not retry": any error carrying `permanent === true`, so no module imports another's class. */
export const isPermanentError = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { permanent?: unknown }).permanent === true;
