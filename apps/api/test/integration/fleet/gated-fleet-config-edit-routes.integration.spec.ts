import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { FLEET_REPO_FILES_READER, type FleetRepoFilesReader } from '../../../src/fleet/repo-config/fleet-repo-files.reader';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
interface Pending { id: string; permissionKey: string; projectId: string }
interface Decided { status: string; result: { error?: string; name?: string } }
const SHA = 'c'.repeat(40);

describeIntegration('gated fleet config edit routes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let reader: FleetRepoFilesReader;
  let list: ReturnType<typeof vi.spyOn<FleetRepoFilesReader, 'list'>>;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const route = () => `/api/projects/web/fleet/repos/${world.repoId}/config-edits`;
  const editBody = { edits: [{ path: '.nax/context.md', op: 'put', content: '# edit', baseSha: null }], prTitle: 'Edit', baseSha: SHA };
  const pending = async (res: request.Response): Promise<Pending> => {
    expect(res.status).toBe(202);
    const result = data<Pending>(res);
    expect(result).toMatchObject({ permissionKey: 'fleet.job.config.edit', projectId: world.projectId });
    return result;
  };
  const approve = async (id: string) => data<Decided>(await request(server()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));
  const listCalls = () => list.mock.calls.length;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'fleet.job.config.edit'], world.projectId);
    await app.get(PermissionCache).invalidate();
    reader = app.get<FleetRepoFilesReader>(FLEET_REPO_FILES_READER);
    list = vi.spyOn(reader, 'list');
  }, 60_000);
  afterAll(async () => { vi.restoreAllMocks(); await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    await db.fleetConfigEdit.deleteMany();
    await db.fleetJob.deleteMany();
    list.mockReset();
    list.mockResolvedValue({ baseSha: SHA, defaultBranch: 'trunk', files: [] });
  });

  it('AC-1: agent edit waits under a project policy', async () => {
    await seedWaitPolicy(db, 'fleet.job.config.edit', world.projectId);
    const ask = await pending(await request(server()).post(route()).set(auth(agent.apiKey)).send(editBody).expect(202));
    expect(await db.approvalRequest.findUniqueOrThrow({ where: { id: ask.id } })).toMatchObject({ permissionKey: 'fleet.job.config.edit', projectId: world.projectId });
  });

  it("AC-2: approval executes the agent's pending edit as its requester", async () => {
    await seedWaitPolicy(db, 'fleet.job.config.edit', world.projectId);
    const ask = await pending(await request(server()).post(route()).set(auth(agent.apiKey)).send(editBody).expect(202));
    expect((await approve(ask.id)).status).toBe('executed');
    const jobs = await db.fleetJob.findMany({ where: { repoId: world.repoId, command: 'CONFIG_EDIT' } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.requestedById).toBe(agent.id);
  });

  it('AC-3/AC-4: regenerate waits without calling the forge reader', async () => {
    await seedWaitPolicy(db, 'fleet.job.config.edit', world.projectId);
    const ask = await pending(await request(server()).post(`${route()}/regenerate`).set(auth(agent.apiKey)).send({ prTitle: 'Regen' }).expect(202));
    expect(ask.permissionKey).toBe('fleet.job.config.edit');
    expect(listCalls()).toBe(0);
  });

  it('AC-5: approved regenerate creates one config edit with the prepared base sha', async () => {
    await seedWaitPolicy(db, 'fleet.job.config.edit', world.projectId);
    const ask = await pending(await request(server()).post(`${route()}/regenerate`).set(auth(agent.apiKey)).send({ prTitle: 'Regen' }).expect(202));
    expect(listCalls()).toBe(0);
    expect((await approve(ask.id)).status).toBe('executed');
    expect(listCalls()).toBe(1);
    const jobs = await db.fleetJob.findMany({ where: { repoId: world.repoId, command: 'CONFIG_EDIT' } });
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    if (!job) throw new Error('Expected the approved config job');
    const config = await db.fleetConfigEdit.findUniqueOrThrow({ where: { jobId: job.id } });
    expect(config).toMatchObject({ mode: 'regenerate', baseSha: SHA });
  });

  it('AC-6: regenerate preparation failure settles failed and creates no config job', async () => {
    await seedWaitPolicy(db, 'fleet.job.config.edit', world.projectId);
    const ask = await pending(await request(server()).post(`${route()}/regenerate`).set(auth(agent.apiKey)).send({ prTitle: 'Regen' }).expect(202));
    list.mockRejectedValueOnce(new Error('forge unavailable'));
    expect(await approve(ask.id)).toMatchObject({ status: 'failed', result: { error: 'execution-failed' } });
    expect(await db.fleetJob.count({ where: { repoId: world.repoId, command: 'CONFIG_EDIT' } })).toBe(0);
  });

  it('AC-7: root executes immediately under a wait policy without an approval row', async () => {
    await seedWaitPolicy(db, 'fleet.job.config.edit', world.projectId);
    await request(server()).post(route()).set(auth(world.tokens.root)).send(editBody).expect(201);
    expect(await db.approvalRequest.count()).toBe(0);
  });
});
