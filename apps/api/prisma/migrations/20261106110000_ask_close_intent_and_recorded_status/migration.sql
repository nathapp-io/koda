-- Permissions P3 US-007 fix rounds 2-3 / US-009: the complete close a policy action intended for an ask it could not
-- settle (drained later by the continuation), and the idempotency key of the fleet outputs a settled ask records.
ALTER TABLE "FleetApprovalAsk" ADD COLUMN "pendingClose" JSONB;
ALTER TABLE "FleetApprovalAsk" ADD COLUMN "recordedStatus" TEXT;
