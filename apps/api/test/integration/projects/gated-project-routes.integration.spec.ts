import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';
import { ConflictAppException } from '../../../src/common/exceptions/conflict-app.exception';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
interface Pending { id: string; permissionKey: string; projectId: string | null }
interface Settled { status: string; result: unknown }

describeIntegration('gated project create and update routes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rootAuth = () => auth(world.tokens.root);
  const createBody = (name: string, slug: string, key: string) => ({ name, slug, key });
  const create = (body: ReturnType<typeof createBody>, token = agent.apiKey) => request(server()).post('/api/projects').set(auth(token)).send(body);
  const pending = (res: request.Response) => { expect(res.status).toBe(202); return data<Pending>(res); };
  const approve = async (id: string) => data<Settled>(await request(server()).post(`/api/approvals/${id}/decisions`).set(rootAuth()).send({ decision: 'approve' }).expect(200));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.create'], null);
    await app.get(PermissionCache).invalidate();
  }, 60_000);
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });
  afterAll(async () => { await app?.close(); });

  it('AC-1: global project create returns a pending request', async () => {
    await seedWaitPolicy(db, 'project.create', null);
    const summary = pending(await create(createBody('Pending project', 'pending-create-one', 'PND')));
    expect(summary).toMatchObject({ permissionKey: 'project.create', projectId: null });
  });

  it('AC-2: a pending create does not persist the project', async () => {
    const slug = 'not-yet-created-one';
    await seedWaitPolicy(db, 'project.create', null);
    pending(await create(createBody('Pending project', slug, 'NYC')));
    expect(await db.project.count({ where: { slug } })).toBe(0);
  });

  it('AC-3: approved create writes one project', async () => {
    const slug = 'approved-create-one';
    await seedWaitPolicy(db, 'project.create', null);
    const summary = pending(await create(createBody('Approved project', slug, 'APR')));
    expect(await approve(summary.id)).toMatchObject({ status: 'executed' });
    expect(await db.project.count({ where: { slug } })).toBe(1);
  });

  it('AC-4: create approval fails if root takes the slug while waiting', async () => {
    const slug = 'raced-create-one';
    await seedWaitPolicy(db, 'project.create', null);
    const summary = pending(await create(createBody('Waiting project', slug, 'WAI')));
    await create(createBody('Root project', slug, 'ROT'), world.tokens.root).expect(201);
    expect(await approve(summary.id)).toMatchObject({ status: 'failed', result: { error: 'execution-failed', name: new ConflictAppException({ field: 'slug' }, 'projects').name } });
  });

  it('AC-5: project update waits at project scope', async () => {
    const project = data<{ id: string; slug: string }>(await create(createBody('Update target', 'update-target-one', 'UPD'), world.tokens.root).expect(201));
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'project.update'], project.id);
    await app.get(PermissionCache).invalidate();
    await seedWaitPolicy(db, 'project.update', project.id);
    const summary = pending(await request(server()).patch(`/api/projects/${project.slug}`).set(auth(agent.apiKey)).send({ name: 'Renamed' }));
    expect(summary).toMatchObject({ permissionKey: 'project.update', projectId: project.id });
  });

  it('AC-6: approved update changes the project', async () => {
    const project = data<{ id: string; slug: string }>(await create(createBody('Update target two', 'update-target-two', 'UPT'), world.tokens.root).expect(201));
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'project.update'], project.id);
    await app.get(PermissionCache).invalidate();
    await seedWaitPolicy(db, 'project.update', project.id);
    const summary = pending(await request(server()).patch(`/api/projects/${project.slug}`).set(auth(agent.apiKey)).send({ name: 'Renamed' }));
    expect(await approve(summary.id)).toMatchObject({ status: 'executed' });
    expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).name).toBe('Renamed');
  });

  it('AC-7: root create under a wait policy executes directly', async () => {
    const slug = 'root-create-one';
    await seedWaitPolicy(db, 'project.create', null);
    await create(createBody('Root project', slug, 'RTP'), world.tokens.root).expect(201);
    expect(await db.approvalRequest.count()).toBe(0);
    expect(await db.project.count({ where: { slug } })).toBe(1);
  });
});
