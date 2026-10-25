import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { runWithActionContext } from '../../../src/action-context/action-context';
import { AuditRecorder, type AuditRecordInput } from '../../../src/audit/audit-recorder.service';
import type { AuditEntryDto } from '../../../src/audit/dto/audit-entry.dto';
import { grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { MembershipService } from '../../../src/permissions/membership.service';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpWorld, seedFleetHttpAgent, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { fixtureDb } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

/**
 * Permissions P2 US-002 — the exact `correlationId` filter on GET /api/audit and the distinct-key
 * endpoint GET /api/audit/keys, over the real Fastify-free HTTP app with the real auth and permission
 * guards. Entry fixtures are written through `AuditRecorder` (the production path) under an action
 * context that owns the correlation id, and every case clears the log first so the key set is exact.
 */
describeIntegration('GET /api/audit?correlationId and GET /api/audit/keys (PG, real auth and permission guards)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const server = () => app.getHttpServer();
  const asRoot = () => ({ Authorization: `Bearer ${world.tokens.root}` });
  const list = (query: Record<string, string> = {}) => request(server()).get('/api/audit').query(query).set(asRoot());
  const keys = () => request(server()).get('/api/audit/keys').set(asRoot());
  const entries = (res: request.Response) => data<{ records: AuditEntryDto[]; total: number }>(res);
  const record = (input: Partial<AuditRecordInput> = {}, correlationId = 'c-1') => runWithActionContext(
    { actor: { type: 'USER', id: world.ids.root }, origin: 'rest', correlationId },
    async () => await app.get<ITransactionManager>(TRANSACTION_MANAGER).run(() => app.get(AuditRecorder).record({
      key: 'ticket.create', resourceType: 'ticket', resourceId: 'ticket-1', projectId: world.projectId, ...input,
    })),
  );

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    // A project role that carries no global key: `audit.read` is global, so this grants nothing here.
    await grantRole(db, { type: 'USER', id: world.ids.outsider }, 'project-admin', world.projectId);
    await app.get(MembershipService).invalidatePermissions();
  });
  beforeEach(async () => {
    resetThrottle(app);
    await db.auditEntry.deleteMany();
  });
  afterAll(async () => { await app?.close(); });

  it('AC-1: correlationId selects exactly the two entries that share it', async () => {
    await record({ resourceId: 'first' }, 'c-1');
    await record({ resourceId: 'second' }, 'c-1');
    await record({ resourceId: 'other-run' }, 'c-2');

    const { records, total } = entries(await list({ correlationId: 'c-1' }).expect(200));
    expect(total).toBe(2);
    expect(records.map((row) => row.resourceId).sort()).toEqual(['first', 'second']);
  });

  it('AC-3: keys lists each distinct key once, sorted ascending', async () => {
    await record({ key: 'comment.create', resourceType: 'comment', resourceId: 'comment-1' });
    await record({ key: 'ticket.create', resourceId: 'ticket-1' });
    await record({ key: 'comment.create', resourceType: 'comment', resourceId: 'comment-2' });

    const res = await keys().expect(200);
    expect(data(res)).toEqual({ keys: ['comment.create', 'ticket.create'] });
  });

  it('AC-3: many repeated writes still yield one row per key, aggregated by the database', async () => {
    for (let i = 0; i < 30; i += 1) await record({ key: i % 2 === 0 ? 'ticket.create' : 'comment.create', resourceId: `r-${i}` });

    const rows = await db.auditEntry.count();
    expect(rows).toBe(30);
    const res = await keys().expect(200);
    expect(data(res)).toEqual({ keys: ['comment.create', 'ticket.create'] });
  });

  it('AC-4: keys is empty when the log holds no entry', async () => {
    const res = await keys().expect(200);
    expect(data(res)).toEqual({ keys: [] });
  });

  it('AC-5: the project-admin of one project is forbidden (audit.read is global)', async () => {
    await keys().set({ Authorization: `Bearer ${world.tokens.outsider}` }).expect(403);
  });

  it('AC-5: the same project-admin stays forbidden when it names its own project', async () => {
    await request(server()).get('/api/audit/keys')
      .query({ projectId: world.projectId })
      .set({ Authorization: `Bearer ${world.tokens.outsider}` })
      .expect(403);
  });

  it('AC-6: the seeded global agent is forbidden', async () => {
    await request(server()).get('/api/audit/keys').set({ Authorization: `Bearer ${agent.apiKey}` }).expect(403);
  });

  it('AC-7: an unauthenticated request is refused', async () => {
    await request(server()).get('/api/audit/keys').expect(401);
  });

  it('AC-10: a correlationId longer than 128 characters gives 400', async () => {
    await list({ correlationId: 'c'.repeat(129) }).expect(400);
  });

  it('accepts a 128-character correlationId and matches nothing else', async () => {
    const longest = 'c'.repeat(128);
    await record({ resourceId: 'long' }, longest);
    const { records } = entries(await list({ correlationId: longest }).expect(200));
    expect(records.map((row) => row.resourceId)).toEqual(['long']);
  });
});
