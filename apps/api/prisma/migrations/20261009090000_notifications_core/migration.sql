-- Fleet S4a: notifications core (spec §1, D501, D502, D503).
-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "category" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "params" JSONB NOT NULL DEFAULT '{}',
    "link" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "actorId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketWatcher" (
    "ticketId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketWatcher_pkey" PRIMARY KEY ("ticketId","userId")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId","category","channel")
);

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_sourceType_sourceId_kind_key" ON "Notification"("userId", "sourceType", "sourceId", "kind");

-- CreateIndex
CREATE INDEX "TicketWatcher_userId_idx" ON "TicketWatcher"("userId");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketWatcher" ADD CONSTRAINT "TicketWatcher_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketWatcher" ADD CONSTRAINT "TicketWatcher_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- S4a backfill: watchers of live tickets. Reporter first, then user assignee, then distinct user commenters;
-- ON CONFLICT keeps the first reason. No statement may contain a literal semicolon (migration-schema.ts splits on it).
INSERT INTO "TicketWatcher" ("ticketId", "userId", "reason", "muted", "createdAt", "updatedAt")
SELECT t."id", t."createdByUserId", 'REPORTER', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Ticket" t
WHERE t."deletedAt" IS NULL AND t."createdByUserId" IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO "TicketWatcher" ("ticketId", "userId", "reason", "muted", "createdAt", "updatedAt")
SELECT t."id", t."assignedToUserId", 'ASSIGNEE', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Ticket" t
WHERE t."deletedAt" IS NULL AND t."assignedToUserId" IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO "TicketWatcher" ("ticketId", "userId", "reason", "muted", "createdAt", "updatedAt")
SELECT DISTINCT c."ticketId", c."authorUserId", 'COMMENTER', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Comment" c
JOIN "Ticket" t ON t."id" = c."ticketId"
WHERE t."deletedAt" IS NULL AND c."authorUserId" IS NOT NULL
ON CONFLICT DO NOTHING;
