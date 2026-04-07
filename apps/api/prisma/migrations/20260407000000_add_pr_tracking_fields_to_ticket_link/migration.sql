-- Add PR tracking fields to TicketLink
ALTER TABLE "TicketLink" ADD COLUMN "prState" TEXT DEFAULT 'draft';
ALTER TABLE "TicketLink" ADD COLUMN "prNumber" INTEGER;
ALTER TABLE "TicketLink" ADD COLUMN "prUpdatedAt" DATETIME;
