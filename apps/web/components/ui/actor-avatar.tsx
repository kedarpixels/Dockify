import type { IconName } from "@/components/icon";
import type { ActorKind } from "@/lib/types";
import { Avatar } from "./avatar";
import { cx } from "./cx";

/* One round box whatever the actor, so rows stay aligned. */

/** The whale from public/dockify-glyph.svg (left-facing, in its own 22.7 by 16.44 box). */
const WHALE =
  "M19.13 11.13C22.62 11.13 25.92 13.17 25.92 16.46C25.92 19.67 24.76 21.99 22.62 21.99C19.91 22.09 17.19 22.04 14.86 21.8C10.98 21.41 7.2 18.21 5.84 13.17C4.97 12.29 4.19 11.42 3.71 10.74C3.42 10.26 3.61 9.77 4.19 9.77C5.26 9.77 6.33 10.45 7.1 11.23C7.78 10.45 8.75 9.77 9.82 9.77C10.5 9.77 10.69 10.26 10.4 10.74C10.01 11.32 9.33 12.1 8.36 12.97C8.85 14.23 9.62 15.49 10.98 15.69C13.31 15.88 15.64 11.13 19.13 11.13ZM22.04 18.02a1.07 1.07 0 1 0 2.14 0a1.07 1.07 0 1 0 -2.14 0ZM20.68 8.7a0.97 0.97 0 1 0 1.94 0a0.97 0.97 0 1 0 -1.94 0ZM19.09 6.86a0.82 0.82 0 1 0 1.64 0a0.82 0.82 0 1 0 -1.64 0ZM22.77 6.67a0.82 0.82 0 1 0 1.64 0a0.82 0.82 0 1 0 -1.64 0Z";

function DockifyAvatar({ size, tip, className }: { size: number; tip?: string; className?: string }) {
  const w = Math.round(size * 0.72);
  return (
    <span
      className={cx("avatar avatar-brand", className)}
      style={{ width: size, height: size }}
      role={tip ? "img" : undefined}
      aria-label={tip}
      aria-hidden={tip ? undefined : true}
      data-tip={tip}
    >
      <svg viewBox="3.32 5.75 22.7 16.44" width={w} height={Math.round((w * 16.44) / 22.7)} aria-hidden="true" focusable="false">
        <g transform="matrix(-1 0 0 1 29.34 0)">
          <path fill="currentColor" fillRule="evenodd" d={WHALE} />
        </g>
      </svg>
    </span>
  );
}


export function ActorAvatar({
  kind = "user",
  url,
  name,
  size = 20,
  tip,
  className,
}: {
  kind?: ActorKind;
  url?: string | null;
  /** Picks the GitHub mark for a system actor named GitHub. */
  name?: string | null;
  size?: 20 | 24 | 32;
  /** Hover text and accessible name, for when the name is not printed beside it. */
  tip?: string;
  className?: string;
}) {
  if (kind === "github") {
    return <Avatar url={url} size={size} name={tip} tip={tip} className={className} />;
  }
  if (kind === "user") {
    return <Avatar url={url} size={size} name={tip} tip={tip} className={className} />;
  }
  if (kind === "token") {
    return <Avatar glyph={"key" satisfies IconName} size={size} name={tip} tip={tip} className={className} />;
  }
  if (name?.trim().toLowerCase() === "github") {
    return <Avatar glyph="github" size={size} name={tip} tip={tip} className={className} />;
  }
  return <DockifyAvatar size={size} tip={tip} className={className} />;
}
