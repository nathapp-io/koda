-- Permissions P3 approval + fleet core (US-002, US-003, US-009): each statement touches a different
-- table, so they land in whatever order the stories do.

UPDATE "Role"
SET "permissions" = "permissions" || '["approval.decide@fleet.job.shell.escalate"]'::jsonb, "updatedAt" = NOW()
WHERE "key" = 'developer'
  AND "permissions" @> '["fleet.approval.decide.bash"]'::jsonb
  AND NOT "permissions" @> '["approval.decide@fleet.job.shell.escalate"]'::jsonb;

ALTER TABLE "ApprovalDecision" ADD COLUMN "params" JSONB;

-- US-009: the fleet's link row for one ask on the approval engine. Postgres treats NULLs as distinct, so
-- the unique index de-duplicates only bash links (all three columns set); budget links have null job
-- columns and are never de-duplicated by it.
CREATE TABLE "FleetApprovalAsk" (
    "requestId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "projectId" TEXT,
    "jobId" TEXT,
    "leaseEpoch" INTEGER,
    "naxAskId" TEXT,
    "budgetPolicyId" TEXT,
    "resolvedBy" TEXT,
    "outcome" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FleetApprovalAsk_pkey" PRIMARY KEY ("requestId")
);

CREATE UNIQUE INDEX "FleetApprovalAsk_jobId_leaseEpoch_naxAskId_key" ON "FleetApprovalAsk"("jobId", "leaseEpoch", "naxAskId");
CREATE INDEX "FleetApprovalAsk_jobId_idx" ON "FleetApprovalAsk"("jobId");
CREATE INDEX "FleetApprovalAsk_budgetPolicyId_idx" ON "FleetApprovalAsk"("budgetPolicyId");

ALTER TABLE "FleetApprovalAsk" ADD CONSTRAINT "FleetApprovalAsk_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ApprovalRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
