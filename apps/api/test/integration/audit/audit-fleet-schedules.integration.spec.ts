import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { fixtureDb } from '../../helpers/action-context';
import { PermissionService } from '../../../src/permissions/permission.service';
import { expectBindingOnlyFixtures } from '../../../src/permissions/test-helpers/permission-fixtures';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

describeIntegration('fleet schedule audit rows (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let dev2: string;
  let n = 0;
  const BASE = '/api/projects/web/fleet/schedules';
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });
  const create = async (who: keyof FleetHttpWorld['tokens'] = 'dev', name = `audit-${++n}`) => data<{ id: string }>(
    await request(server).post(BASE).set(auth(who)).send({
      name, repoId: world.repoId, feature: `audit${n}`, cron: '0 9 * * 1-5', timezone: 'UTC', maxCostUsd: 5,
    }).expect(201),
  );
  const entries = (id: string, key?: string) => prisma.auditEntry.findMany({ where: { resourceId: id, ...(key ? { key } : {}) } });
  const dev2Auth = () => ({ Authorization: `Bearer ${dev2}` });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
    await request(server).post('/api/admin/users').set(auth('root')).send({ email: 'audit-schedule-dev2@koda.test', name: 'audit schedule dev2', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    await request(server).post('/api/projects/web/members').set(auth('root')).send({ email: 'audit-schedule-dev2@koda.test', roleKey: 'developer' }).expect(201);
    resetThrottle(app);
    dev2 = await loginToken(server, 'audit-schedule-dev2@koda.test');
  });
  afterAll(async () => { await app.close(); });
  beforeEach(async () => {
    await prisma.auditEntry.deleteMany();
    await prisma.fleetActivity.deleteMany();
    await prisma.jobSchedule.deleteMany();
    await prisma.fleetJob.deleteMany();
  });

  it('AC-1/2: records create attribution and omits request values', async () => {
    const row = await create('dev', 'secret-name');
    const auditRows = await entries(row.id);
    expect(auditRows).toHaveLength(1);
    const [entry] = auditRows;
    expect(entry).toMatchObject({
      key: 'fleet.schedule.create', resourceType: 'fleet-schedule', resourceId: row.id,
      projectId: world.projectId, actorType: 'USER', actorId: world.ids.dev, origin: 'rest',
      summary: `created on repo ${world.repoId}`,
    });
    expect(entry.summary).not.toContain('secret-name');
  });

  it('AC-3: refuses a viewer without an audit row', async () => {
    await request(server).post(BASE).set(auth('viewer')).send({
      name: 'refused', repoId: world.repoId, feature: `audit${++n}`, cron: '0 9 * * 1-5', timezone: 'UTC', maxCostUsd: 5,
    }).expect(403);
    expect(await prisma.auditEntry.findMany({ where: { key: 'fleet.schedule.create', actorId: world.ids.viewer } })).toHaveLength(0);
  });

  it('AC-5: owner patch records only the updated field names', async () => {
    const row = await create();
    await request(server).patch(`${BASE}/${row.id}`).set(auth('dev')).send({ cron: '0 6 * * *', timezone: 'UTC' }).expect(200);
    const auditRows = await entries(row.id, 'fleet.schedule.update');
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ resourceType: 'fleet-schedule', projectId: world.projectId, summary: 'fields: cron, timezone' });
  });

  it('AC-6: a second developer cannot update the owner schedule and records nothing', async () => {
    const dev2User = await prisma.user.findUniqueOrThrow({ where: { email: 'audit-schedule-dev2@koda.test' } });
    const principal = { type: 'USER' as const, id: dev2User.id };
    await expectBindingOnlyFixtures(prisma, [principal]);
    const keys = await app.get(PermissionService).effectiveKeys(principal, { projectId: world.projectId });
    expect(keys.has('project.read')).toBe(true);
    expect(keys.has('fleet.schedule.update.own')).toBe(true);
    expect(keys.has('fleet.schedule.update')).toBe(false);
    const row = await create();
    await request(server).patch(`${BASE}/${row.id}`).set(dev2Auth()).send({ cron: '0 6 * * *' }).expect(403);
    expect(await entries(row.id, 'fleet.schedule.update')).toHaveLength(0);
  });

  it('AC-7–10: disable and enable audit only actual transitions', async () => {
    const row = await create();
    const disabled = data<{ enabled: boolean; disabledReason: string | null; nextFireAt: string | null }>(
      await request(server).post(`${BASE}/${row.id}/disable`).set(auth('dev')).expect(200),
    );
    expect(disabled).toMatchObject({ enabled: false, disabledReason: 'manual', nextFireAt: null });
    const disableEntries = await entries(row.id, 'fleet.schedule.update');
    expect(disableEntries).toHaveLength(1);
    expect(disableEntries[0].summary).toBe('disabled');

    const disabledAgain = data<typeof disabled>(await request(server).post(`${BASE}/${row.id}/disable`).set(auth('dev')).expect(200));
    expect(disabledAgain).toEqual(disabled);
    expect(await entries(row.id, 'fleet.schedule.update')).toHaveLength(1);

    const enabled = data<typeof disabled>(await request(server).post(`${BASE}/${row.id}/enable`).set(auth('dev')).expect(200));
    expect(enabled.enabled).toBe(true);
    const enableEntries = await entries(row.id, 'fleet.schedule.update');
    expect(enableEntries).toHaveLength(2);
    expect(enableEntries.filter((entry) => entry.summary === 'enabled')).toHaveLength(1);

    const enabledAgain = data<typeof disabled>(await request(server).post(`${BASE}/${row.id}/enable`).set(auth('dev')).expect(200));
    expect(enabledAgain).toEqual(enabled);
    expect(await entries(row.id, 'fleet.schedule.update')).toHaveLength(2);
  });

  it('AC-11: owner delete records the committed deletion', async () => {
    const row = await create();
    await request(server).delete(`${BASE}/${row.id}`).set(auth('dev')).expect(204);
    const auditRows = await entries(row.id, 'fleet.schedule.delete');
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      resourceType: 'fleet-schedule', projectId: world.projectId, summary: 'deleted',
    });
  });

  it('AC-4: recorder failure rolls back the schedule transaction', async () => {
    const name = `rollback-${++n}`;
    const record = vi.spyOn(app.get(AuditRecorder), 'record').mockRejectedValue(new Error('audit unavailable'));
    try {
      await request(server).post(BASE).set(auth('dev')).send({
        name, repoId: world.repoId, feature: `audit${n}`, cron: '0 9 * * 1-5', timezone: 'UTC', maxCostUsd: 5,
      }).expect(500);
      expect(await prisma.jobSchedule.count({ where: { name } })).toBe(0);
      expect(await prisma.auditEntry.count({ where: { key: 'fleet.schedule.create' } })).toBe(0);
    } finally {
      record.mockRestore();
    }
  });
});
