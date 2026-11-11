/** Builds the X-Registry-Auth header for one pull. The token is opened here, for one call, never logged. */
import { readSecretValue, type Db, type SecretVault } from "@dockify/db";

export interface RegistryAuth {
  username: string;
  password: string;
  serveraddress: string;
}

export class RegistryAuthError extends Error {}

/** Docker Hub authenticates against its index URL, everything else against its host. */
export const serverAddress = (host: string) => (host === "docker.io" ? "https://index.docker.io/v1/" : host);

export function imageRegistryHost(ref: string): string {
  const first = ref.split("/")[0] ?? "";
  return ref.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost") ? first.toLowerCase() : "docker.io";
}

export async function registryAuthFor(db: Db, vault: SecretVault, registryId: string | null, image: string): Promise<RegistryAuth | null> {
  if (!registryId) return null;
  const row = await db.integration.findFirst({ where: { id: registryId, kind: "registry" } });
  if (!row?.secretId) throw new RegistryAuthError("The app's registry credentials were removed");
  const c = row.config as { host?: string; username?: string };
  if (!c.host || !c.username) throw new RegistryAuthError("The registry credentials are incomplete");
  // Never hand a token for one registry to an image that names another.
  if (imageRegistryHost(image) !== c.host) throw new RegistryAuthError(`The image is not on ${c.host}, so its credentials are not sent`);
  const password = await readSecretValue(db, vault, row.secretId);
  if (!password) throw new RegistryAuthError("The registry token is missing");
  return { username: c.username, password, serveraddress: serverAddress(c.host) };
}

/** base64url JSON, as the Docker Engine API reads X-Registry-Auth. */
export const xRegistryAuth = (a: RegistryAuth) => Buffer.from(JSON.stringify(a)).toString("base64url");
