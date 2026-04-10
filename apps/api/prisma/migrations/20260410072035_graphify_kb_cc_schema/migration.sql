-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "gitRemoteUrl" TEXT,
    "autoIndexOnClose" BOOLEAN NOT NULL DEFAULT true,
    "autoAssign" TEXT NOT NULL DEFAULT 'OFF',
    "graphifyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "graphifyLastImportedAt" DATETIME,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "ciWebhookToken" TEXT
);
INSERT INTO "new_Project" ("autoAssign", "autoIndexOnClose", "ciWebhookToken", "createdAt", "deletedAt", "description", "gitRemoteUrl", "id", "key", "name", "slug", "updatedAt") SELECT "autoAssign", "autoIndexOnClose", "ciWebhookToken", "createdAt", "deletedAt", "description", "gitRemoteUrl", "id", "key", "name", "slug", "updatedAt" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");
CREATE UNIQUE INDEX "Project_key_key" ON "Project"("key");
CREATE TABLE "new_VcsConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "repoOwner" TEXT NOT NULL,
    "repoName" TEXT NOT NULL,
    "encryptedToken" TEXT NOT NULL,
    "syncMode" TEXT NOT NULL DEFAULT 'off',
    "allowedAuthors" TEXT NOT NULL DEFAULT '[]',
    "pollingIntervalMs" INTEGER NOT NULL DEFAULT 600000,
    "webhookSecret" TEXT,
    "lastSyncedAt" DATETIME,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VcsConnection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_VcsConnection" ("allowedAuthors", "createdAt", "encryptedToken", "id", "isActive", "lastSyncedAt", "pollingIntervalMs", "projectId", "provider", "repoName", "repoOwner", "syncMode", "updatedAt", "webhookSecret") SELECT "allowedAuthors", "createdAt", "encryptedToken", "id", "isActive", "lastSyncedAt", "pollingIntervalMs", "projectId", "provider", "repoName", "repoOwner", "syncMode", "updatedAt", "webhookSecret" FROM "VcsConnection";
DROP TABLE "VcsConnection";
ALTER TABLE "new_VcsConnection" RENAME TO "VcsConnection";
CREATE UNIQUE INDEX "VcsConnection_projectId_key" ON "VcsConnection"("projectId");
CREATE TABLE "new_VcsSyncLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vcsConnectionId" TEXT NOT NULL,
    "syncType" TEXT NOT NULL,
    "issuesSynced" INTEGER NOT NULL DEFAULT 0,
    "issuesSkipped" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "VcsSyncLog_vcsConnectionId_fkey" FOREIGN KEY ("vcsConnectionId") REFERENCES "VcsConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_VcsSyncLog" ("completedAt", "errorMessage", "id", "issuesSkipped", "issuesSynced", "startedAt", "syncType", "vcsConnectionId") SELECT "completedAt", "errorMessage", "id", "issuesSkipped", "issuesSynced", "startedAt", "syncType", "vcsConnectionId" FROM "VcsSyncLog";
DROP TABLE "VcsSyncLog";
ALTER TABLE "new_VcsSyncLog" RENAME TO "VcsSyncLog";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
