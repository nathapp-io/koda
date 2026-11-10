-- US-007 (#370): the per-repo rule override. One row per repo, holding the rule files and the
-- optional project context a repo's jobs run with instead of the ones in its checkout.
CREATE TABLE "FleetRepoRuleOverride" (
    "repoId" TEXT NOT NULL,
    "rules" JSONB NOT NULL,
    "rulesMode" TEXT NOT NULL,
    "contextContent" TEXT,
    "contextMode" TEXT,
    "ruleFiles" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "updatedByType" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FleetRepoRuleOverride_pkey" PRIMARY KEY ("repoId")
);

ALTER TABLE "FleetRepoRuleOverride" ADD CONSTRAINT "FleetRepoRuleOverride_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "FleetRepo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
