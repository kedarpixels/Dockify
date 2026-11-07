/** A failure retrying cannot fix: bad input, a failed build, health or release command. */
export class PermanentDeployError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "PermanentDeployError";
  }
}

/** The operator cancelled; the pipeline unwinds and writes `cancelled`. */
export class DeployCancelled extends Error {
  constructor() {
    super("Cancelled by the operator");
    this.name = "DeployCancelled";
  }
}

export const isPermanent = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { permanent?: unknown }).permanent === true;

export const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 2_000);
