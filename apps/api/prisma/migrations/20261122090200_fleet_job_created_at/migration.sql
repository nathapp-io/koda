-- queuedAt changes on requeue. Keep RUN creation order stable for PR rulings.
ALTER TABLE "FleetJob" ADD COLUMN "createdAt" TIMESTAMP(3);
UPDATE "FleetJob" SET "createdAt" = "queuedAt";
ALTER TABLE "FleetJob" ALTER COLUMN "createdAt" SET NOT NULL;
ALTER TABLE "FleetJob" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "FleetJob_repoId_command_createdAt_idx" ON "FleetJob"("repoId", "command", "createdAt");
