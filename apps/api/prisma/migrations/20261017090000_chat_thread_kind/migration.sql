-- Fleet S5b US-002: the thread kind (REPO | PROJECT) and the nullable repo fields a PROJECT thread has none of.
-- Every existing row is a REPO thread, so the default backfills them; the partial unique index
-- ChatThread_active_repo_feature_key is unchanged and admits any number of null-repoId rows.
-- AlterTable
ALTER TABLE "ChatThread" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'REPO',
ALTER COLUMN "repoId" DROP NOT NULL,
ALTER COLUMN "baseRef" DROP NOT NULL,
ALTER COLUMN "feature" DROP NOT NULL,
ALTER COLUMN "specPath" DROP NOT NULL;
