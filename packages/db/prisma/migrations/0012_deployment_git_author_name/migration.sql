-- The commit's git name when its author has no GitHub account, so a deployment can name the person
-- behind a commit that no login stands for. gitAuthor keeps meaning a GitHub login. No data
-- statements: a deployment without an author keeps showing who started it.

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "gitAuthorName" TEXT;
