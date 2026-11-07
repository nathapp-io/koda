ALTER TABLE "FleetFlowFeature"
  ADD COLUMN "callsJobId" TEXT;

ALTER TABLE "FleetFlow"
  ADD COLUMN "ticketId" TEXT;

ALTER TABLE "FleetFlow"
  ADD CONSTRAINT "FleetFlow_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
