import { Icon } from "@/components/icon";
import type { EnvRef, EnvRefField, EnvRefView, StatefulKind } from "@/lib/pages/project-detail";
import type { AppKind } from "@/lib/types";

/* Linked variables: a variable that names a service's credential instead of holding a copy. The
   API resolves it at deploy time (contracts env-refs.ts holds the same field table), so here it
   only ever shows as a chip: "horseai / postgres, DATABASE_URL". */

/** The fields each kind offers, with the key a new link gets and whether it is picked by default. */
export const REF_FIELDS: Readonly<Record<StatefulKind, ReadonlyArray<{ field: EnvRefField; key: string; linked: boolean }>>> = {
  postgres: [
    { field: "url", key: "DATABASE_URL", linked: true },
    { field: "urlNoTls", key: "DATABASE_URL_NO_TLS", linked: false },
    { field: "host", key: "PGHOST", linked: false },
    { field: "port", key: "PGPORT", linked: false },
    { field: "user", key: "PGUSER", linked: false },
    { field: "password", key: "PGPASSWORD", linked: false },
    { field: "database", key: "PGDATABASE", linked: false },
  ],
  redis: [
    { field: "url", key: "REDIS_URL", linked: true },
    { field: "host", key: "REDIS_HOST", linked: false },
    { field: "port", key: "REDIS_PORT", linked: false },
    { field: "password", key: "REDIS_PASSWORD", linked: false },
  ],
  s3: [
    { field: "endpoint", key: "S3_ENDPOINT", linked: true },
    { field: "bucket", key: "S3_BUCKET", linked: true },
    { field: "accessKey", key: "S3_ACCESS_KEY", linked: true },
    { field: "secretKey", key: "S3_SECRET_KEY", linked: true },
  ],
};

export const KIND_NAME: Record<StatefulKind, string> = { postgres: "Postgres", redis: "Redis", s3: "Storage" };

export const FIELD_NAME: Record<EnvRefField, string> = {
  url: "Connection URL",
  urlNoTls: "Connection URL, without TLS",
  host: "Host",
  port: "Port",
  user: "User",
  password: "Password",
  database: "Database",
  endpoint: "Endpoint",
  bucket: "Bucket",
  accessKey: "Access key",
  secretKey: "Secret key",
};

export const isService = (k: AppKind): k is StatefulKind => k === "postgres" || k === "redis" || k === "s3";

/** A field by the key it defaults to, which is also how a link names it: "DATABASE_URL". */
export const fieldLabel = (kind: StatefulKind | null, field: EnvRefField) => (kind ? REF_FIELDS[kind].find((f) => f.field === field)?.key : undefined) ?? field;

/** "horseai / postgres, DATABASE_URL", the separator every project and app pair uses, or the deleted case, which the next deploy refuses. */
export function refText(slug: string, ref: EnvRef, view: Pick<EnvRefView, "resourceName" | "kind" | "missing"> | undefined) {
  if (!view || view.missing) return `Deleted service, ${ref.field}`;
  return `${slug} / ${view.resourceName}, ${fieldLabel(view.kind, ref.field)}`;
}

/**
 * The link as a chip: 12px glyph and text, like every chip. A broken link (its service was deleted)
 * turns red; the row says what to do about it in words under the chip, never only in a tip.
 */
export function RefChip({ text, missing }: { text: string; missing?: boolean }) {
  return (
    <span className="px-ref" data-missing={missing || undefined} data-tip={missing ? undefined : "Resolved at deploy time"}>
      <Icon name={missing ? "alert" : "link"} size={12} />
      <span className="px-ref-text">
        <span className="sr">{missing ? "Broken link, " : "Linked to "}</span>
        {text}
      </span>
    </span>
  );
}
