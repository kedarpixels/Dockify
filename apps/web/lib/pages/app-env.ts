/* The app page's env, read server-side without ever carrying a secret.
 *
 * The server loader's result is serialized into the page data (RSC payload and HTML), so the app page
 * reads the secret-free GET /env/state route, never the raw /env one, and this module drops any secret
 * value that still arrives. A secret's plaintext reaches the browser only through the audited per-key
 * POST /env/reveal. Kept free of Next and React imports so it can be tested on its own. */

/** A linked variable's target, as EnvRefView in project-detail.ts. Carries no credential. */
interface RefLike {
  resourceId: string;
  resourceName: string;
  kind: "postgres" | "redis" | "s3" | null;
  environment: string;
  field: "url" | "urlNoTls" | "host" | "port" | "user" | "password" | "database" | "endpoint" | "bucket" | "accessKey" | "secretKey";
  missing?: boolean;
}

/** Structural copies of ProjectEnv and the shared part of EnvState in project-detail.ts. */
interface ListedVar {
  key: string;
  value: string;
  secret: boolean;
  updatedAt: string;
  ref?: RefLike;
}

interface StateEntry {
  key: string;
  value: string | null;
  secret: boolean;
  updatedAt: string;
  ref?: RefLike;
}

/** The secret-free env route for a project. */
export const appEnvPath = (slug: string): string => `/api/v1/projects/${encodeURIComponent(slug)}/env/state`;

/** Shared variables per environment, with every secret value blanked whatever the API sent. */
export function envFromState(state: { environments: Array<{ name: string; vars: StateEntry[] }> }): {
  environments: Array<{ name: string; vars: ListedVar[] }>;
} {
  return {
    environments: state.environments.map((e) => ({
      name: e.name,
      vars: e.vars.map((v) => ({
        key: v.key,
        // A link never carries a value here either: what it resolves to is a credential.
        value: v.secret || v.ref ? "" : (v.value ?? ""),
        secret: v.secret || Boolean(v.ref),
        updatedAt: v.updatedAt,
        ...(v.ref ? { ref: v.ref } : {}),
      })),
    })),
  };
}
