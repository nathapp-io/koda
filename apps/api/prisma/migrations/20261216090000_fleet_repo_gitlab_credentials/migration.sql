-- GitLab parity F1 (US-001): the per-repo GitLab connection.
--
-- `FleetRepo.host` names the forge host the repo lives on. GitHub rows keep the default
-- (`https://github.com`); the GitLab rows that exist today move to `https://gitlab.com`. The host
-- joins the repo's unique key, because the same owner and name can exist on two GitLab hosts.
--
-- The new `FleetRepoGitlabCredential` table holds one GitLab repo's two stored tokens (encrypted
-- under `VCS_ENCRYPTION_KEY`) and their health. No existing row gets a credential record: a GitLab
-- repo is "not connected" until an admin adds its tokens.

-- AlterTable
ALTER TABLE "FleetRepo" ADD COLUMN "host" TEXT NOT NULL DEFAULT 'https://github.com';

-- The GitLab rows move to their own host; the GitHub rows keep the default.
UPDATE "FleetRepo" SET "host" = 'https://gitlab.com' WHERE "provider" = 'gitlab';

-- The unique index now includes the host, so the same owner/name can exist on two GitLab hosts.
DROP INDEX "FleetRepo_provider_owner_name_key";
CREATE UNIQUE INDEX "FleetRepo_provider_host_owner_name_key" ON "FleetRepo"("provider", "host", "owner", "name");

-- CreateTable
CREATE TABLE "FleetRepoGitlabCredential" (
    "id" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "gitlabProjectId" INTEGER NOT NULL,
    "encryptedReadToken" TEXT NOT NULL,
    "encryptedWriteToken" TEXT NOT NULL,
    "readTokenUserId" INTEGER NOT NULL,
    "readTokenUsername" TEXT NOT NULL,
    "writeTokenUserId" INTEGER NOT NULL,
    "writeTokenUsername" TEXT NOT NULL,
    "writeTokenIsBot" BOOLEAN NOT NULL,
    "readTokenExpiresAt" TIMESTAMP(3),
    "writeTokenExpiresAt" TIMESTAMP(3),
    "readTokenInvalidAt" TIMESTAMP(3),
    "writeTokenInvalidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FleetRepoGitlabCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FleetRepoGitlabCredential_repoId_key" ON "FleetRepoGitlabCredential"("repoId");

-- AddForeignKey
ALTER TABLE "FleetRepoGitlabCredential" ADD CONSTRAINT "FleetRepoGitlabCredential_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "FleetRepo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
