-- Fleet S5b knowledge index (1c-c-D3): per-repository index state and per-file state.

-- CreateTable
CREATE TABLE "KnowledgeRepoIndex" (
    "repoId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "indexedSha" TEXT,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "unembeddedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeRepoIndex_pkey" PRIMARY KEY ("repoId")
);

-- CreateTable
CREATE TABLE "KnowledgeRepoFile" (
    "repoId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "blobSha" TEXT NOT NULL,
    "chunkCount" INTEGER NOT NULL,
    "unembeddedCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeRepoFile_pkey" PRIMARY KEY ("repoId","path")
);

-- CreateIndex
CREATE INDEX "KnowledgeRepoIndex_projectId_idx" ON "KnowledgeRepoIndex"("projectId");

-- AddForeignKey
ALTER TABLE "KnowledgeRepoIndex" ADD CONSTRAINT "KnowledgeRepoIndex_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "FleetRepo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeRepoFile" ADD CONSTRAINT "KnowledgeRepoFile_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "FleetRepo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
