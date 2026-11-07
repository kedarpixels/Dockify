-- What the Settings event switches send, and what became of an invite's email.
--   event_notify    one instance event (a backup failed, a certificate near expiry): email to admins, webhooks.
--   deploy_status   the commit status of a deploy on GitHub.
--   invites         the delivery result of the invite email, written by the worker that sends it.
--   domains         the certificate expiry already warned about, so one certificate warns once.

-- AlterEnum
ALTER TYPE "JobKind" ADD VALUE 'event_notify';
ALTER TYPE "JobKind" ADD VALUE 'deploy_status';

-- AlterTable
ALTER TABLE "invites" ADD COLUMN     "emailStatus" TEXT;
ALTER TABLE "invites" ADD COLUMN     "emailError" TEXT;

-- AlterTable
ALTER TABLE "domains" ADD COLUMN     "tlsWarnedFor" TIMESTAMPTZ(3);
