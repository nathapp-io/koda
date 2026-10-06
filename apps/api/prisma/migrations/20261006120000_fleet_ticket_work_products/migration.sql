-- Fleet C9 slice 1a: job <-> ticket links and fleet-sourced ticket links (spec §1, D448, D449).
CREATE TABLE "FleetJobTicket" (
    "jobId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "notifiedEpoch" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FleetJobTicket_pkey" PRIMARY KEY ("jobId","ticketId")
);
CREATE INDEX "FleetJobTicket_ticketId_idx" ON "FleetJobTicket"("ticketId");
ALTER TABLE "FleetJobTicket" ADD CONSTRAINT "FleetJobTicket_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FleetJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FleetJobTicket" ADD CONSTRAINT "FleetJobTicket_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TicketLink" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'vcs';
ALTER TABLE "TicketLink" ADD COLUMN "jobId" TEXT;
CREATE INDEX "TicketLink_jobId_idx" ON "TicketLink"("jobId");
ALTER TABLE "TicketLink" ADD CONSTRAINT "TicketLink_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FleetJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
