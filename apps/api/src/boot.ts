import { dashboardDomain as D, projects as P } from "@dockify/contracts";
import type { Keyring } from "@dockify/crypto";
import { enqueuePreviewTx, enqueueTx, Prisma, type Db, type IngressMode } from "@dockify/db";
import { audit } from "./audit.ts";

export class BootError extends Error {}

/**
 * Creates the instance row on first boot and refuses to start with a different master key after
 * that: a wrong key must fail once, loudly, instead of failing per credential forever.
 */
export async function ensureInstance(db: Db, ring: Keyring, publicUrl: string, ingress: IngressMode): Promise<void> {
  const row = await db.instance.findUnique({ where: { id: 1 } });
  if (!row) {
    // A fresh database: the migration made the primary server before this row existed.
    await db.$transaction(async (tx) => {
      await tx.instance.create({ data: { id: 1, name: "Dockify", publicUrl, masterKeyFingerprint: ring.active, ingressMode: ingress } });
      await tx.server.updateMany({ where: { isPrimary: true }, data: { name: "Dockify", ingress } });
    });
    return;
  }
  if (row.masterKeyFingerprint !== ring.active && !ring.keys.has(row.masterKeyFingerprint)) {
    throw new BootError(
      `DOCKIFY_MASTER_KEY does not match this database (expected key ${row.masterKeyFingerprint}). ` +
        "Restore the original key, or set it as DOCKIFY_MASTER_KEY_PREVIOUS while rotating.",
    );
  }
  // DOCKIFY_INGRESS is what this install really runs, so the primary server row follows it.
  await db.server.updateMany({ where: { isPrimary: true, ingress: { not: ingress } }, data: { ingress } });
  if (row.publicUrl !== publicUrl) await recordAddressChange(db, row.publicUrl, publicUrl);
}

/** How many addresses the dashboard left keep answering; the oldest stops first. */
const KEEP_PREVIOUS = 3;
const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};
const isLocal = (host: string) => host === "localhost" || host === "[::1]" || /^[\d.]+$/.test(host);

/**
 * Every way DOCKIFY_PUBLIC_URL can move (Settings, `dockify admin set-domain`, .env by hand) meets here.
 * The address it left joins the ones that keep answering and redirect.
 */
export async function recordAddressChange(db: Db, before: string, after: string): Promise<void> {
  const from = hostOf(before);
  const to = hostOf(after);
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('dockify.dashboard.domain'))`;
    const row = await tx.instance.findUnique({ where: { id: 1 }, select: { dashboardDomain: true, dashboardPreviousHosts: true, previewDomain: true, dashboardCfRecords: true } });
    if (!row || !to) {
      await tx.instance.update({ where: { id: 1 }, data: { publicUrl: after } });
      return;
    }
    const kept = from && !isLocal(from) ? [from, ...(row.dashboardPreviousHosts ?? [])] : (row.dashboardPreviousHosts ?? []);
    const previous = [...new Set(kept)].filter((h) => h !== to).slice(0, KEEP_PREVIOUS);
    const pending = D.readPendingDomain(row.dashboardDomain);
    const done = pending?.host === to;
    // The DNS record Dockify made for the new address outlives the pending row, so dropping the address later
    // removes that record and only that one. On an owner-made record, any older entry for the name is forgotten.
    const records = D.readCfRecords(row.dashboardCfRecords);
    if (done && pending.cfRecord) records[to] = pending.cfRecord;
    else if (done) delete records[to];
    await tx.instance.update({
      where: { id: 1 },
      data: {
        publicUrl: after,
        dashboardPreviousHosts: previous,
        dashboardCfRecords: Object.keys(records).length ? records : Prisma.DbNull,
        ...(done ? { dashboardDomain: Prisma.DbNull } : {}),
        ...(from && !isLocal(from) && !isLocal(to) ? { dashboardLastChange: { from, to, at: new Date().toISOString(), webhook: "none", webhookError: null } } : {}),
      },
    });
    await enqueueTx(tx, { kind: "dashboard_domain", lane: "maintenance", payload: {}, dedupeKey: "dashboard.domain" });
    // Previews follow the address while no preview domain was set by hand.
    if (row.previewDomain === null) {
      for (const d of [P.defaultPreviewDomain(before), P.defaultPreviewDomain(after)]) if (d) await enqueuePreviewTx(tx, "preview_dns", d);
    }
    await audit(tx, {
      category: "config", action: "dashboard.address", verb: "now answers on", actorType: "system", actorId: null, actorName: "Dockify",
      targetType: "instance", targetLabel: to, suffix: from ? `instead of ${from}` : null,
    });
  });
}
