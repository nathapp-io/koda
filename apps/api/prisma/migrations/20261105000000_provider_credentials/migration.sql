-- Provider credential vault (spec §US-001). Additive: two new tables and their indexes.
-- Uniqueness is the computed "scopeKey" (`global`, `project:<id>`, `repo:<id>`) together with
-- "providerId": Postgres treats NULL columns as distinct, so a unique key over the nullable
-- projectId/repoId columns would accept duplicate GLOBAL rows.

CREATE TABLE "ProviderCredential" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "projectId" TEXT,
    "repoId" TEXT,
    "providerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderCredential_scopeKey_providerId_key" ON "ProviderCredential"("scopeKey", "providerId");
CREATE INDEX "ProviderCredential_projectId_idx" ON "ProviderCredential"("projectId");
CREATE INDEX "ProviderCredential_repoId_idx" ON "ProviderCredential"("repoId");

ALTER TABLE "ProviderCredential" ADD CONSTRAINT "ProviderCredential_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderCredential" ADD CONSTRAINT "ProviderCredential_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "FleetRepo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProviderCredentialIssue" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderCredentialIssue_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderCredentialIssue_jobId_credentialId_fingerprint_key" ON "ProviderCredentialIssue"("jobId", "credentialId", "fingerprint");
