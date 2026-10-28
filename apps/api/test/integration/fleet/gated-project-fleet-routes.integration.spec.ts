import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { ConfigJobsService } from '../../../src/fleet/repo-config/config-jobs.service';
import { FLEET_REPO_FILES_READER, type FleetRepoFilesReader } from '../../../src/fleet/repo-config/fleet-repo-files.reader';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
interface Pending { id: string; permissionKey: string; projectId: string }
interface Decided { status: string; result: unknown }

describeIntegration('gated project fleet routes', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let ownAgent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const schedules = '/api/projects/web/fleet/schedules';
  const drift = () => `/api/projects/web/fleet/repos/${world.repoId}/drift-checks`;
  const pending = (res: request.Response, permissionKey: string) => {
    expect(res.status).toBe(202);
    const summary = data<Pending>(res);
    expect(summary).toMatchObject({ permissionKey, projectId: world.projectId });
    return summary;
  };
  const approve = async (id: string) => data<Decided>(await request(server()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));
  const schedule = async (token = world.tokens.dev) => data<{ id: string }>(await request(server()).post(schedules).set(auth(token)).send({
    name: 'nightly', repoId: world.repoId, feature: 'gated', cron: '0 9 * * *', timezone: 'UTC', maxCostUsd: 5,
  }).expect(201));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
    ownAgent = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'fleet.schedule.delete', 'fleet.repo.drift.check'], world.projectId);
    await grantKeys(db, { type: 'AGENT', id: ownAgent.id }, ['project.read', 'fleet.schedule.delete.own', 'fleet.schedule.create'], world.projectId);
    await app.get(PermissionCache).invalidate();
    vi.spyOn(app.get<FleetRepoFilesReader>(FLEET_REPO_FILES_READER), 'list').mockResolvedValue({ baseSha: 'c'.repeat(40), defaultBranch: 'trunk', files: [] });
  }, 60_000);
  afterAll(async () => { vi.restoreAllMocks(); await app?.close(); });
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
    await db.fleetJob.deleteMany();
    await db.jobSchedule.deleteMany();
  });
  it('AC-1: any-row agent delete waits, then root approval removes the schedule', async () => {
    const row = await schedule();
    const summary = pending(await request(server()).delete(`${schedules}/${row.id}`).set(auth(agent.apiKey)), 'fleet.schedule.delete');
    expect(await db.jobSchedule.findUnique({ where: { id: row.id } })).not.toBeNull();
    expect(await approve(summary.id)).toMatchObject({ status: 'executed', result: null });
    expect(await db.jobSchedule.findUnique({ where: { id: row.id } })).toBeNull();
  });
  it('AC-2: own-only agent on another owner waits, fails on approval and leaves the schedule', async () => {
    const row = await schedule();
    const summary = pending(await request(server()).delete(`${schedules}/${row.id}`).set(auth(ownAgent.apiKey)), 'fleet.schedule.delete');
    expect(await approve(summary.id)).toMatchObject({ status: 'failed', result: { error: 'execution-failed' } });
    expect(await db.jobSchedule.findUnique({ where: { id: row.id } })).not.toBeNull();
  });
  it('AC-3: own-only agent deleting its own schedule waits and succeeds on approval', async () => {
    const row = await schedule(ownAgent.apiKey);
    expect((await db.jobSchedule.findUniqueOrThrow({ where: { id: row.id } })).createdById).toBe(ownAgent.id);
    const summary = pending(await request(server()).delete(`${schedules}/${row.id}`).set(auth(ownAgent.apiKey)), 'fleet.schedule.delete');
    expect((await approve(summary.id)).status).toBe('executed');
    expect(await db.jobSchedule.findUnique({ where: { id: row.id } })).toBeNull();
  });
  it('AC-4: root deletes immediately with 204, no body and no approval request', async () => {
    const row = await schedule();
    const res = await request(server()).delete(`${schedules}/${row.id}`).set(auth(world.tokens.root)).expect(204);
    expect(res.text).toBe('');
    expect(await db.jobSchedule.findUnique({ where: { id: row.id } })).toBeNull();
    expect(await db.approvalRequest.count()).toBe(0);
  });
  it('AC-5/AC-6: drift waits, then stores the exact dispatch DTO and attributes the job to the agent', async () => {
    const service = app.get(ConfigJobsService);
    const original = service.prepareDrift.bind(service);
    const mutate = vi.fn();
    const submit = vi.spyOn(service, 'prepareDrift').mockImplementation(async (...args) => {
      const run = await original(...args);
      mutate.mockImplementation(run);
      return mutate;
    });
    try {
      const summary = pending(await request(server()).post(drift()).set(auth(agent.apiKey)), 'fleet.repo.drift.check');
      expect(submit).not.toHaveBeenCalled();
      expect(await db.fleetJob.count()).toBe(0);
      expect((await approve(summary.id)).status).toBe('executed');
      expect(submit).toHaveBeenCalledExactlyOnceWith(agent.id, world.projectId, world.repoId);
      expect(mutate).toHaveBeenCalledTimes(1);
      const result = await mutate.mock.results[0].value;
      const stored = await db.approvalRequest.findUniqueOrThrow({ where: { id: summary.id } });
      expect(stored.result).toEqual(JSON.parse(JSON.stringify(result)));
      expect(stored.result).toMatchObject({ job: { command: 'CONFIG_DRIFT' }, placement: expect.any(Object) });
      expect(await db.fleetJob.findUniqueOrThrow({ where: { id: result.job.id } })).toMatchObject({ repoId: world.repoId, requestedById: agent.id, requestedByType: 'AGENT' });
    } finally { submit.mockRestore(); }
  });
  it('AC-7: member human drift still executes immediately with 201', async () => {
    const result = data<{ job: { id: string; command: string }; placement: unknown }>(await request(server()).post(drift()).set(auth(world.tokens.dev)).expect(201));
    expect(result).toMatchObject({ job: { command: 'CONFIG_DRIFT' }, placement: expect.any(Object) });
    expect(await db.fleetJob.findUniqueOrThrow({ where: { id: result.job.id } })).toMatchObject({ requestedById: world.ids.dev, requestedByType: 'USER' });
    expect(await db.approvalRequest.count()).toBe(0);
  });
});
