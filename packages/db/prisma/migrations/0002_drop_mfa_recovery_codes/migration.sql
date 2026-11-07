-- Two-factor recovery codes are removed. A lost authenticator is reset on the host instead:
-- dockify admin disable-mfa <email> (apps/api/src/admin.ts).

-- DropForeignKey
ALTER TABLE "mfa_recovery_codes" DROP CONSTRAINT "mfa_recovery_codes_userId_fkey";

-- DropTable
DROP TABLE "mfa_recovery_codes";
