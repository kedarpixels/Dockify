/**
 * Env references: a variable whose value is a managed service's credential, read at deploy time
 * instead of copied. The variable stores only "which resource, which field"; the api resolves it
 * when a deployment starts, so rotating a service password reaches every linked app on its next
 * deploy. A reference may only point at a service in the same project as the variable.
 *
 * Stored inside the sealed env value as ENV_REF_MARK + "<resourceId>:<field>". The mark starts
 * with a NUL, which EnvValue refuses, so a typed value can never pass for a reference.
 */
import { z } from "zod";
import { ENV_REF_MARK, StatefulKind, Uuid } from "./common.ts";

type Kind = z.infer<typeof StatefulKind>;

export const EnvRefField = z.enum(["url", "urlNoTls", "host", "port", "user", "password", "database", "endpoint", "bucket", "accessKey", "secretKey"]);
export type EnvRefField = z.infer<typeof EnvRefField>;

/** The fields each kind of service offers, with the key a new link names it by default. */
export const REF_FIELDS: Readonly<Record<Kind, ReadonlyArray<{ field: EnvRefField; key: string; linked: boolean }>>> = {
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

export const refFieldAllowed = (kind: Kind, field: EnvRefField): boolean => REF_FIELDS[kind].some((f) => f.field === field);

/** The default key of a field, which is also how the dashboard labels it: "DATABASE_URL". */
export const refFieldLabel = (kind: Kind, field: EnvRefField): string => REF_FIELDS[kind].find((f) => f.field === field)?.key ?? field;

/** What a change sends to link a variable. */
export const EnvRef = z.strictObject({ resourceId: Uuid, field: EnvRefField });
export type EnvRef = z.infer<typeof EnvRef>;

/** What a listing sends for a linked variable. The value itself stays behind env.reveal. */
export const EnvRefView = z.object({
  resourceId: z.string(),
  resourceName: z.string(),
  /** Null when the service was deleted since. */
  kind: StatefulKind.nullable(),
  environment: z.string(),
  field: EnvRefField,
  /** The service was deleted since; the next deploy fails until the variable is relinked or removed. */
  missing: z.boolean().optional(),
});
export type EnvRefView = z.infer<typeof EnvRefView>;

export const encodeEnvRef = (ref: EnvRef): string => `${ENV_REF_MARK}${ref.resourceId}:${ref.field}`;

/** The reference a stored value holds, or null for a plain value (or a malformed reference). */
export function decodeEnvRef(value: string | null | undefined): EnvRef | null {
  if (!value?.startsWith(ENV_REF_MARK)) return null;
  const [resourceId, field] = value.slice(ENV_REF_MARK.length).split(":");
  const parsed = EnvRef.safeParse({ resourceId, field });
  return parsed.success ? parsed.data : null;
}

export const isEnvRefValue = (value: string | null | undefined): boolean => !!value?.startsWith(ENV_REF_MARK);

/** The port each service listens on inside its environment network. */
export const REF_PORTS: Readonly<Record<Kind, number>> = { postgres: 5432, redis: 6379, s3: 9000 };

/** A managed service as the resolver sees it. `host` is its in-network alias, the app name. */
export interface RefTarget {
  kind: Kind;
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
  /** S3 only: the bucket apps use, named after the service. */
  bucket?: string;
}

/** The value one field resolves to. The same shapes the worker hands a service's own container. */
export function refValue(t: RefTarget, field: EnvRefField): string {
  const u = encodeURIComponent(t.user);
  const p = encodeURIComponent(t.password);
  switch (field) {
    case "url":
      return t.kind === "postgres"
        ? `postgresql://${u}:${p}@${t.host}:${t.port}/${encodeURIComponent(t.database ?? "postgres")}`
        : `redis://${u}:${p}@${t.host}:${t.port}`;
    // For clients that want TLS unless told otherwise (lib/pq). A service is reached over its private network.
    case "urlNoTls":
      return `postgresql://${u}:${p}@${t.host}:${t.port}/${encodeURIComponent(t.database ?? "postgres")}?sslmode=disable`;
    case "endpoint":
      return `http://${t.host}:${t.port}`;
    case "host":
      return t.host;
    case "port":
      return String(t.port);
    case "user":
    case "accessKey":
      return t.user;
    case "password":
    case "secretKey":
      return t.password;
    case "database":
      return t.database ?? "postgres";
    case "bucket":
      return t.bucket ?? t.host;
  }
}
