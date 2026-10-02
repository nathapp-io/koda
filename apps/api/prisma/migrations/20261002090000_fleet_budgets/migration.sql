-- S1b slice 2a: budget policies and incidents; carried spend, first start and cancel reason on FleetJob.
-- AlterTable
ALTER TABLE "FleetJob" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "costCarriedUsd" DECIMAL(12,4) NOT NULL DEFAULT 0,
ADD COLUMN     "firstStartedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "BudgetPolicy" (
    "id" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "projectId" TEXT,
    "windowKind" TEXT NOT NULL,
    "amountUsd" DECIMAL(12,4) NOT NULL,
    "warnPercent" INTEGER,
    "hardStop" BOOLEAN NOT NULL DEFAULT true,
    "runningJobs" TEXT NOT NULL DEFAULT 'finish',
    "pausedAt" TIMESTAMP(3),
    "pausedWindowStart" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BudgetPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetIncident" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "spentUsd" DECIMAL(12,4) NOT NULL,
    "amountUsd" DECIMAL(12,4) NOT NULL,
    "actorId" TEXT,
    "approvalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BudgetIncident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BudgetPolicy_projectId_idx" ON "BudgetPolicy"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetPolicy_scopeKey_windowKind_key" ON "BudgetPolicy"("scopeKey", "windowKind");

-- CreateIndex
CREATE INDEX "BudgetIncident_policyId_createdAt_idx" ON "BudgetIncident"("policyId", "createdAt");

-- CreateIndex
CREATE INDEX "FleetJob_projectId_firstStartedAt_idx" ON "FleetJob"("projectId", "firstStartedAt");

-- CreateIndex
CREATE INDEX "FleetJob_repoId_firstStartedAt_idx" ON "FleetJob"("repoId", "firstStartedAt");

-- CreateIndex
CREATE INDEX "FleetJob_runnerId_firstStartedAt_idx" ON "FleetJob"("runnerId", "firstStartedAt");

-- AddForeignKey
ALTER TABLE "BudgetIncident" ADD CONSTRAINT "BudgetIncident_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "BudgetPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Plan D167: a job that already ran counts in the window it last started in (the first start was never recorded).
UPDATE "FleetJob" SET "firstStartedAt" = "startedAt" WHERE "startedAt" IS NOT NULL;

-- S1b §2.1: one warn and one hard_stop per (policy, window, amount); prisma db push cannot express this.
CREATE UNIQUE INDEX IF NOT EXISTS "BudgetIncident_threshold_key" ON "BudgetIncident" ("policyId", "kind", "windowStart", "amountUsd") WHERE "kind" IN ('warn', 'hard_stop');
