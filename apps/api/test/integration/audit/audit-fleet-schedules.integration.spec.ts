import { canRunDbTests } from '../../helpers/test-environment';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { fixtureDb } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

describeIntegration('fleet schedule audit rows (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let n = 0;
  const BASE = '/api/projects/web/fleet/schedules';
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });
  const create = async (who: keyof FleetHttpWorld['tokens'] = 'dev', name = `audit-${++n}`) => data<{ id: string }>(
    await request(server).post(BASE).set(auth(who)).send({
      name, repoId: world.repoId, feature: `audit${n}`, cron: '0 9 * * 1-5', timezone: 'UTC', maxCostUsd: 5,
    }).expect(201),
  );
  const entries = (id: string) => prisma.auditEntry.findMany({ where: { resourceId: id } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server, prisma);
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
    const [entry] = await entries(row.id);
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
