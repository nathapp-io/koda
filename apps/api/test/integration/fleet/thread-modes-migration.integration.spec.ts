import { randomUUID } from 'node:crypto';
import { applyMigration, migrationStatements, scratchSchemaBefore, type ScratchSchema } from '../../helpers/migration-schema';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import { canRunDbTests } from '../../helpers/test-environment';

const MIGRATION = '20261124090000_thread_modes';
const describeDb = canRunDbTests() ? describe : describe.skip;
describeDb('thread modes migration over the preceding schema', () => {
  let scratch: ScratchSchema;
  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('Test database URL missing');
    scratch = await scratchSchemaBefore(url, `thread_modes_${randomUUID().replaceAll('-', '')}`, MIGRATION);
  }, 120_000);
  afterAll(async () => { await scratch?.drop(); });
  it('AC-6: applies the full migration, defaults old threads/turns to read and backfills developer once', async () => {
    const db = scratch.db;
    const world = await seedFleetBase(db);
    await db.role.update({ where: { key: 'developer' }, data: { permissions: ['thread.create', '!ticket.delete'] } });
    await db.$executeRaw`INSERT INTO "ChatThread" ("id", "projectId", "repoId", "title", "createdById", "backend", "skills") VALUES ('old-thread', ${world.projectId}, ${world.repoId}, 'Old', ${world.adminId}, '{"kind":"native"}'::jsonb, '[]'::jsonb)`;
    const job = await db.fleetJob.create({ data: { projectId: world.projectId, repoId: world.repoId, command: 'THREAD', ref: 'main', feature: 'old-thread', profiles: [], maxCostUsd: 5, selectorLabels: [], requestedById: world.adminId, threadId: 'old-thread' } });
    await db.$executeRaw`INSERT INTO "FleetThreadTurn" ("jobId", "threadId", "action", "instructions", "backend", "skills", "resume") VALUES (${job.id}, 'old-thread', 'SESSION', '', '{"kind":"native"}'::jsonb, '[]'::jsonb, false)`;
    await applyMigration(db, MIGRATION);
    // The generated client selects every ChatThread scalar, including `preApproval`, which only the
    // later fleet_flows migration adds. Apply it so the reads below can use the client; the assertions
    // still cover only what the thread_modes migration writes.
    await applyMigration(db, '20261125090000_fleet_flows');
    expect(await db.chatThread.findUniqueOrThrow({ where: { id: 'old-thread' } })).toMatchObject({ mode: 'read', pendingApprovals: null });
    expect(await db.fleetThreadTurn.findUniqueOrThrow({ where: { jobId: job.id } })).toMatchObject({ mode: 'read' });
    const backfill = migrationStatements(MIGRATION).find((s) => s.startsWith('UPDATE "Role"'));
    if (!backfill) throw new Error('Missing developer migration backfill');
    await db.$executeRawUnsafe(backfill);
    expect((await db.role.findUniqueOrThrow({ where: { key: 'developer' } })).permissions).toEqual(['thread.create', '!ticket.delete', 'thread.mode.ask']);
  }, 60_000);
});
