-- Fleet PR-fix US-004: the FIX outcome the runner's snapshot reported (pushed | nothing). Nullable and additive:
-- every existing job — and every non-FIX job — keeps NULL, and a requeue clears it with the other result columns.
ALTER TABLE "FleetJob" ADD COLUMN "fixOutcome" TEXT;
