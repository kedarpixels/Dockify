"use client";

import { useState } from "react";
import { Icon, type IconName } from "@/components/icon";
import { cx } from "./cx";

// A picture that fails to load falls back to `fallback`, then to the default. An SVG picture sits
// on a light disc in both themes.

const DEFAULT_AVATAR = "/avatar-default.svg";
const GLYPH_PX = { 20: 12, 24: 14, 32: 16, 40: 16, 64: 20 } as const;
export type AvatarSize = keyof typeof GLYPH_PX;

const isArt = (url: string) => /\.svg(?:[?#]|$)/i.test(url) || url.startsWith("data:image/svg");

export function Avatar({
  url,
  size = 32,
  name,
  tip,
  glyph = "user",
  fallback,
  className,
}: {
  url?: string | null;
  /** A second picture for when `url` is missing or fails to load, before the glyph. */
  fallback?: string | null;
  size?: AvatarSize;
  /** Read out when the avatar stands alone; leave it out when the name is printed beside it. */
  name?: string;
  /** Shown on hover, for an avatar whose name is not printed beside it. */
  tip?: string;
  /** The glyph without a picture; ActorAvatar passes a key, bot or GitHub mark. */
  glyph?: IconName;
  className?: string;
}) {
  const [broken, setBroken] = useState<readonly string[]>([]);
  const src = [url, fallback].find((u): u is string => !!u && !broken.includes(u)) ?? null;
  return (
    <span
      className={cx("avatar", (src ? isArt(src) : glyph === "user") && "avatar-art", className)}
      style={{ width: size, height: size }}
      role={name ? "img" : undefined}
      aria-label={name}
      aria-hidden={name ? undefined : true}
      data-tip={tip}
    >
      {src ? (
        <img src={src} alt="" width={size} height={size} onError={() => setBroken((b) => [...b, src])} />
      ) : glyph === "user" ? (
        <img src={DEFAULT_AVATAR} alt="" width={size} height={size} />
      ) : (
        <Icon name={glyph} size={GLYPH_PX[size]} />
      )}
    </span>
  );
}
