import { applyMigration, scratchSchemaBefore, type ScratchSchema } from '../../helpers/migration-schema';
import { findThreadAction } from '../../helpers/assistant-request';
import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaAssistantToolCallRepository } from '../../../src/fleet/assistant/prisma-assistant-tool-call.repository';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { enrollRunner, FLEET_CAPS, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedThreadJobFor } from '../../helpers/thread-fixtures';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const integration = canRunDbTests() ? describe : describe.skip;

integration('assistant action actors (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let runner: { runnerId: string; apiKey: string };
  let calls: PrismaAssistantToolCallRepository;
  let seq = 0;
  const env = ['FLEET_THREADS_ENABLED', 'FLEET_SWEEP_ENABLED'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of env) saved[key] = process.env[key];
    process.env.FLEET_THREADS_ENABLED = 'true';
    process.env.FLEET_SWEEP_ENABLED = 'false';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    runner = await enrollRunner(app.getHttpServer(), world.tokens.root, 'actor-runner', {
      capabilities: { ...FLEET_CAPS, kodaTools: true, threadBackends: { native: ['m1'], acp: [] }, threadWrite: true },
    });
    calls = app.get(PrismaAssistantToolCallRepository, { strict: false });
    await db.ticket.create({ data: { projectId: world.projectId, number: 1, title: 'Actor ticket', type: 'BUG', status: 'CREATED', priority: 'HIGH', createdByUserId: world.ids.dev } });
  }, 120_000);
  afterAll(async () => {
    try { await app?.close(); } finally {
      for (const key of env) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  async function requestInThread() {
    const seed = await seedThreadJobFor(db, world, runner, { feature: `actor-${++seq}` });
    await request(app.getHttpServer()).post(`/api/fleet/runner/jobs/${seed.jobId}/tools/koda_add_comment?leaseEpoch=1`)
      .set('Authorization', `Bearer ${runner.apiKey}`).send({ toolCallId: `actor-${seq}`, input: { ref: 'WEB-1', body: 'x' } }).expect(200);
    return findThreadAction(db, { jobId: seed.jobId, toolCallId: `actor-${seq}` });
  }
  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('AC-8: permits multiple agent audit rows with null replay and project fields', async () => {
    for (let i = 0; i < 2; i++) {
      const row = await db.assistantToolCall.create({ data: {
        jobId: null, threadId: null, toolCallId: null, projectId: null, actorType: 'agent', actorId: 'agent-1',
        tool: 'koda_my_projects', inputHash: 'hash', outcome: 'ok', content: 'ok', isError: false, resultBytes: 2, durationMs: 0,
      } });
      expect(row).toMatchObject({ actorType: 'agent', projectId: null });
    }
  });
  it('AC-9: runner proposal derives thread actor and approval mode', async () => {
    const row = await requestInThread();
    expect(row).toMatchObject({ actorType: 'SYSTEM', actorId: 'assistant', onBehalfOfType: 'USER', onBehalfOfId: world.ids.dev, origin: 'thread', requiredMode: 'human', status: 'pending' });
  });
  it('AC-10: runner audit records the thread creator', async () => {
    const row = await requestInThread();
    expect(await calls.findByCall(row.jobId as string, row.toolCallId as string)).toMatchObject({ actorType: 'user', actorId: world.ids.dev });
  });
  it('AC-14: finds user identity including disabled, or null', async () => {
    const user = await db.user.findUniqueOrThrow({ where: { id: world.ids.dev } });
    expect(await calls.findUserActor(user.id)).toEqual({ id: user.id, email: user.email, role: 'MEMBER', disabled: user.disabled });
    expect(await calls.findUserActor('missing-user')).toBeNull();
  });
  it('role claim AC-14: user without global bindings is MEMBER', async () => {
    const user = await db.user.create({ data: { email: 'actor-legacy@claim.test', name: 'Legacy', passwordHash: 'h' } });
    await grantBaseline(db, { type: 'USER', id: user.id });
    expect(await calls.findUserActor(user.id)).toMatchObject({ role: 'MEMBER' });
  });
  it('role claim AC-15: global admin binding is ADMIN', async () => {
    const user = await db.user.create({ data: { email: 'actor-admin@claim.test', name: 'Admin', passwordHash: 'h' } });
    await grantBaseline(db, { type: 'USER', id: user.id });
    await grantRole(db, { type: 'USER', id: user.id }, 'admin');

    expect(await calls.findUserActor(user.id)).toMatchObject({ role: 'ADMIN' });
  });
});

integration('PendingAction drop migration (scratch schema)', () => {
  const migration = '20261105090100_drop_pending_action';
  let scratch: ScratchSchema;

  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'pending_action_drop_mig', migration);
  }, 120_000);
  afterAll(async () => { await scratch?.drop(); });

  it('AC-1: deletes only assistant_action fleet approvals and drops PendingAction', async () => {
    const db = scratch.db;
    await db.$executeRawUnsafe(`INSERT INTO "FleetApproval" ("id", "type", "payload", "requestedAt", "updatedAt") VALUES
      ('assistant', 'assistant_action', '{}', now(), now()),
      ('budget', 'budget_override_required', '{}', now(), now()),
      ('bash', 'nax_bash_escalate', '{}', now(), now())`);
    await db.$executeRawUnsafe(`INSERT INTO "PendingAction" ("id", "projectId", "tool", "input", "preview", "actorType", "actorId", "expiresAt")
      VALUES ('discarded', 'project', 'koda_add_comment', '{}', 'preview', 'user', 'requester', now())`);

    await applyMigration(db, migration);

    expect(await db.$queryRawUnsafe('SELECT "id", "type" FROM "FleetApproval" ORDER BY "id"')).toEqual([
      { id: 'bash', type: 'nax_bash_escalate' },
      { id: 'budget', type: 'budget_override_required' },
    ]);
    expect(await db.$queryRawUnsafe(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'PendingAction'`)).toEqual([]);
  });
});
