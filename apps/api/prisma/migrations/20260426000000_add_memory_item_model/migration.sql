-- AddMemoryItem
-- Creates the MemoryItem table for semantic memory storage.
-- Supports one active memory per (projectId, kind, subject, predicate) key.
-- Active rows have non-null activeKey; superseded/rejected rows have activeKey = null.
-- Conflicts are resolved via application-level serializable transactions.

BEGIN TRANSACTION;

-- CreateTable: MemoryItem
CREATE TABLE IF NOT EXISTS "MemoryItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "predicate" TEXT NOT NULL,
    "object" TEXT,
    "confidence" REAL NOT NULL DEFAULT 0.8,
    "ttlAt" DATETIME,
    "ownerId" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "supersededBy" TEXT,
    "activeKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "MemoryItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE
);

-- CreateIndex: @@unique([projectId, activeKey])
-- SQLite allows multiple NULL values in unique indexes, so superseded/rejected
-- rows (activeKey = null) coexist while active rows remain unique per project.
CREATE UNIQUE INDEX IF NOT EXISTS "MemoryItem_projectId_activeKey_key"
    ON "MemoryItem"("projectId", "activeKey");

-- CreateIndex: @@index([projectId, kind])
CREATE INDEX IF NOT EXISTS "MemoryItem_projectId_kind_idx"
    ON "MemoryItem"("projectId", "kind");

-- CreateIndex: @@index([projectId, status])
CREATE INDEX IF NOT EXISTS "MemoryItem_projectId_status_idx"
    ON "MemoryItem"("projectId", "status");

-- CreateIndex: @@index([projectId, kind, subject, predicate])
CREATE INDEX IF NOT EXISTS "MemoryItem_projectId_kind_subject_predicate_idx"
    ON "MemoryItem"("projectId", "kind", "subject", "predicate");

-- CreateIndex: @@index([projectId, deletedAt])
CREATE INDEX IF NOT EXISTS "MemoryItem_projectId_deletedAt_idx"
    ON "MemoryItem"("projectId", "deletedAt");

-- CreateIndex: @@index([projectId, sourceType, sourceId])
CREATE INDEX IF NOT EXISTS "MemoryItem_projectId_sourceType_sourceId_idx"
    ON "MemoryItem"("projectId", "sourceType", "sourceId");

COMMIT;