import type { IconPreset } from "./icons";
import type { AppKind } from "./types";

/* What an app is to the person reading its name: its kind, or for a published image what that image is. */

export const KIND_LABEL: Record<AppKind, string> = {
  frontend: "Frontend",
  backend: "Backend",
  bot: "Bot",
  postgres: "Postgres",
  redis: "Redis",
  s3: "Storage",
};

const KIND_PRESET: Record<AppKind, IconPreset> = {
  frontend: "web",
  backend: "api",
  bot: "bot",
  postgres: "postgres",
  redis: "redis",
  s3: "minio",
};

export interface AppRole {
  preset: IconPreset;
  label: string;
}

/** A name is the last segment of the image's repository (chrislusf/seaweedfs); one ending in a slash is an owner (gotify/server). */
const FAMILIES: Array<{ names: string[]; role: AppRole }> = [
  { names: ["minio"], role: { preset: "minio", label: "Storage" } },
  { names: ["seaweedfs", "garage", "rustfs"], role: { preset: "storage", label: "Storage" } },
  { names: ["uptime-kuma"], role: { preset: "uptimekuma", label: "Monitoring" } },
  { names: ["grafana", "prometheus", "gatus"], role: { preset: "monitor", label: "Monitoring" } },
  { names: ["ntfy"], role: { preset: "ntfy", label: "Notifications" } },
  { names: ["gotify/"], role: { preset: "notify", label: "Notifications" } },
  { names: ["memos"], role: { preset: "notes", label: "Notes" } },
  { names: ["miniflux", "freshrss"], role: { preset: "reader", label: "Feed reader" } },
  { names: ["postgres", "postgresql"], role: { preset: "postgres", label: "Postgres" } },
  { names: ["redis", "valkey"], role: { preset: "redis", label: "Redis" } },
];

const SERVICE: AppRole = { preset: "service", label: "Service" };

/** The repository path of an image reference, lower case: no registry host, tag or digest. */
export function imageRepo(image: string): string {
  const bare = image.trim().toLowerCase().split("@")[0] ?? "";
  const parts = bare.split("/");
  const last = parts.length - 1;
  parts[last] = (parts[last] ?? "").split(":")[0] ?? "";
  // A first segment with a dot or a port, or localhost, is a registry host.
  if (parts.length > 1 && /[.:]|^localhost$/.test(parts[0] ?? "")) parts.shift();
  return parts.join("/");
}

function familyOf(image: string): AppRole | null {
  const owners = imageRepo(image).split("/");
  const name = owners.pop();
  return FAMILIES.find((f) => f.names.some((n) => (n.endsWith("/") ? owners.includes(n.slice(0, -1)) : n === name)))?.role ?? null;
}

/**
 * A managed service and built code read as their kind. A published image reads as what it is, and
 * one nobody chose a narrower kind for is a Service, since Backend would claim code that is not there.
 */
export function appRole(kind: AppKind, image?: string | null): AppRole {
  const byKind = { preset: KIND_PRESET[kind], label: KIND_LABEL[kind] };
  if (!image || kind === "postgres" || kind === "redis" || kind === "s3") return byKind;
  return familyOf(image) ?? (kind === "backend" ? SERVICE : byKind);
}
