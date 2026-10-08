/**
 * Partial unique indexes that `prisma db push` cannot create. Each statement is shipped
 * verbatim by a migration (pinned by test/unit/fleet/partial-indexes.spec.ts) and replayed
 * by test/global-setup.ts after the push.
 */
export const PARTIAL_UNIQUE_INDEXES: readonly string[] = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "FleetJob_active_repo_feature_key" ON "FleetJob" ("repoId", "feature") WHERE "state" IN ('QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "BudgetIncident_threshold_key" ON "BudgetIncident" ("policyId", "kind", "windowStart", "amountUsd") WHERE "kind" IN ('warn', 'hard_stop')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "FleetJob_schedule_queued_key" ON "FleetJob" ("scheduleId") WHERE "state" = 'QUEUED'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "FleetApproval_pending_policy_key" ON "FleetApproval" ("policyId") WHERE "status" = 'pending'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "FleetHealthAlert_open_subject_key" ON "FleetHealthAlert" ("kind", "subjectKey") WHERE "closedAt" IS NULL`,
];
