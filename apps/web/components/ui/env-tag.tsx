import { Icon } from "@/components/icon";
import { cx } from "./cx";
import { useShowsEnv } from "./env-scope";

const NAMES: Record<string, [full: string, short: string]> = {
  production: ["Production", "Prod"],
  development: ["Development", "Dev"],
  preview: ["Preview", "Preview"],
  staging: ["Staging", "Staging"],
};

/**
 * An environment's display name: "Production", "Development", or "Prod" and "Dev" with `compact`.
 * Any other name reads capitalised. Use it wherever copy names an environment ("Created in fieldnote /
 * Production"), so sentences never print the raw lowercase id.
 */
export function envName(env: string, compact = false): string {
  const pair = NAMES[env];
  if (pair) return compact ? pair[1] : pair[0];
  return env.charAt(0).toUpperCase() + env.slice(1);
}

/**
 * Quiet environment tag: the 14px branch glyph plus the name, no pill, since every environment
 * deploys from a branch. Production reads in ink, every other environment muted. `compact` shows
 * Prod / Dev.
 *
 * `quiet` is for rows in a list: production is the default there, so its tag says nothing and
 * renders nothing; any other environment still shows. Detail leads and card heads leave it off and
 * name production too.
 *
 * `project` is for rows that list several projects: a project whose apps all sit in one
 * environment names none (env-scope.tsx), whatever that environment is called.
 *
 *   <EnvTag env={app.env} project={app.projectSlug} quiet compact />   in a row
 *   <EnvTag env={app.env} />                                           in a detail lead
 */
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

/**
 * For a row that names its project: whether its environment follows, after a comma ("horseai, Dev").
 * The same rule as a quiet EnvTag with `project`, so the comma and the tag always agree.
 */
export function useRowEnv(): (project: string, env: string) => boolean {
  const shows = useShowsEnv();
  return (project, env) => env !== "production" && shows(project);
}
