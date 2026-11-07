-- A link to a Vercel project that only reads it: the deployment mirror and logs, and nothing Dockify
-- sends to Vercel. An app already deploying to Vercel keeps doing so, hence the default.

-- AlterTable
ALTER TABLE "apps" ADD COLUMN     "vercelFollowOnly" BOOLEAN NOT NULL DEFAULT false;
