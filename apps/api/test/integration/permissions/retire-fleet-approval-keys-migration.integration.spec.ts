/**
 * Permissions P3 feature 7c (US-013) — the data migration that retires the fleet approval keys.
 *
 * The test builds a throwaway schema holding every migration before
 * `20261111090000_retire_fleet_approval_keys`, writes the rows an installation can hold *before* that
 * migration (roles naming the four retired keys in every form the entry grammar allows, a policy per
 * pattern shape, requests in several statuses, notifications pointing at the deleted redirect page),
 * reads them back, then applies the migration itself and reads the same rows again.
 *
 * Run: cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bun run test:scoped \
 *   test/integration/permissions/retire-fleet-approval-keys-migration.integration.spec.ts
 */
import { canRunDbTests } from '../../helpers/test-environment';
import { applyMigration, scratchSchemaBefore, type ScratchSchema } from '../../helpers/migration-schema';

const integration = canRunDbTests() ? describe : describe.skip;
const MIGRATION = '20261111090000_retire_fleet_approval_keys';
const SCHEMA = 'retire_fleet_approval_keys_mig';

/** AC-1's six entries: two survive, four name a retired key in a different form. */
const MIXED_PERMISSIONS = [
  '*.read',
  'fleet.approval.decide.bash',
  '!fleet.approval.read',
  'fleet.approval.*',
  'approval.decide@fleet.approval.decide.bash',
  'label.create',
];
/** AC-2: every entry goes, so the role must store `[]` and never NULL. */
const ONLY_FLEET_PERMISSIONS = ['fleet.approval.read', 'fleet.approval.decide.bash'];
/** A role naming no retired key keeps its list, and its order, untouched. */
const CLEAN_PERMISSIONS = ['*.read', 'label.create', '!project.ci-token.read'];

/** The rows the migration rewrites, read as the columns the criteria name. */
interface Snapshot {
  roles: Record<string, string[]>;
  policies: string[];
  requests: Record<string, { status: string; settledAt: Date | null }>;
  links: Record<string, string>;
}

integration('Retire fleet approval keys migration', () => {
  let scratch: ScratchSchema;
  /**
   * The same rows before the migration ran. AC-1..AC-6 assert the state *after* it; this is what proves
   * the fixture really held the pre-migration values (a schema that never stored them would satisfy the
   * "gone" half of every criterion by accident).
   */
  let before: Snapshot;

  const readSnapshot = async (): Promise<Snapshot> => {
    const roleRows = await scratch.db.$queryRawUnsafe<Array<{ key: string; permissions: string[] }>>(
      `SELECT "key", "permissions" FROM "Role" ORDER BY "key"`,
    );
    const policyRows = await scratch.db.$queryRawUnsafe<Array<{ permissionPattern: string }>>(
      `SELECT "permissionPattern" FROM "ApprovalPolicy" ORDER BY "id"`,
    );
    const requestRows = await scratch.db.$queryRawUnsafe<
      Array<{ id: string; status: string; settledAt: Date | null }>
    >(`SELECT "id", "status", "settledAt" FROM "ApprovalRequest" ORDER BY "id"`);
    const linkRows = await scratch.db.$queryRawUnsafe<Array<{ id: string; link: string }>>(
      `SELECT "id", "link" FROM "Notification" ORDER BY "id"`,
    );

    return {
      roles: Object.fromEntries(roleRows.map((row) => [row.key, row.permissions])),
      policies: policyRows.map((row) => row.permissionPattern),
      requests: Object.fromEntries(
        requestRows.map((row) => [row.id, { status: row.status, settledAt: row.settledAt }]),
      ),
      links: Object.fromEntries(linkRows.map((row) => [row.id, row.link])),
    };
  };

  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, SCHEMA, MIGRATION);

    await scratch.db.$executeRawUnsafe(
      `INSERT INTO "Role" ("id", "key", "name", "scope", "permissions", "updatedAt") VALUES
       ('role-mixed', 'role-mixed', 'Mixed', 'PROJECT', $1::jsonb, now()),
       ('role-only-fleet', 'role-only-fleet', 'Only fleet', 'PROJECT', $2::jsonb, now()),
       ('role-clean', 'role-clean', 'Clean', 'PROJECT', $3::jsonb, now())`,
      JSON.stringify(MIXED_PERMISSIONS),
      JSON.stringify(ONLY_FLEET_PERMISSIONS),
      JSON.stringify(CLEAN_PERMISSIONS),
    );

    // One policy per form the retired keys took as a pattern: an exact key and the `.*` prefix.
    await scratch.db.$executeRawUnsafe(
      `INSERT INTO "ApprovalPolicy" ("id", "selector", "permissionPattern", "mode", "updatedByType", "updatedById", "updatedAt") VALUES
       ('policy-exact', 'policy-exact', 'fleet.approval.decide.bash', 'agent', 'USER', 'tester', now()),
       ('policy-prefix', 'policy-prefix', 'fleet.approval.*', 'human', 'USER', 'tester', now()),
       ('policy-label', 'policy-label', 'label.create', 'agent', 'USER', 'tester', now())`,
    );

    await scratch.db.$executeRawUnsafe(
      `INSERT INTO "ApprovalRequest" (
         "id", "permissionKey", "actorType", "actorId", "origin", "correlationId", "input", "inputHash",
         "requiredMode", "onTimeout", "approverMustHoldAction", "requireDistinctApprover", "expiresAt",
         "status", "updatedAt"
       ) VALUES
       ('req-pending-budget', 'fleet.approval.decide.budget', 'USER', 'user-1', 'rest', 'corr-1', '{}'::jsonb, 'hash-1', 'agent', 'reject', true, false, now() + interval '1 hour', 'pending', now()),
       ('req-approved-bash', 'fleet.approval.decide.bash', 'USER', 'user-1', 'rest', 'corr-2', '{}'::jsonb, 'hash-2', 'agent', 'reject', true, false, now() + interval '1 hour', 'approved', now()),
       ('req-executed-bash', 'fleet.approval.decide.bash', 'USER', 'user-1', 'rest', 'corr-3', '{}'::jsonb, 'hash-3', 'agent', 'reject', true, false, now() + interval '1 hour', 'executed', now()),
       ('req-live-escalate', 'fleet.job.shell.escalate', 'USER', 'user-1', 'rest', 'corr-4', '{}'::jsonb, 'hash-4', 'agent', 'reject', true, false, now() + interval '1 hour', 'pending', now())`,
    );

    await scratch.db.$executeRawUnsafe(
      `INSERT INTO "User" ("id", "email", "name", "passwordHash", "updatedAt")
       VALUES ('user-notify', 'notify@koda.test', 'Notify', 'x', now())`,
    );
    await scratch.db.$executeRawUnsafe(
      `INSERT INTO "Notification" ("id", "userId", "category", "kind", "title", "link", "sourceType", "sourceId") VALUES
       ('notif-approvals', 'user-notify', 'FLEET_NEEDS_YOU', 'approval_requested', 'Approval', '/admin/fleet/approvals', 'fleet_approval', 'source-1'),
       ('notif-budgets', 'user-notify', 'FLEET_NEEDS_YOU', 'budget_threshold', 'Budget', '/admin/fleet/budgets', 'fleet_budget_incident', 'source-2')`,
    );

    before = await readSnapshot();
    await applyMigration(scratch.db, MIGRATION);
  }, 180_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  it('seeds the pre-migration rows the criteria are stated against', () => {
    expect(before).toEqual({
      roles: {
        'role-clean': CLEAN_PERMISSIONS,
        'role-mixed': MIXED_PERMISSIONS,
        'role-only-fleet': ONLY_FLEET_PERMISSIONS,
      },
      policies: ['fleet.approval.decide.bash', 'label.create', 'fleet.approval.*'],
      requests: {
        'req-approved-bash': { status: 'approved', settledAt: null },
        'req-executed-bash': { status: 'executed', settledAt: null },
        'req-live-escalate': { status: 'pending', settledAt: null },
        'req-pending-budget': { status: 'pending', settledAt: null },
      },
      links: {
        'notif-approvals': '/admin/fleet/approvals',
        'notif-budgets': '/admin/fleet/budgets',
      },
    });
  });

  it('AC-1: strips every entry naming a retired key and keeps the survivors in their stored order', async () => {
    const after = await readSnapshot();

    expect(after.roles['role-mixed']).toEqual(['*.read', 'label.create']);
  });

  it('AC-1: leaves a role that names no retired key untouched', async () => {
    const after = await readSnapshot();

    expect(after.roles['role-clean']).toEqual(CLEAN_PERMISSIONS);
  });

  it('AC-2: stores an empty list, never NULL, when every entry names a retired key', async () => {
    const after = await readSnapshot();

    expect(after.roles['role-only-fleet']).toEqual([]);
  });

  it('AC-3: deletes the policies selecting a retired key and keeps the others', async () => {
    const after = await readSnapshot();

    expect(after.policies).toEqual(['label.create']);
  });

  it('AC-4: settles a retired key’s pending and approved requests as cancelled', async () => {
    const after = await readSnapshot();

    expect(after.requests['req-pending-budget']?.status).toBe('cancelled');
    expect(after.requests['req-pending-budget']?.settledAt).toBeInstanceOf(Date);
    expect(after.requests['req-approved-bash']?.status).toBe('cancelled');
    expect(after.requests['req-approved-bash']?.settledAt).toBeInstanceOf(Date);
  });

  it('AC-5: keeps a request that already left pending/approved in its own status', async () => {
    const after = await readSnapshot();

    expect(after.requests['req-executed-bash']).toEqual({ status: 'executed', settledAt: null });
    // The surviving key's ask is untouched too: only `fleet.approval.` retires.
    expect(after.requests['req-live-escalate']).toEqual({ status: 'pending', settledAt: null });
  });

  it('AC-6: re-points the deleted approvals page link and leaves every other link alone', async () => {
    const after = await readSnapshot();

    expect(after.links['notif-approvals']).toBe('/approvals');
    expect(after.links['notif-budgets']).toBe('/admin/fleet/budgets');
  });
});
