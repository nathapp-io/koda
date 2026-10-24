CREATE TABLE "AuditEntry" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "projectId" TEXT,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "onBehalfOfType" TEXT,
    "onBehalfOfId" TEXT,
    "origin" TEXT NOT NULL,
    "requiredMode" TEXT NOT NULL,
    "satisfiedBy" TEXT NOT NULL,
    "approverType" TEXT,
    "approverId" TEXT,
    "approvalRequestId" TEXT,
    "correlationId" TEXT NOT NULL,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuditEntry_createdAt_idx" ON "AuditEntry"("createdAt");
CREATE INDEX "AuditEntry_projectId_createdAt_idx" ON "AuditEntry"("projectId", "createdAt");
CREATE INDEX "AuditEntry_actorId_createdAt_idx" ON "AuditEntry"("actorId", "createdAt");
CREATE INDEX "AuditEntry_actorType_idx" ON "AuditEntry"("actorType");
CREATE INDEX "AuditEntry_approverId_idx" ON "AuditEntry"("approverId");
CREATE INDEX "AuditEntry_key_idx" ON "AuditEntry"("key");
CREATE INDEX "AuditEntry_resourceType_resourceId_idx" ON "AuditEntry"("resourceType", "resourceId");
