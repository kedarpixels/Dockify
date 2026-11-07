-- The dashboard's own address can change from Settings (or `dockify admin set-domain`). The worker
-- checks a new domain; the updater, which holds the Docker socket, rewrites .env and recreates the
-- control services.
ALTER TYPE "JobKind" ADD VALUE 'dashboard_domain';
ALTER TYPE "JobKind" ADD VALUE 'dashboard_domain_apply';

-- The domain being set up, with what its last check found (contracts PendingDashboardDomain).
ALTER TABLE "instance" ADD COLUMN "dashboardDomain" JSONB;
-- Earlier addresses that still answer and redirect to the current one.
ALTER TABLE "instance" ADD COLUMN "dashboardPreviousHosts" TEXT[] DEFAULT ARRAY[]::TEXT[];
-- The last change of address and what followed it (contracts DashboardLastChange).
ALTER TABLE "instance" ADD COLUMN "dashboardLastChange" JSONB;
