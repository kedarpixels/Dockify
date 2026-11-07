-- Notification webhooks: a list of named webhooks (Discord, Slack, Microsoft Teams, Google Chat,
-- Telegram, Mattermost, Rocket.Chat, ntfy, generic) in place of the single Discord URL and the
-- single generic webhook, alert rules linked to the webhooks they send to, webhook logos in the
-- icon table, and the GitHub App's client secret. The schema part is what Prisma generates; the
-- data part moves the two old channels over; the invariants part updates the CHECK constraints.

-- CreateEnum
CREATE TYPE "WebhookProvider" AS ENUM ('discord', 'slack', 'teams', 'google_chat', 'telegram', 'mattermost', 'rocket_chat', 'ntfy', 'generic');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SecretKind" ADD VALUE 'github_client_secret';
ALTER TYPE "SecretKind" ADD VALUE 'channel_secret';

-- AlterEnum
ALTER TYPE "JobKind" ADD VALUE 'webhook_send';

-- AlterTable
ALTER TABLE "icon_images" ADD COLUMN     "webhookId" UUID;

-- CreateTable
CREATE TABLE "alert_rule_webhooks" (
    "ruleId" UUID NOT NULL,
    "webhookId" UUID NOT NULL,

    CONSTRAINT "alert_rule_webhooks_pkey" PRIMARY KEY ("ruleId","webhookId")
);

-- CreateTable
CREATE TABLE "notification_webhooks" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "provider" "WebhookProvider" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updates" BOOLEAN NOT NULL DEFAULT true,
    "host" TEXT NOT NULL,
    "chatId" TEXT,
    "secretId" UUID,
    "secondSecretId" UUID,
    "iconChoice" "IconChoice" NOT NULL DEFAULT 'auto',
    "logoUrl" TEXT,
    "faviconCheckedAt" TIMESTAMPTZ(3),
    "faviconError" TEXT,
    "error" TEXT,
    "lastSentAt" TIMESTAMPTZ(3),
    "lastFailedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alert_rule_webhooks_webhookId_idx" ON "alert_rule_webhooks"("webhookId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_webhooks_name_key" ON "notification_webhooks"("name");

-- CreateIndex
CREATE UNIQUE INDEX "notification_webhooks_secretId_key" ON "notification_webhooks"("secretId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_webhooks_secondSecretId_key" ON "notification_webhooks"("secondSecretId");

-- CreateIndex
CREATE UNIQUE INDEX "icon_images_webhookId_source_key" ON "icon_images"("webhookId", "source");

-- AddForeignKey
ALTER TABLE "icon_images" ADD CONSTRAINT "icon_images_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "notification_webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rule_webhooks" ADD CONSTRAINT "alert_rule_webhooks_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "alert_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rule_webhooks" ADD CONSTRAINT "alert_rule_webhooks_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "notification_webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_webhooks" ADD CONSTRAINT "notification_webhooks_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_webhooks" ADD CONSTRAINT "notification_webhooks_secondSecretId_fkey" FOREIGN KEY ("secondSecretId") REFERENCES "secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Data. The Discord channel and the generic webhook channel become the first entries of the list.
-- Each keeps its row id, so its sealed URL (bound to integration:<id> when it was sealed) opens as
-- before, and its secret row moves over untouched. Discord kept getting update notices; the
-- generic webhook never did, and still does not.
INSERT INTO "notification_webhooks" ("id", "name", "provider", "enabled", "updates", "host", "secretId", "error", "createdAt", "updatedAt")
SELECT "id",
       CASE "name" WHEN 'discord' THEN 'Discord' ELSE 'Webhook' END,
       (CASE "name" WHEN 'discord' THEN 'discord' ELSE 'generic' END)::"WebhookProvider",
       true,
       "name" = 'discord',
       COALESCE(NULLIF("config"->>'host', ''), 'unknown'),
       "secretId",
       CASE WHEN "status" = 'error' THEN "error" END,
       "createdAt",
       CURRENT_TIMESTAMP
FROM "integrations"
WHERE "kind" = 'channel' AND "name" IN ('discord', 'webhook') AND "secretId" IS NOT NULL;

-- Rules that sent to Discord or to the webhook now link to the moved entries instead.
INSERT INTO "alert_rule_webhooks" ("ruleId", "webhookId")
SELECT r."id", w."id"
FROM "alert_rules" r
JOIN "notification_webhooks" w
  ON (w."provider" = 'discord' AND 'discord' = ANY (r."channels"))
  OR (w."provider" = 'generic' AND 'webhook' = ANY (r."channels"));

UPDATE "alert_rules" SET "channels" = array_remove(array_remove("channels", 'discord'), 'webhook')
WHERE "channels" && ARRAY['discord', 'webhook']::"AlertChannel"[];

-- A rule left with nowhere to send keeps the in-app bell, which a new rule gets by default.
UPDATE "alert_rules" SET "channels" = ARRAY['bell']::"AlertChannel"[]
WHERE cardinality("channels") = 0
  AND NOT EXISTS (SELECT 1 FROM "alert_rule_webhooks" l WHERE l."ruleId" = "alert_rules"."id");

-- The old channel rows go; their secrets now belong to the webhooks.
DELETE FROM "integrations" WHERE "kind" = 'channel';

-- Invariants Prisma cannot express (CHECK constraints are not introspected, so they never drift).
-- An icon belongs to exactly one app, project or webhook.
ALTER TABLE "icon_images" DROP CONSTRAINT "icon_images_one_owner";
ALTER TABLE "icon_images" ADD CONSTRAINT "icon_images_one_owner" CHECK (num_nonnulls("appId", "projectId", "webhookId") = 1);
-- GIF and SVG are only ever a webhook's logo, and an SVG only the sanitised text Dockify rebuilt.
ALTER TABLE "icon_images" DROP CONSTRAINT "icon_images_mime_known";
ALTER TABLE "icon_images" ADD CONSTRAINT "icon_images_mime_known" CHECK ("mime" IN ('image/png', 'image/jpeg', 'image/webp', 'image/x-icon') OR ("webhookId" IS NOT NULL AND "mime" IN ('image/gif', 'image/svg+xml')));
-- A Telegram webhook names the chat it posts to; no other provider has one.
ALTER TABLE "notification_webhooks" ADD CONSTRAINT "notification_webhooks_telegram_chat" CHECK (("provider" = 'telegram') = ("chatId" IS NOT NULL));
ALTER TABLE "notification_webhooks" ADD CONSTRAINT "notification_webhooks_name_length" CHECK (char_length("name") BETWEEN 1 AND 60);
