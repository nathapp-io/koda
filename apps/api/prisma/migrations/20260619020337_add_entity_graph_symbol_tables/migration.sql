-- CreateTable
CREATE TABLE "EntityNode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EntityNode_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EntityLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EntityLink_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Symbol" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbolId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "commitHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "file" TEXT NOT NULL,
    "startLine" INTEGER NOT NULL,
    "endLine" INTEGER NOT NULL,
    "signature" TEXT,
    "callers" JSONB NOT NULL DEFAULT [],
    "callees" JSONB NOT NULL DEFAULT [],
    "docComment" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Symbol_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_MemoryQueryMetric" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "tokensUsed" INTEGER,
    "hadProvenance" BOOLEAN NOT NULL,
    "staleHitCount" INTEGER NOT NULL DEFAULT 0,
    "resultCount" INTEGER NOT NULL DEFAULT 0,
    "docId" TEXT,
    "leakageIncidentCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MemoryQueryMetric_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_MemoryQueryMetric" ("createdAt", "docId", "hadProvenance", "id", "intent", "latencyMs", "leakageIncidentCount", "projectId", "resultCount", "staleHitCount", "tokensUsed") SELECT "createdAt", "docId", "hadProvenance", "id", "intent", "latencyMs", "leakageIncidentCount", "projectId", "resultCount", "staleHitCount", "tokensUsed" FROM "MemoryQueryMetric";
DROP TABLE "MemoryQueryMetric";
ALTER TABLE "new_MemoryQueryMetric" RENAME TO "MemoryQueryMetric";
CREATE INDEX "MemoryQueryMetric_projectId_createdAt_idx" ON "MemoryQueryMetric"("projectId", "createdAt");
CREATE INDEX "MemoryQueryMetric_createdAt_idx" ON "MemoryQueryMetric"("createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "EntityNode_projectId_entityType_idx" ON "EntityNode"("projectId", "entityType");

-- CreateIndex
CREATE UNIQUE INDEX "EntityNode_projectId_entityId_key" ON "EntityNode"("projectId", "entityId");

-- CreateIndex
CREATE INDEX "EntityLink_projectId_sourceId_idx" ON "EntityLink"("projectId", "sourceId");

-- CreateIndex
CREATE INDEX "EntityLink_projectId_targetId_idx" ON "EntityLink"("projectId", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "EntityLink_projectId_sourceId_targetId_relation_key" ON "EntityLink"("projectId", "sourceId", "targetId", "relation");

-- CreateIndex
CREATE INDEX "Symbol_projectId_idx" ON "Symbol"("projectId");

-- CreateIndex
CREATE INDEX "Symbol_projectId_symbolId_idx" ON "Symbol"("projectId", "symbolId");

-- CreateIndex
CREATE INDEX "Symbol_projectId_file_idx" ON "Symbol"("projectId", "file");

-- CreateIndex
CREATE UNIQUE INDEX "Symbol_projectId_symbolId_key" ON "Symbol"("projectId", "symbolId");
