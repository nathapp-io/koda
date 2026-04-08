-- Add link type classification for TicketLink records
ALTER TABLE "TicketLink" ADD COLUMN "linkType" TEXT NOT NULL DEFAULT 'url';
