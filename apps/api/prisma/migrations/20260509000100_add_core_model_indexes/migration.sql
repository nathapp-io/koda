-- AddCoreModelIndexes
-- Adds missing indexes for ticketing and VCS sync hot-path queries.

BEGIN TRANSACTION;

CREATE INDEX IF NOT EXISTS "Ticket_projectId_status_idx" ON "Ticket"("projectId", "status");
CREATE INDEX IF NOT EXISTS "Ticket_projectId_assignedToUserId_idx" ON "Ticket"("projectId", "assignedToUserId");
CREATE INDEX IF NOT EXISTS "Ticket_projectId_assignedToAgentId_idx" ON "Ticket"("projectId", "assignedToAgentId");
CREATE INDEX IF NOT EXISTS "Ticket_externalVcsId_idx" ON "Ticket"("externalVcsId");

CREATE INDEX IF NOT EXISTS "Comment_ticketId_idx" ON "Comment"("ticketId");
CREATE INDEX IF NOT EXISTS "Comment_authorUserId_idx" ON "Comment"("authorUserId");

CREATE INDEX IF NOT EXISTS "TicketActivity_ticketId_idx" ON "TicketActivity"("ticketId");
CREATE INDEX IF NOT EXISTS "TicketActivity_ticketId_createdAt_idx" ON "TicketActivity"("ticketId", "createdAt");

CREATE INDEX IF NOT EXISTS "TicketLink_externalRef_idx" ON "TicketLink"("externalRef");

CREATE INDEX IF NOT EXISTS "VcsSyncLog_vcsConnectionId_startedAt_idx" ON "VcsSyncLog"("vcsConnectionId", "startedAt");

COMMIT;
