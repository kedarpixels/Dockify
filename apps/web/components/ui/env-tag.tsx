import { Icon } from "@/components/icon";
import { cx } from "./cx";
import { useShowsEnv } from "./env-scope";

const NAMES: Record<string, [full: string, short: string]> = {
  production: ["Production", "Prod"],
  development: ["Development", "Dev"],
  preview: ["Preview", "Preview"],
  staging: ["Staging", "Staging"],
};

/** Use it wherever copy names an environment, so sentences never print the raw lowercase id. */
export function envName(env: string, compact = false): string {
  const pair = NAMES[env];
  if (pair) return compact ? pair[1] : pair[0];
  return env.charAt(0).toUpperCase() + env.slice(1);
}

// `quiet` is for list rows: production is the default there and renders nothing. `project` is for
// rows across projects: a project whose apps all sit in one environment names none (env-scope.tsx).
export function EnvTag({
  env,
  compact,
  quiet,
  project,
  className,
}: {
  env: "production" | "development" | (string & {});
  compact?: boolean;
  quiet?: boolean;
  project?: string;
  className?: string;
}) {
  const shows = useShowsEnv();
  const prod = env === "production";
  if ((quiet && prod) || (project !== undefined && !shows(project))) return null;
  return (
    <span className={cx("env-tag", className)} data-prod={prod || undefined}>
      <Icon name="branch" size={14} />
      {envName(env, compact)}
    </span>
  );
}

/** The same rule as a quiet EnvTag with `project`, so the comma and the tag always agree. */
export function useRowEnv(): (project: string, env: string) => boolean {
  const shows = useShowsEnv();
  return (project, env) => env !== "production" && shows(project);
}
