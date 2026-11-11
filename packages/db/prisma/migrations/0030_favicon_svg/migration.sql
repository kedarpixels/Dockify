-- A fetched favicon may be an SVG now: many sites declare no other icon. It is stored only as the
-- sanitised text Dockify rebuilt, like a webhook's SVG logo. An upload for an app or a project is
-- still a raster only, and GIF is still a webhook logo's only.
ALTER TABLE "icon_images" DROP CONSTRAINT "icon_images_mime_known";
ALTER TABLE "icon_images" ADD CONSTRAINT "icon_images_mime_known" CHECK ("mime" IN ('image/png', 'image/jpeg', 'image/webp', 'image/x-icon') OR ("webhookId" IS NOT NULL AND "mime" IN ('image/gif', 'image/svg+xml')) OR ("source" = 'favicon' AND "mime" = 'image/svg+xml'));
