-- Permissions P3 US-007 fix round 2 / US-009: the durable continuation of a policy close, and the idempotency key of
-- the fleet outputs a settled ask records.
ALTER TABLE "FleetApprovalAsk" ADD COLUMN "pendingResolvedBy" TEXT;
ALTER TABLE "FleetApprovalAsk" ADD COLUMN "recordedStatus" TEXT;
