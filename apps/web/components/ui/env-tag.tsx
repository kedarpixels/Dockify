import { Icon } from "@/components/icon";
import { cx } from "./cx";

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
 *   <EnvTag env={app.env} quiet compact />   in a row
 *   <EnvTag env={app.env} />                 in a detail lead
 */
export function EnvTag({
  env,
  compact,
  quiet,
  className,
}: {
  env: "production" | "development" | (string & {});
  compact?: boolean;
  quiet?: boolean;
  className?: string;
}) {
  const prod = env === "production";
  if (quiet && prod) return null;
  return (
    <span className={cx("env-tag", className)} data-prod={prod || undefined}>
      <Icon name="branch" size={14} />
      {envName(env, compact)}
    </span>
  );
}
