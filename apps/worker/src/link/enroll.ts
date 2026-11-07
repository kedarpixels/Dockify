/**
 * Enrolment: a key the worker has never seen presents a one-time token once. One atomic update, so a
 * token works one time only. An agent key is what identifies a server from then on. The first server
 * goes straight to active; any other waits for the admin's Approve.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Db } from "@dockify/db";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface KnownServer {
  id: string;
  state: "awaiting_join" | "pending_approval" | "active" | "revoked";
}

/** The server a key belongs to, or null. A revoked row keeps its key, so that key stays refused. */
export const serverByPin = (db: Db, pin: string): Promise<KnownServer | null> =>
  db.server.findUnique({ where: { certPin: pin }, select: { id: true, state: true } });

/** Takes a join token for this key. True when it matched; false says nothing about why. */
export async function enroll(db: Db, token: string, pin: string, joinedIp: string | null): Promise<boolean> {
  const n = await db.$executeRaw`
    UPDATE servers SET
      "certPin" = ${pin},
      "joinTokenHash" = NULL,
      "joinExpiresAt" = NULL,
      "joinedIp" = ${joinedIp},
      state = CASE WHEN "isPrimary" THEN 'active'::"ServerState" ELSE 'pending_approval'::"ServerState" END,
      "updatedAt" = now()
    WHERE "joinTokenHash" = ${sha256(token)}
      AND "certPin" IS NULL
      AND (("isPrimary" AND state = 'active') OR (state = 'awaiting_join' AND "joinExpiresAt" > now()))`;
  return n === 1;
}

/**
 * The first server's token, from the file the installer wrote. Stored as its hash while the row has
 * no key, so a restart before the agent joined loses nothing and nothing changes afterwards.
 */
export async function offerPrimaryToken(db: Db, tokenFile: string): Promise<boolean> {
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (!token) return false;
  const n = await db.$executeRaw`
    UPDATE servers SET "joinTokenHash" = ${sha256(token)}, "updatedAt" = now()
    WHERE "isPrimary" AND "certPin" IS NULL`;
  return n === 1;
}
