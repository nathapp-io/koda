-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN "externalVcsId" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "externalVcsUrl" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "vcsSyncedAt" DATETIME;

-- CreateTable
CREATE TABLE "VcsConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "repoOwner" TEXT NOT NULL,
    "repoName" TEXT NOT NULL,
    "encryptedToken" TEXT NOT NULL,
    "syncMode" TEXT NOT NULL,
    "allowedAuthors" TEXT NOT NULL,
    "pollingIntervalMs" INTEGER NOT NULL,
    "webhookSecret" TEXT,
    "lastSyncedAt" DATETIME,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VcsConnection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VcsSyncLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vcsConnectionId" TEXT NOT NULL,
    "syncType" TEXT NOT NULL,
    "issuesSynced" INTEGER NOT NULL DEFAULT 0,
    "issuesSkipped" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    CONSTRAINT "VcsSyncLog_vcsConnectionId_fkey" FOREIGN KEY ("vcsConnectionId") REFERENCES "VcsConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "VcsConnection_projectId_key" ON "VcsConnection"("projectId");
