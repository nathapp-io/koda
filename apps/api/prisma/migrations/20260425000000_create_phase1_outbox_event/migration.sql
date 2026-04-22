-- CreatePhase1OutboxEvent
-- Creates the canonical OutboxEvent table with all Phase 1 fields and indexes.
-- This migration is idempotent: it uses CREATE TABLE IF NOT EXISTS for the main table
-- and CREATE INDEX IF NOT EXISTS for indexes to allow safe re-application.

BEGIN TRANSACTION;

-- CreateTable: OutboxEvent with Phase 1 contract fields
CREATE TABLE IF NOT EXISTS "OutboxEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "processedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OutboxEvent_projectId_fkey"
        FOREIGN KEY ("projectId") REFERENCES "Project" ("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex: @@index([status, createdAt])
CREATE INDEX IF NOT EXISTS "OutboxEvent_status_createdAt_idx"
    ON "OutboxEvent"("status", "createdAt");

-- CreateIndex: @@index([projectId, createdAt])
CREATE INDEX IF NOT EXISTS "OutboxEvent_projectId_createdAt_idx"
    ON "OutboxEvent"("projectId", "createdAt");

COMMIT;