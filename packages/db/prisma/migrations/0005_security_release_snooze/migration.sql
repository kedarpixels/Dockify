-- Security releases: the signed feed's security block raises a popup and a banner in the console.
-- Each member can put the popup off ("Remind me in" 1, 3 or 7 days), keyed to the release and its
-- level so a newer security release opens it again, and the updater emails every admin once per
-- security release (the security_notify job), remembered on the instance row.

-- AlterEnum
ALTER TYPE "JobKind" ADD VALUE 'security_notify';

-- AlterTable
ALTER TABLE "instance" ADD COLUMN     "securityNoticeVersion" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "securityRemindKey" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "securityRemindAt" TIMESTAMPTZ(3);
