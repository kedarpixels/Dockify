-- An app's display name: what people read, free to change. Null shows the app's name, which stays
-- the identity every container, volume, network alias, preview host, link and CLI call uses.
ALTER TABLE "apps" ADD COLUMN "displayName" TEXT;

-- 1 to 60 characters, as the contract allows (AppDisplayName).
ALTER TABLE "apps" ADD CONSTRAINT "apps_display_name_length" CHECK ("displayName" IS NULL OR char_length("displayName") BETWEEN 1 AND 60);

-- Two apps of one environment never show the same name, whatever its case. Prisma cannot express it.
CREATE UNIQUE INDEX "apps_display_name_unique" ON "apps"("environmentId", lower("displayName")) WHERE "displayName" IS NOT NULL;
