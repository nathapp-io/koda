ALTER TABLE "ChatThread" ADD COLUMN "preApproval" JSONB;

CREATE TABLE "FleetFlow" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "threadId" TEXT,
    "entry" TEXT NOT NULL,
    "createdByType" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "specSha" TEXT NOT NULL,
    "pinnedRunnerId" TEXT,
    "reviewerRole" TEXT NOT NULL,
    "supervisorRole" TEXT NOT NULL,
    "costCapUsd" DECIMAL(12,4) NOT NULL,
    "spentUsd" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "approvalMode" TEXT,
    "approverId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvalRequestId" TEXT,
    "stopReason" TEXT,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FleetFlow_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FleetFlowFeature" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "feature" TEXT NOT NULL,
    "specPath" TEXT NOT NULL,
    "dependsOn" TEXT[] NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "currentStep" TEXT,
    "prNumber" INTEGER,
    CONSTRAINT "FleetFlowFeature_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FleetFlow_projectId_createdAt_idx" ON "FleetFlow"("projectId", "createdAt");
CREATE INDEX "FleetFlow_threadId_state_idx" ON "FleetFlow"("threadId", "state");
CREATE INDEX "FleetFlow_repoId_branch_specSha_idx" ON "FleetFlow"("repoId", "branch", "specSha");
CREATE INDEX "FleetFlow_approvalRequestId_idx" ON "FleetFlow"("approvalRequestId");
CREATE UNIQUE INDEX "FleetFlowFeature_flowId_position_key" ON "FleetFlowFeature"("flowId", "position");
CREATE UNIQUE INDEX "FleetFlowFeature_flowId_feature_key" ON "FleetFlowFeature"("flowId", "feature");

ALTER TABLE "FleetFlow" ADD CONSTRAINT "FleetFlow_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FleetFlow" ADD CONSTRAINT "FleetFlow_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "FleetRepo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FleetFlowFeature" ADD CONSTRAINT "FleetFlowFeature_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "FleetFlow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
