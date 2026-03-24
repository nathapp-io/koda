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
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Project" ("autoIndexOnClose", "createdAt", "deletedAt", "description", "gitRemoteUrl", "id", "key", "name", "slug", "updatedAt") SELECT "autoIndexOnClose", "createdAt", "deletedAt", "description", "gitRemoteUrl", "id", "key", "name", "slug", "updatedAt" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");
CREATE UNIQUE INDEX "Project_key_key" ON "Project"("key");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
