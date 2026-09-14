-- AddDeletedAtIndexes
-- BUG-3: soft-delete aware listings filter `deletedAt IS NULL`; with ~99% of
-- rows live, an index lets SQLite scan only matching rows. Composite indexes
-- would be better for scoped queries; the single-column index covers the
-- global listings that scan the whole table.

BEGIN TRANSACTION;

-- CreateIndex: @@index([deletedAt]) on Project
CREATE INDEX IF NOT EXISTS "Project_deletedAt_idx" ON "Project"("deletedAt");

-- CreateIndex: @@index([deletedAt]) on Ticket
CREATE INDEX IF NOT EXISTS "Ticket_deletedAt_idx" ON "Ticket"("deletedAt");

COMMIT;