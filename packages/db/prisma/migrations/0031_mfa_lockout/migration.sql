-- One lockout for every authenticator code check of a user (sign in, step-up, turning two-factor
-- off). It lived in the api's memory, so a restart or an update cleared it. Each lockout in a row
-- doubles the next, and a right code clears all three columns.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "totpFailedCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "totpLockouts" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "totpLockedUntil" TIMESTAMPTZ(3);
