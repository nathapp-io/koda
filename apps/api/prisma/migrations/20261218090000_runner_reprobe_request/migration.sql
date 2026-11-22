-- US-005 (ACP probe): an operator's re-probe request. Written by POST /fleet/runners/:id/reprobe,
-- cleared atomically by the sync that delivers it. Nullable, so every existing runner keeps working.
ALTER TABLE "Runner" ADD COLUMN "reprobeRequestedAt" TIMESTAMP(3);
