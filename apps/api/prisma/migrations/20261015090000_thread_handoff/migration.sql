-- Fleet S5a US-001: the thread write-path columns (Publish, Discard and the last write result).

-- AlterTable
ALTER TABLE "ChatThread" ADD COLUMN "writtenPaths" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "ChatThread" ADD COLUMN "publishedSha" TEXT;

-- AlterTable
ALTER TABLE "ChatThread" ADD COLUMN "specPublished" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ChatThread" ADD COLUMN "lastWrite" JSONB;
