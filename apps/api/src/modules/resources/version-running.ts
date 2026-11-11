// Its own file, importing nothing from resources: projects asks this before a delete, and resources imports projects.
import type { Prisma, Tx } from "@dockify/db";
import { HttpError } from "../../errors.ts";

export const upgradeRunning = (db: Tx, id: string) =>
  db.job.findFirst({ where: { kind: "service_upgrade", dedupeKey: `service-upgrade:${id}`, completedAt: null, failedAt: null }, select: { id: true } });

/** A version change running on this service, or into it, is holding its data open. */
export async function assertNoVersionChangeRunning(tx: Prisma.TransactionClient, appId: string): Promise<void> {
  if (await upgradeRunning(tx, appId)) throw new HttpError(409, "A version change of this service is running. Wait for it to finish.", "BUSY");
  const prior = await tx.app.findFirst({ where: { serviceUpgrade: { path: ["targetId"], equals: appId } }, select: { id: true } });
  if (prior && (await upgradeRunning(tx, prior.id))) throw new HttpError(409, "A version change into this service is running. Wait for it to finish.", "BUSY");
}
