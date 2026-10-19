-- Permissions P1 US-006: record who added a ticket link, so `ticket.link.remove.own` can compare it.
--
-- Both columns are nullable with no foreign key and no index: the value is compared, never joined
-- (like `JobSchedule.repoId`), and every existing row keeps null. A row with a null creator — every
-- link that predates this migration, and every link the assistant tool, the VCS writer and the fleet
-- writer create — can be removed only by a principal holding the full `ticket.link.remove` key.
ALTER TABLE "TicketLink" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "TicketLink" ADD COLUMN "createdByAgentId" TEXT;
