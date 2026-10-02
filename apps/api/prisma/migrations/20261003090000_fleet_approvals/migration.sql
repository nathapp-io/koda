-- S1.5 slice 1a: typed approvals (C8). Bash columns are used from slice 2a.
-- CreateTable
CREATE TABLE "FleetApproval" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "projectId" TEXT,
    "jobId" TEXT,
    "leaseEpoch" INTEGER,
    "naxAskId" TEXT,
    "policyId" TEXT,
    "payload" JSONB NOT NULL,
    "outcome" JSONB,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "decision" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FleetApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FleetApproval_jobId_leaseEpoch_naxAskId_key" ON "FleetApproval"("jobId", "leaseEpoch", "naxAskId");

-- CreateIndex
CREATE INDEX "FleetApproval_projectId_status_requestedAt_idx" ON "FleetApproval"("projectId", "status", "requestedAt");

-- CreateIndex
CREATE INDEX "FleetApproval_status_expiresAt_idx" ON "FleetApproval"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "FleetApproval_jobId_status_idx" ON "FleetApproval"("jobId", "status");

-- CreateIndex
CREATE INDEX "FleetApproval_policyId_idx" ON "FleetApproval"("policyId");

-- S1.5 §1.1: one pending override per policy; prisma db push cannot express this.
CREATE UNIQUE INDEX IF NOT EXISTS "FleetApproval_pending_policy_key" ON "FleetApproval" ("policyId") WHERE "status" = 'pending';