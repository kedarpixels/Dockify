-- Three CHECK constraints from 0001_init the contracts outgrew, each a 500 on valid input.

-- Railpack became a builder in 0017.
ALTER TABLE "apps" DROP CONSTRAINT "apps_builder_known";
ALTER TABLE "apps" ADD CONSTRAINT "apps_builder_known" CHECK ("builder" IN ('auto', 'dockerfile', 'railpack'));

-- A new Vercel app follows with no project picked yet; only deploying to Vercel needs one.
ALTER TABLE "apps" DROP CONSTRAINT "apps_vercel_target";
ALTER TABLE "apps" ADD CONSTRAINT "apps_vercel_target" CHECK ("deployTarget" <> 'vercel' OR "vercelFollowOnly" OR "vercelProjectId" IS NOT NULL);

-- The contract refuses a ".." path segment; a name like "a..b" is an ordinary folder.
ALTER TABLE "apps" DROP CONSTRAINT "apps_root_dir_relative";
ALTER TABLE "apps" ADD CONSTRAINT "apps_root_dir_relative" CHECK ("rootDir" IS NULL OR ("rootDir" NOT LIKE '/%' AND "rootDir" !~ '(^|/)\.\.(/|$)'));
