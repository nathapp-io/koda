CREATE TABLE "ApprovalPolicy" (
    "id" TEXT NOT NULL,
    "selector" TEXT NOT NULL,
    "projectId" TEXT,
    "permissionPattern" TEXT NOT NULL,
    "principalType" TEXT,
    "roleId" TEXT,
    "principalId" TEXT,
    "mode" TEXT NOT NULL,
    "timeoutSec" INTEGER,
    "onTimeout" TEXT NOT NULL DEFAULT 'reject',
    "requiredApprovals" INTEGER NOT NULL DEFAULT 1,
    "approverMustHoldAction" BOOLEAN NOT NULL DEFAULT true,
    "requireDistinctApprover" BOOLEAN NOT NULL DEFAULT false,
    "updatedByType" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ApprovalPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "permissionKey" TEXT NOT NULL,
    "projectId" TEXT,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "onBehalfOfType" TEXT,
    "onBehalfOfId" TEXT,
    "origin" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "inputHash" TEXT NOT NULL,
    "requiredMode" TEXT NOT NULL,
    "policyId" TEXT,
    "onTimeout" TEXT NOT NULL,
    "approverMustHoldAction" BOOLEAN NOT NULL,
    "requireDistinctApprover" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "satisfiedBy" TEXT,
    "approverType" TEXT,
    "approverId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApprovalDecision" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "deciderType" TEXT NOT NULL,
    "deciderId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "comment" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApprovalDecision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApprovalPolicy_selector_key" ON "ApprovalPolicy"("selector");
CREATE INDEX "ApprovalPolicy_projectId_idx" ON "ApprovalPolicy"("projectId");
CREATE INDEX "ApprovalPolicy_roleId_idx" ON "ApprovalPolicy"("roleId");
CREATE INDEX "ApprovalRequest_status_expiresAt_idx" ON "ApprovalRequest"("status", "expiresAt");
CREATE INDEX "ApprovalRequest_projectId_status_createdAt_idx" ON "ApprovalRequest"("projectId", "status", "createdAt");
CREATE INDEX "ApprovalRequest_actorType_actorId_onBehalfOfId_permissionKe_idx" ON "ApprovalRequest"("actorType", "actorId", "onBehalfOfId", "permissionKey", "inputHash", "status");
CREATE INDEX "ApprovalDecision_requestId_idx" ON "ApprovalDecision"("requestId");
CREATE INDEX "ApprovalDecision_deciderId_decidedAt_idx" ON "ApprovalDecision"("deciderId", "decidedAt");

ALTER TABLE "ApprovalDecision" ADD CONSTRAINT "ApprovalDecision_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ApprovalRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
