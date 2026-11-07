-- The Vercel deployment mirror: a deployment row can be one Vercel built and hosts, keyed by
-- Vercel's own id, plus the sealed secret Vercel signs its webhook deliveries with and the job that
-- mirrors one project. These changes were first written into 0001_init after installs had applied
-- it, so those installs never got them; 0001_init is back to what shipped and they live here.
--
-- Both enum values go where the schema lists them, so a fresh install and an upgraded one end with
-- the same order. Postgres allows ADD VALUE inside the migration's transaction because nothing in
-- this migration uses the new values; DeploymentProvider is created here, so its values are usable.

-- AlterEnum
ALTER TYPE "SecretKind" ADD VALUE 'vercel_webhook_secret' AFTER 'email_message';

-- AlterEnum
ALTER TYPE "JobKind" ADD VALUE 'vercel_mirror' AFTER 'deploy_notify';

-- CreateEnum
CREATE TYPE "DeploymentProvider" AS ENUM ('dockify', 'vercel');

-- CreateEnum
CREATE TYPE "ExternalTarget" AS ENUM ('production', 'preview');

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "provider" "DeploymentProvider" NOT NULL DEFAULT 'dockify';

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "externalId" TEXT;

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "externalUrl" TEXT;

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "inspectorUrl" TEXT;

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "externalTarget" "ExternalTarget";

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "externalSource" TEXT;

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "externalCreator" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "deployments_provider_externalId_key" ON "deployments"("provider", "externalId");

-- Invariants Prisma cannot express (CHECK constraints are not introspected, so they never drift).
-- Only a provider's own deployment carries the provider's id.
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_external_id_needs_provider" CHECK ("externalId" IS NULL OR "provider" <> 'dockify');
