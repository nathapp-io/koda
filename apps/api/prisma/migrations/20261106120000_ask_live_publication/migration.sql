-- Live delivery has its own marker: recording activity/webhooks does not acknowledge publication.
ALTER TABLE "FleetApprovalAsk" ADD COLUMN "publishedStatus" TEXT;

-- A bounded migration pass rotates failed attempts durably using the legacy row's updatedAt.
CREATE INDEX "FleetApproval_updatedAt_id_idx" ON "FleetApproval"("updatedAt", "id");
