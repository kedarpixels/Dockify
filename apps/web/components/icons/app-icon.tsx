"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { ProjectTile } from "@/components/project-tile";
import { cx } from "@/components/ui/cx";
import { appRole, type AppRole } from "@/lib/app-role";
import { EMPTY_ICONS, iconUrl, type IconMap, type IconPreset, type IconState, type IconTarget } from "@/lib/icons";
import type { AppKind } from "@/lib/types";
import { PresetTile } from "./preset-tile";

/* Both read the console's icon map (read once by the layout), so a change in the Icon control shows everywhere at once. */

const SIZES = { sm: 20, md: 28, lg: 40 } as const;
export type IconSize = keyof typeof SIZES;

interface IconsValue {
  map: IconMap;
  /** Blob URLs of uploads made in the design preview, which has no server to keep them. */
  local: Record<string, string>;
  set(t: IconTarget, state: IconState, localSrc?: string): void;
}

const IconsContext = createContext<IconsValue>({ map: EMPTY_ICONS, local: {}, set: () => undefined });

const keyOf = (t: IconTarget) => (t.target === "app" ? `a:${t.id}` : `p:${t.slug}`);

export function IconsProvider({ icons, children }: { icons: IconMap; children: React.ReactNode }) {
  const [map, setMap] = useState(icons);
  const [local, setLocal] = useState<Record<string, string>>({});
  // A fresh map from the layout (a navigation or refresh) replaces the local one during render.
  const [served, setServed] = useState(icons);
  if (icons !== served) {
    setServed(icons);
    setMap(icons);
  }

  const set = useCallback((t: IconTarget, state: IconState, localSrc?: string) => {
    setMap((m) => (t.target === "app" ? { ...m, apps: { ...m.apps, [t.id]: state } } : { ...m, projects: { ...m.projects, [t.slug]: state } }));
    setLocal((l) => {
      const k = keyOf(t);
      if (l[k] && l[k] !== localSrc) URL.revokeObjectURL(l[k]);
      const next = { ...l };
      if (localSrc) next[k] = localSrc;
      else delete next[k];
      return next;
    });
  }, []);

  const value = useMemo(() => ({ map, local, set }), [map, local, set]);
  return <IconsContext.Provider value={value}>{children}</IconsContext.Provider>;
}

export const useIcons = () => useContext(IconsContext);

/** What an icon shows: an image URL, else the default icon (null means the project folder). */
function useIconFace(t: IconTarget | null, fallback: IconPreset | null): { src: string | null; preset: IconPreset | null } {
  const { map, local } = useIcons();
  if (!t) return { src: null, preset: fallback };
  const state = t.target === "app" ? map.apps[t.id] : map.projects[t.slug];
  const localSrc = local[keyOf(t)];
  if (state?.choice === "upload" && localSrc) return { src: localSrc, preset: fallback };
  return { src: state?.image ? iconUrl(t, state.image.version) : null, preset: fallback };
}

function Face({ face, size, className }: { face: ReturnType<typeof useIconFace>; size: IconSize; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const px = SIZES[size];
  const src = face.src && failed !== face.src ? face.src : null;
  return (
    <span className={cx("aicon", className)} data-size={size} aria-hidden="true">
      {src ? (
        <img src={src} alt="" width={px} height={px} decoding="async" draggable={false} onError={() => setFailed(src)} />
      ) : face.preset ? (
        <PresetTile preset={face.preset} px={px} />
      ) : (
        <ProjectTile size={size} />
      )}
    </span>
  );
}

export interface RoleApp {
  id?: string;
  kind: AppKind;
  /** Its published image when the caller has it; otherwise the icon map's is read by id. */
  image?: string | null;
}

/** What any app reads as (lib/app-role.ts), for the label next to its icon. */
export function useAppRole(): (app: RoleApp) => AppRole {
  const { stock } = useIcons().map;
  return useCallback((app) => appRole(app.kind, app.image ?? (app.id ? stock[app.id] : undefined)), [stock]);
}

/** An app's icon: its upload, its favicon (frontends, automatic), or the default of what it is. */
export function AppIcon({ id, kind, image, size = "sm", className }: Partial<RoleApp> & { size?: IconSize; className?: string }) {
  const role = useAppRole()({ id, kind: kind ?? "backend", image });
  const face = useIconFace(id ? { target: "app", id } : null, role.preset);
  return <Face face={face} size={size} className={className} />;
}

/** A project's icon: its upload, a frontend's favicon (automatic), else the folder. */
export function ProjectIcon({ slug, size = "sm", className }: { slug?: string; size?: IconSize; className?: string }) {
  const face = useIconFace(slug ? { target: "project", slug } : null, null);
  return <Face face={face} size={size} className={className} />;
}
