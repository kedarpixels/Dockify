// While a restore holds an app (App.quiescedByJobId), a deploy someone asked for is refused and a push waits.
import { describe, expect, it } from "vitest";
import type { Prisma } from "@dockify/db";
import { requestDeployTx } from "./enqueue.ts";

const APP = "0f0e0d0c-0000-4000-8000-0000000000a1";

function fakeTx(quiescedByJobId: string | null) {
  const created: unknown[] = [];
  const stamped: unknown[] = [];
  const tx = {
    $executeRaw: async () => 0,
    deployment: { findFirst: async () => null, create: async ({ data }: { data: unknown }) => (created.push(data), { id: "d1" }) },
    job: { findFirst: async () => null, create: async ({ data }: { data: unknown }) => (created.push(data), { id: "j1" }) },
    app: {
      findUnique: async () => ({ serverId: "s1", quiescedByJobId }),
      update: async () => ({}),
      updateMany: async ({ data }: { data: unknown }) => (stamped.push(data), { count: 1 }),
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, created, stamped };
}
const push = { trigger: "push" as const, actorType: "system" as const };

describe("a deploy asked for during a restore of the app's data", () => {
  it("is refused with 409 when a person asked (deploy, redeploy, rollback)", async () => {
    const f = fakeTx("job-1");
    await expect(requestDeployTx(f.tx, APP, { trigger: "manual", actorType: "user" }, "reject")).rejects.toMatchObject({ status: 409, code: "RESTORE_IN_PROGRESS", message: "A restore of this app's data is running. Try again when it finishes." });
    expect(f.created).toEqual([]);
  });

  it("waits as a pending deploy when a push or a variable change asked, and queues nothing", async () => {
    const f = fakeTx("job-1");
    expect(await requestDeployTx(f.tx, APP, push, "coalesce")).toEqual({ kind: "coalesced" });
    expect(f.created).toEqual([]);
    expect(f.stamped).toEqual([{ pendingDeployAt: expect.any(Date) }]);
  });

  it("does not hold a preview, which runs in its own container on none of the app's volumes", async () => {
    const f = fakeTx("job-1");
    expect(await requestDeployTx(f.tx, APP, { ...push, previewId: "0f0e0d0c-0000-4000-8000-0000000000b1" }, "coalesce")).toMatchObject({ kind: "queued" });
  });

  it("queues as always once the restore has let go", async () => {
    const f = fakeTx(null);
    expect(await requestDeployTx(f.tx, APP, push, "coalesce")).toMatchObject({ kind: "queued", deploymentId: "d1" });
  });
});
