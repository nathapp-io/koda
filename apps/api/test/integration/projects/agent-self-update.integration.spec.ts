import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('agent self-update shutdown-only', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
  }, 60_000);

  beforeEach(() => resetThrottle(app));
  afterAll(async () => { await app?.close(); });

  it('returns 403 and keeps a paused rostered agent paused when it attempts to reactivate itself', async () => {
    const agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read'], world.projectId);
    await db.agent.update({ where: { id: agent.id }, data: { status: 'PAUSED' } });
    await app.get(PermissionCache).invalidate();

    const response = await request(server())
      .patch('/api/projects/web/agents/' + agent.slug)
      .set('Authorization', `Bearer ${agent.apiKey}`)
      .send({ status: 'ACTIVE' })
      .expect(403);

    expect(response.body.ret).not.toBe(0);
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).status).toBe('PAUSED');
  });
});
