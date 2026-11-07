-- Managed services (Postgres, Redis, Storage) deploy through the worker's managed path:
--
-- 1. apps.pinnedImage: the digest a service's image tag resolved to on its first pull. Later
--    deploys run that digest until the configured image changes (the worker fills it in,
--    data/images.ts). projects.previewDbImage does the same for the project's preview databases.
--
-- 2. Every managed service keeps its data on a named volume recorded as a Volume row, so a
--    redeploy, a backup and a restore all find the same data. Services created before this
--    release had no row and kept their data on an anonymous Docker volume that each redeploy
--    replaced. This adds the row each such service is missing; the first deploy after the
--    upgrade copies the data its previous container still holds into the named volume.

-- AlterTable
ALTER TABLE "apps" ADD COLUMN     "pinnedImage" TEXT;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "previewDbImage" TEXT;

-- Data: one dockify-data-<appId> volume row per managed service that has none at its data path.
INSERT INTO "volumes" ("id", "appId", "name", "mountPath")
SELECT gen_random_uuid(), a."id", 'dockify-data-' || a."id"::text, CASE a."kind" WHEN 'postgres' THEN '/var/lib/postgresql/data' ELSE '/data' END
FROM "apps" a
WHERE a."kind" IN ('postgres', 'redis', 's3')
  AND NOT EXISTS (
    SELECT 1 FROM "volumes" v
    WHERE v."appId" = a."id" AND v."mountPath" = CASE a."kind" WHEN 'postgres' THEN '/var/lib/postgresql/data' ELSE '/data' END
  )
  AND NOT EXISTS (SELECT 1 FROM "volumes" v WHERE v."name" = 'dockify-data-' || a."id"::text);
