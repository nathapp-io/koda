-- AddMemoryQueryMetric
-- Creates the MemoryQueryMetric table for SLO dashboard metrics.
-- Stores per-query latency, staleness, provenance, and leakage data.
-- Indexed by (projectId, createdAt) for efficient time-window queries.

BEGIN TRANSACTION;

-- CreateTable: MemoryQueryMetric
CREATE TABLE IF NOT EXISTS "MemoryQueryMetric" (
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
    CONSTRAINT "MemoryQueryMetric_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE
);

-- CreateIndex: projectId + createdAt (for SLO dashboard time-window queries)
CREATE INDEX IF NOT EXISTS "MemoryQueryMetric_projectId_createdAt_idx" ON "MemoryQueryMetric"("projectId", "createdAt");

-- CreateIndex: createdAt (for time-series scans)
CREATE INDEX IF NOT EXISTS "MemoryQueryMetric_createdAt_idx" ON "MemoryQueryMetric"("createdAt");

COMMIT;
