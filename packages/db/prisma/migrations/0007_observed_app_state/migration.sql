-- Observed app state: App.status becomes what the daemon reports, written by the worker's observe
-- pass (restarting or crash looping, exited, missing), and an app whose first deploy failed reads
-- failed instead of unknown. The app row keeps its container's start time and the worker's last
-- reachability probe of its public route (the public status page), and the instance row keeps the
-- control plane's own containers as the worker last saw them (the server page).
--
-- No data statements: a new enum value cannot be used in the transaction that adds it, and the
-- worker's first observe pass after the upgrade rewrites every app's status within seconds.

-- AlterEnum
ALTER TYPE "AppStatus" ADD VALUE 'restarting';
ALTER TYPE "AppStatus" ADD VALUE 'exited';
ALTER TYPE "AppStatus" ADD VALUE 'missing';
ALTER TYPE "AppStatus" ADD VALUE 'failed';

-- AlterTable
ALTER TABLE "apps" ADD COLUMN     "containerStartedAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "apps" ADD COLUMN     "reachable" BOOLEAN;

-- AlterTable
ALTER TABLE "apps" ADD COLUMN     "reachableAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "instance" ADD COLUMN     "controlPlane" JSONB;

-- AlterTable
ALTER TABLE "instance" ADD COLUMN     "controlPlaneAt" TIMESTAMPTZ(3);
