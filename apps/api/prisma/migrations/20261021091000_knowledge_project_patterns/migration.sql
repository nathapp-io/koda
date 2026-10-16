-- Fleet S5b US-002 (3c-2-D2): a project's Markdown corpus patterns and the pass's patterns snapshot.

-- AlterTable
ALTER TABLE "KnowledgeRepoIndex" ADD COLUMN     "patternsKey" TEXT;

-- CreateTable
CREATE TABLE "KnowledgeProjectPatterns" (
    "projectId" TEXT NOT NULL,
    "patterns" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeProjectPatterns_pkey" PRIMARY KEY ("projectId")
);

-- AddForeignKey
ALTER TABLE "KnowledgeProjectPatterns" ADD CONSTRAINT "KnowledgeProjectPatterns_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
