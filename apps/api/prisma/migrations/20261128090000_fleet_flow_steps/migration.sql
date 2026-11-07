ALTER TABLE "FleetJob" ADD COLUMN "flowId" TEXT;
ALTER TABLE "FleetJob" ADD COLUMN "flowStep" TEXT;
ALTER TABLE "FleetFlow" ADD COLUMN "stopDetail" TEXT;
CREATE INDEX "FleetJob_flowId_queuedAt_idx" ON "FleetJob"("flowId", "queuedAt");
CREATE INDEX "FleetFlow_state_id_idx" ON "FleetFlow"("state", "id");
ALTER TABLE "FleetJob" ADD CONSTRAINT "FleetJob_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "FleetFlow"("id") ON DELETE SET NULL ON UPDATE CASCADE;
