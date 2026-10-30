import { canRunDbTests } from '../../helpers/test-environment';
import { migrationStatements, scratchSchemaBefore, type ScratchSchema } from '../../helpers/migration-schema';

const integration = canRunDbTests() ? describe : describe.skip;
const MIGRATION = '20261106090000_approval_fleet_core';
const NEW_PERMISSION = 'approval.decide@fleet.job.shell.escalate';
const OLD_PERMISSION = 'fleet.approval.decide.bash';

/**
 * The `developer` seed exactly as it stood when this migration shipped. It is frozen here on purpose
 * (US-013 removed `fleet.approval.decide.bash` from the live seed, and the seed's `SYSTEM_ROLES` list
 * keeps changing): the migration's condition is about the stored pre-migration row, so deriving the
 * fixture from today's seed would quietly rewrite the thing under test.
 */
const OLD_DEVELOPER_PERMISSIONS: readonly string[] = [
  '*.read',
  'ticket.create',
  'ticket.update',
  'ticket.assign',
  'ticket.transition.*',
  'ticket.label.*',
  'ticket.link.add',
  'ticket.link.remove.own',
  'ticket.watch.*',
  'comment.create',
  'comment.update.own',
  'comment.delete.own',
  'label.create',
  'label.update',
  'agent.pickup',
  'fleet.job.*',
  'fleet.schedule.read',
  'fleet.schedule.create',
  'fleet.schedule.update.own',
  'fleet.schedule.delete.own',
  'fleet.repo.drift.check',
  'fleet.ticket-job.*',
  'fleet.approval.decide.bash',
  'fleet.knowledge.repo.reindex',
  'thread.create',
  'thread.*.own',
  'kb.document.add',
  'kb.document.delete.own',
  'kb.search',
  'memory.create',
  'memory.extract',
  'memory.decision.record',
  'memory.update.own',
  'codeintel.*',
  'context.*',
  '!project.ci-token.read',
  '!invite.read',
];

integration('Developer bash decision permission migration', () => {
  let scratch: ScratchSchema;
  let updateRoleStatement: string;

  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'developer_bash_decide_mig', MIGRATION);
    const statements = migrationStatements(MIGRATION);
    updateRoleStatement = statements.find((statement) => /^UPDATE\s+"Role"/i.test(statement)) ?? '';
    if (!updateRoleStatement) throw new Error('Role update is missing from approval fleet migration');
    await scratch.db.$executeRawUnsafe(
      `INSERT INTO "Role" ("id", "key", "name", "scope", "permissions", "updatedAt") VALUES
       ('developer', 'developer', 'Developer', 'PROJECT', $1::jsonb, now()),
       ('reviewer', 'reviewer', 'Reviewer', 'PROJECT', $2::jsonb, now())`,
      JSON.stringify(OLD_DEVELOPER_PERMISSIONS),
      JSON.stringify([OLD_PERMISSION]),
    );
  }, 120_000);
  beforeEach(async () => {
    await scratch.db.$executeRawUnsafe(
      `UPDATE "Role" SET "permissions" = $1::jsonb WHERE "key" = 'developer'`,
      JSON.stringify(OLD_DEVELOPER_PERMISSIONS),
    );
    await scratch.db.$executeRawUnsafe(
      `UPDATE "Role" SET "permissions" = $1::jsonb WHERE "key" = 'reviewer'`,
      JSON.stringify([OLD_PERMISSION]),
    );
  });
  afterAll(async () => { await scratch?.drop(); });

  it('AC-4: appends the new permission exactly once at the end for a Developer retaining bash decision', async () => {
    await scratch.db.$executeRawUnsafe(updateRoleStatement);
    const rows = await scratch.db.$queryRawUnsafe<Array<{ permissions: string[] }>>(
      `SELECT "permissions" FROM "Role" WHERE "key" = 'developer'`,
    );
    expect(rows[0]?.permissions).toEqual([...OLD_DEVELOPER_PERMISSIONS, NEW_PERMISSION]);
  });

  it('AC-5: is idempotent when executed a second time', async () => {
    await scratch.db.$executeRawUnsafe(updateRoleStatement);
    const before = await scratch.db.$queryRawUnsafe<Array<{ permissions: string[] }>>(
      `SELECT "permissions" FROM "Role" WHERE "key" = 'developer'`,
    );
    await scratch.db.$executeRawUnsafe(updateRoleStatement);
    const after = await scratch.db.$queryRawUnsafe<Array<{ permissions: string[] }>>(
      `SELECT "permissions" FROM "Role" WHERE "key" = 'developer'`,
    );
    expect(after).toEqual(before);
  });

  it('AC-6: leaves a Developer edited to remove bash decision unchanged', async () => {
    const editedPermissions = OLD_DEVELOPER_PERMISSIONS.filter((permission) => permission !== OLD_PERMISSION);
    await scratch.db.$executeRawUnsafe(
      `UPDATE "Role" SET "permissions" = $1::jsonb WHERE "key" = 'developer'`,
      JSON.stringify(editedPermissions),
    );
    await scratch.db.$executeRawUnsafe(updateRoleStatement);
    const rows = await scratch.db.$queryRawUnsafe<Array<{ permissions: string[] }>>(
      `SELECT "permissions" FROM "Role" WHERE "key" = 'developer'`,
    );
    expect(rows[0]?.permissions).toEqual(editedPermissions);
  });

  it('AC-7: leaves a reviewer role unchanged', async () => {
    await scratch.db.$executeRawUnsafe(updateRoleStatement);
    const rows = await scratch.db.$queryRawUnsafe<Array<{ permissions: string[] }>>(
      `SELECT "permissions" FROM "Role" WHERE "key" = 'reviewer'`,
    );
    expect(rows[0]?.permissions).toEqual([OLD_PERMISSION]);
  });
});
