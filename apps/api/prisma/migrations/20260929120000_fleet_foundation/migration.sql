-- Fleet S1 slice 1: runner, enrollment, fleet repo and activity tables.

-- CreateTable
CREATE TABLE "Runner" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "apiKeyHash" TEXT NOT NULL,
    "os" TEXT NOT NULL,
    "arch" TEXT NOT NULL,
    "labels" TEXT[],
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "capabilities" JSONB NOT NULL,
    "daemonVersion" TEXT NOT NULL,
    "protocolVersion" INTEGER NOT NULL,
    "bootId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Runner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunnerEnrollment" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "labels" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "runnerId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunnerEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FleetRepo" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "githubInstallationId" BIGINT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FleetRepo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FleetActivity" (
    "id" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "jobId" TEXT,
    "responsibleUserId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FleetActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Runner_name_key" ON "Runner"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Runner_apiKeyHash_key" ON "Runner"("apiKeyHash");

-- CreateIndex
CREATE UNIQUE INDEX "RunnerEnrollment_tokenHash_key" ON "RunnerEnrollment"("tokenHash");

-- CreateIndex
CREATE INDEX "RunnerEnrollment_createdAt_idx" ON "RunnerEnrollment"("createdAt");

-- CreateIndex
CREATE INDEX "FleetRepo_projectId_idx" ON "FleetRepo"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "FleetRepo_provider_owner_name_key" ON "FleetRepo"("provider", "owner", "name");

-- CreateIndex
CREATE INDEX "FleetActivity_entityType_entityId_idx" ON "FleetActivity"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "FleetActivity_jobId_idx" ON "FleetActivity"("jobId");

-- CreateIndex
CREATE INDEX "FleetActivity_createdAt_idx" ON "FleetActivity"("createdAt");

-- AddForeignKey
ALTER TABLE "FleetRepo" ADD CONSTRAINT "FleetRepo_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

