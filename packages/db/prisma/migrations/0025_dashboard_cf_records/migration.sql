-- The Cloudflare records Dockify made for the dashboard's addresses, so Stop answering on an old
-- address removes the one Dockify made and never one the owner made.
ALTER TABLE "instance" ADD COLUMN "dashboardCfRecords" JSONB;
