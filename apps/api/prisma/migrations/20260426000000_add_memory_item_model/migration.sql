-- AddMemoryItem
-- Creates the MemoryItem table for semantic memory storage.
-- Supports one active memory per (projectId, kind, subject, predicate) key.
-- Active rows have non-null activeKey; superseded/rejected rows have activeKey = null.

BEGIN TRANSACTION;

-- CreateTable: MemoryItem
CREATE TABLE IF NOT EXISTS "MemoryItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "predicate" TEXT NOT NULL,
    "object" TEXT,
    "activeKey" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "status" TEXT,
    "confidence" REAL,
    "ttlAt" DATETIME,
    "supersededBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "MemoryItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE
);

-- CreateIndex: @@unique([projectId, kind, subject, predicate, activeKey])
-- Note: SQLite allows multiple NULL values in unique indexes. AC-2 enforcement
-- (one active row per composite key) is guaranteed application-level via
-- $transaction with Serializable isolation in MemoryItemRepository.upsert().
CREATE UNIQUE INDEX IF NOT EXISTS "MemoryItem_projectId_kind_subject_predicate_activeKey_idx"
    ON "MemoryItem"("projectId", "kind", "subject", "predicate", "activeKey");

-- CreateIndex: @@index([projectId, kind, subject, predicate])
CREATE INDEX IF NOT EXISTS "MemoryItem_projectId_kind_subject_predicate_idx"
    ON "MemoryItem"("projectId", "kind", "subject", "predicate");

-- CreateIndex: @@index([projectId, activeKey])
CREATE INDEX IF NOT EXISTS "MemoryItem_projectId_activeKey_idx"
    ON "MemoryItem"("projectId", "activeKey");

-- CreateIndex: @@index([projectId, deletedAt])
CREATE INDEX IF NOT EXISTS "MemoryItem_projectId_deletedAt_idx"
    ON "MemoryItem"("projectId", "deletedAt");

-- CreateIndex: @@index([projectId, sourceType, sourceId])
CREATE INDEX IF NOT EXISTS "MemoryItem_projectId_sourceType_sourceId_idx"
    ON "MemoryItem"("projectId", "sourceType", "sourceId");

COMMIT;
