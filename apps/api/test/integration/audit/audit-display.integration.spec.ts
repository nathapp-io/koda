import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import type { AuditEntryDto } from '../../../src/audit/dto/audit-entry.dto';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpWorld, seedFleetHttpAgent, insertRunner, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { fixtureDb } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

/**
 * Permissions P2 US-001: `GET /api/audit` resolves the ids on each entry to the names an auditor
 * reads. Entries are inserted directly — the audit log is history, so the test seeds whatever ids
 * the route has to project (including ones that name no row at all).
 */
describeIntegration('GET /api/audit display names (PG, real auth and permission guards)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const server = () => app.getHttpServer();
  const get = () => request(server()).get('/api/audit').set('Authorization', `Bearer ${world.tokens.root}`);
  const records = (res: request.Response) => data<{ records: AuditEntryDto[]; total: number }>(res).records;
  const entry = (over: Partial<Prisma.AuditEntryUncheckedCreateInput> = {}) => db.auditEntry.create({
    data: {
      key: 'ticket.create', resourceType: 'ticket', resourceId: 'ticket-1', actorType: 'USER', actorId: world.ids.root,
      origin: 'rest', requiredMode: 'none', satisfiedBy: 'none', correlationId: 'c1', ...over,
    },
  });
  /** The only entry the request can return: each test clears the table first. */
  const only = async (): Promise<AuditEntryDto> => {
    const rows = records(await get().expect(200));
    expect(rows).toHaveLength(1);
    return rows[0];
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
  });
  beforeEach(async () => {
    resetThrottle(app);
    await db.auditEntry.deleteMany();
  });
  afterAll(async () => { await app?.close(); });

  it("AC-1: a USER actor's name is its display name", async () => {
    await db.user.update({ where: { id: world.ids.dev }, data: { name: 'Ada' } });
    await entry({ actorType: 'USER', actorId: world.ids.dev });
    const row = await only();
    expect(row.display.actor).toBe('Ada');
    expect(row.actor).toEqual({ type: 'USER', id: world.ids.dev });
  });

  it('AC-2: a USER actor with a null name displays its email', async () => {
    await db.user.update({ where: { id: world.ids.dev }, data: { name: null } });
    await entry({ actorType: 'USER', actorId: world.ids.dev });
    expect((await only()).display.actor).toBe('dev@koda.test');
  });

  it('AC-3: a USER actor with a blank name displays its email', async () => {
    await db.user.update({ where: { id: world.ids.dev }, data: { name: '   ' } });
    await entry({ actorType: 'USER', actorId: world.ids.dev });
    expect((await only()).display.actor).toBe('dev@koda.test');
  });

  it('AC-4: an AGENT actor displays the agent name', async () => {
    await entry({ actorType: 'AGENT', actorId: agent.id });
    expect((await only()).display.actor).toBe(agent.slug);
  });

  it('AC-5: a RUNNER actor displays the runner name', async () => {
    const runner = await insertRunner(db, { name: 'wk-mac' });
    await entry({ actorType: 'RUNNER', actorId: runner.id });
    expect((await only()).display.actor).toBe('wk-mac');
  });

  it("AC-6: a SYSTEM actor displays null (its id names a component, not a row)", async () => {
    await entry({ actorType: 'SYSTEM', actorId: 'scheduler', origin: 'system' });
    const row = await only();
    expect(row.display.actor).toBeNull();
    expect(row.actor).toEqual({ type: 'SYSTEM', id: 'scheduler' });
  });

  it('AC-7: an on-behalf-of USER displays its name', async () => {
    await db.user.update({ where: { id: world.ids.viewer }, data: { name: 'Bea' } });
    await entry({ onBehalfOfType: 'USER', onBehalfOfId: world.ids.viewer });
    const row = await only();
    expect(row.display.onBehalfOf).toBe('Bea');
    expect(row.onBehalfOf).toEqual({ type: 'USER', id: world.ids.viewer });
  });

  it('AC-8: an AGENT approver displays the agent name', async () => {
    await entry({ requiredMode: 'human', satisfiedBy: 'human', approverType: 'AGENT', approverId: agent.id });
    expect((await only()).display.approver).toBe(agent.slug);
  });

  it('AC-9: a soft-deleted project still resolves slug and name', async () => {
    await db.project.update({ where: { id: world.opsProjectId }, data: { deletedAt: new Date() } });
    try {
      await entry({ projectId: world.opsProjectId });
      expect((await only()).display.project).toEqual({ slug: 'ops', name: 'ops' });
    } finally {
      await db.project.update({ where: { id: world.opsProjectId }, data: { deletedAt: null } });
    }
  });

  it('AC-10: ids that name no row display null and the request still succeeds', async () => {
    await entry({ actorType: 'USER', actorId: 'ghost', onBehalfOfType: 'USER', onBehalfOfId: 'ghost', approverType: 'USER', approverId: 'ghost', projectId: 'ghost' });
    expect((await only()).display).toEqual({ actor: null, onBehalfOf: null, approver: null, project: null });
  });
});
