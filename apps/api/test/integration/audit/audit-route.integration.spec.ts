import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder, type AuditRecordInput } from '../../../src/audit/audit-recorder.service';
import type { AuditEntryDto } from '../../../src/audit/dto/audit-entry.dto';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { MembershipService } from '../../../src/permissions/membership.service';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpWorld, seedFleetHttpAgent, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { fixtureDb, withTestActor } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('GET /api/audit (PG, real auth and permission guards)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const server = () => app.getHttpServer();
  const get = (query: Record<string, string> = {}, token?: string) => request(server()).get('/api/audit')
    .query(query).set('Authorization', `Bearer ${token ?? world.tokens.root}`);
  const records = (res: request.Response) => data<{ records: AuditEntryDto[]; total: number }>(res).records;
  const record = (input: Partial<AuditRecordInput> = {}, asAgent = false) => withTestActor(
    { type: asAgent ? 'AGENT' : 'USER', id: asAgent ? agent.id : world.ids.root },
    () => app.get<ITransactionManager>(TRANSACTION_MANAGER).run(() => app.get(AuditRecorder).record({
      key: 'ticket.create', resourceType: 'ticket', resourceId: 'ticket-1', projectId: world.projectId, ...input,
    })),
  );

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantRole(db, { type: 'USER', id: world.ids.outsider }, 'project-admin', world.projectId);
    await app.get(MembershipService).invalidatePermissions();
  });
  beforeEach(async () => {
    resetThrottle(app);
    await db.auditEntry.deleteMany();
  });
  afterAll(async () => { await app?.close(); });

  it('AC-1: admin receives the recorded resource in a page', async () => {
    await record();
    const res = await get().expect(200);
    expect(data(res)).toMatchObject({ current: 1, size: 20, total: 1 });
    expect(records(res)).toEqual([expect.objectContaining({ key: 'ticket.create', resourceType: 'ticket', resourceId: 'ticket-1', projectId: world.projectId })]);
  });
  it('AC-2: newest entry is first, with timestamps at least 10ms apart', async () => {
    await record({ resourceId: 'earlier' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await record({ resourceId: 'later' });
    const rows = records(await get().expect(200));
    expect(rows.map((row) => row.resourceId)).toEqual(['later', 'earlier']);
    expect(new Date(rows[0].createdAt).getTime() - new Date(rows[1].createdAt).getTime()).toBeGreaterThanOrEqual(10);
  });
  it('AC-3: key selects exactly the comment entries', async () => {
    await record();
    await record({ key: 'comment.create', resourceType: 'comment', resourceId: 'comment-1' });
    expect(records(await get({ key: 'comment.create' }).expect(200)).map((row) => row.resourceId)).toEqual(['comment-1']);
  });
  it('AC-4: same-day inclusive UTC window and project filter select exactly p1', async () => {
    await record();
    // Derive D from the recording timestamp, so crossing UTC midnight cannot make this flaky.
    const entry = await db.auditEntry.findFirstOrThrow({ where: { resourceId: 'ticket-1' } });
    const day = entry.createdAt.toISOString().slice(0, 10);
    await record({ projectId: world.opsProjectId, resourceId: 'other-project' });
    expect(records(await get({ projectId: world.projectId, from: day, to: day }).expect(200)).map((row) => row.resourceId)).toEqual(['ticket-1']);
  });
  it('AC-5: actor type and id select exactly the agent entries', async () => {
    await record();
    await record({ resourceId: 'agent-entry' }, true);
    expect(records(await get({ actorType: 'AGENT', actorId: agent.id }).expect(200))).toEqual([
      expect.objectContaining({ resourceId: 'agent-entry', actor: { type: 'AGENT', id: agent.id } }),
    ]);
  });
  it('AC-6: project-only project-admin is forbidden, even with projectId input', async () => {
    await get({ projectId: world.projectId }, world.tokens.outsider).expect(403);
  });
  it('AC-7: seeded global agent is forbidden', async () => {
    await request(server()).get('/api/audit').set('Authorization', `Bearer ${agent.apiKey}`).expect(403);
  });
  it('AC-8: unauthenticated request is refused', async () => {
    await request(server()).get('/api/audit').expect(401);
  });
  it('AC-9: reversed window gives the translated 400 message', async () => {
    const res = await get({ from: '2026-10-25', to: '2026-10-24' }).expect(400);
    expect(res.body.message).toBe('Invalid audit query: from must not be after to');
  });
  it.each([
    ['AC-10', { from: 'yesterday' }],
    ['AC-11', { from: '2026-10-24T10:00:00' }],
    ['AC-12', { from: '2026-10-24T10:00:00+08:00' }],
    ['AC-13', { actorType: 'ROBOT' }],
  ])('%s: invalid filters give 400', async (_ac, query) => {
    await get(query).expect(400);
  });
});
