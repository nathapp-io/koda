-- AddWebhookDelivery
-- Replay protection for inbound webhooks (SEC-1).
-- Records every accepted webhook delivery so replayed payloads (same
-- project + source + delivery id) can be rejected permanently.
-- Rows are kept indefinitely: they are tiny and identical delivery ids
-- are never re-accepted.

BEGIN TRANSACTION;

-- CreateTable: WebhookDelivery
CREATE TABLE IF NOT EXISTS "WebhookDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookDelivery_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE
);

-- CreateIndex: @@unique([projectId, source, deliveryId])
CREATE UNIQUE INDEX IF NOT EXISTS "WebhookDelivery_projectId_source_deliveryId_key"
    ON "WebhookDelivery"("projectId", "source", "deliveryId");

-- CreateIndex: @@index([receivedAt])
CREATE INDEX IF NOT EXISTS "WebhookDelivery_receivedAt_idx"
    ON "WebhookDelivery"("receivedAt");

COMMIT;