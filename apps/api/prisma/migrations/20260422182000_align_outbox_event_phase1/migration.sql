-- Align OutboxEvent schema to project-scoped Phase 1 contract.
-- This migration is additive/safe for environments that already applied
-- 20260422082729_add_outbox_event_model.

BEGIN TRANSACTION;
PRAGMA foreign_keys=OFF;

CREATE TABLE IF NOT EXISTS "OutboxEvent_unmapped" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "aggregateId" TEXT NOT NULL,
  "aggregateType" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "retryCount" INTEGER NOT NULL,
  "lastError" TEXT,
  "processedAt" DATETIME,
  "createdAt" DATETIME NOT NULL,
  "updatedAt" DATETIME NOT NULL,
  "migrationReason" TEXT NOT NULL
);

CREATE TABLE "new_OutboxEvent" (
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
    CONSTRAINT "OutboxEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Migrate rows that can be mapped to a valid project ID from payload.projectId.
-- For historical rows without a resolvable project, skip the row to preserve
-- relational integrity instead of inserting invalid foreign keys.
INSERT INTO "new_OutboxEvent" (
    "id",
    "projectId",
    "eventType",
    "eventId",
    "payload",
    "status",
    "attempts",
    "lastError",
    "processedAt",
    "createdAt",
    "updatedAt"
)
SELECT
    o."id",
    p."id" AS "projectId",
    o."eventType",
    o."aggregateId" AS "eventId",
    o."payload",
    CASE
      WHEN o."status" = 'failed' AND o."retryCount" >= 3 THEN 'dead_letter'
      WHEN o."status" = 'failed' THEN 'pending'
      ELSE o."status"
    END AS "status",
    o."retryCount" AS "attempts",
    o."lastError",
    o."processedAt",
    o."createdAt",
    o."updatedAt"
FROM "OutboxEvent" o
LEFT JOIN "Project" p
  ON p."id" = json_extract(o."payload", '$.projectId')
WHERE p."id" IS NOT NULL;

INSERT OR IGNORE INTO "OutboxEvent_unmapped" (
    "id",
    "aggregateId",
    "aggregateType",
    "eventType",
    "payload",
    "status",
    "retryCount",
    "lastError",
    "processedAt",
    "createdAt",
    "updatedAt",
    "migrationReason"
)
SELECT
    o."id",
    o."aggregateId",
    o."aggregateType",
    o."eventType",
    o."payload",
    o."status",
    o."retryCount",
    o."lastError",
    o."processedAt",
    o."createdAt",
    o."updatedAt",
    'Missing or invalid payload.projectId during OutboxEvent phase1 alignment'
FROM "OutboxEvent" o
LEFT JOIN "Project" p
  ON p."id" = json_extract(o."payload", '$.projectId')
WHERE p."id" IS NULL;

DROP TABLE "OutboxEvent";
ALTER TABLE "new_OutboxEvent" RENAME TO "OutboxEvent";

CREATE INDEX "OutboxEvent_status_createdAt_idx" ON "OutboxEvent"("status", "createdAt");
CREATE INDEX "OutboxEvent_projectId_createdAt_idx" ON "OutboxEvent"("projectId", "createdAt");

PRAGMA foreign_keys=ON;
COMMIT;
