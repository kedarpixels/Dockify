/** The worker's own log line format (main.ts), for when no logger was handed in. */
export const stderrLog = (msg: string, extra?: object): void => {
  process.stderr.write(`${JSON.stringify({ level: "warn", msg, ...extra })}\n`);
};

/**
 * A failure the job cannot recover from by retrying (health check, release command, bad input).
 * Lives in its own module so job modules can throw it without importing main.ts.
 */
export class PermanentJobError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

/**
 * Not a failure: the job cannot run yet and should be tried again later, without spending an
 * attempt (an alert while the api that opens its secrets is down).
 */
export class DeferJobError extends Error {
  readonly delayMs: number;
  constructor(message: string, delayMs: number) {
    super(message);
    this.name = "DeferJobError";
    this.delayMs = delayMs;
  }
}

/**
 * The one test for "do not retry": this class, or any error carrying `permanent === true`
 * (DataError, PermanentDeployError), so no module needs to import another's class.
 */
export const isPermanentError = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { permanent?: unknown }).permanent === true;
