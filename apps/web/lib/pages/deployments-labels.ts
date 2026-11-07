import type { StepId } from "./deployments";

/* Client-safe step names. Kept apart from the loader, which imports server-only APIs. */
export const STEP_LABEL: Record<StepId, string> = {
  queued: "Queued",
  clone: "Clone",
  build: "Build",
  push: "Push",
  release: "Release",
  deploy: "Deploy",
  health: "Health check",
};
