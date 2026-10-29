import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';
import { AgentsService } from '../../../src/agents/agents.service';
import { PrismaAgentRepository } from '../../../src/agents/prisma-agent.repository';
import { lockProjectAgents } from '../../../src/common/utils/advisory-lock';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
interface Pending { id: string; permissionKey: string; projectId: string | null }
interface Settled { status: string; result: unknown }

describeIntegration('gated project-agent updates', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let actor: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rootAuth = () => auth(world.tokens.root);
  const pending = (res: request.Response) => { expect(res.status).toBe(202); return data<Pending>(res); };
  const approve = async (id: string) => data<Settled>(await request(server()).post(`/api/approvals/${id}/decisions`).set(rootAuth()).send({ decision: 'approve' }).expect(200));
  let seq = 0;

  async function target() {
    const slug = `project-agent-target-${++seq}`;
    const seeded = await seedFleetHttpAgent(server(), world.tokens.root);
    await db.agent.update({ where: { id: seeded.id }, data: { slug, name: slug } });
    await grantKeys(db, { type: 'AGENT', id: seeded.id }, ['project.read'], world.projectId);
    return { ...seeded, slug };
  }
  async function authorizeActor() {
    await grantKeys(db, { type: 'AGENT', id: actor.id }, ['agent.update'], null);
    await grantKeys(db, { type: 'AGENT', id: actor.id }, ['project.read'], world.projectId);
    await app.get(PermissionCache).invalidate();
  }
  const patch = (slug: string, token: string, body: object) => request(server()).patch(`/api/projects/${'web'}/agents/${slug}`).set(auth(token)).send(body);

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    actor = await seedFleetHttpAgent(server(), world.tokens.root);
    await authorizeActor();
  }, 60_000);
  beforeEach(async () => {
    resetThrottle(app);
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });
  afterAll(async () => { await app?.close(); });

  it('AC-1: key-holder update waits globally and AC-2 executes when approved', async () => {
    const targetAgent = await target();
    await seedWaitPolicy(db, 'agent.update', null);
    const summary = pending(await patch(targetAgent.slug, actor.apiKey, { status: 'PAUSED' }));
    expect(summary).toMatchObject({ permissionKey: 'agent.update', projectId: null });
    expect(await approve(summary.id)).toMatchObject({ status: 'executed' });
    expect((await db.agent.findUniqueOrThrow({ where: { id: targetAgent.id } })).status).toBe('PAUSED');
  });

  it('AC-3: approval fails when the target is deleted while pending', async () => {
    const targetAgent = await target();
    await seedWaitPolicy(db, 'agent.update', null);
    const summary = pending(await patch(targetAgent.slug, actor.apiKey, { status: 'PAUSED' }));
    const slug = targetAgent.slug;
    await db.roleBinding.deleteMany({ where: { principalType: 'AGENT', principalId: targetAgent.id } });
    await db.agent.delete({ where: { id: targetAgent.id } });
    const replacement = await seedFleetHttpAgent(server(), world.tokens.root);
    await db.agent.update({ where: { id: replacement.id }, data: { slug, name: `replacement-${slug}` } });
    await grantKeys(db, { type: 'AGENT', id: replacement.id }, ['project.read'], world.projectId);
    await app.get(PermissionCache).invalidate();
    expect(await approve(summary.id)).toMatchObject({ status: 'failed' });
    expect((await db.agent.findUniqueOrThrow({ where: { id: replacement.id } })).status).toBe('ACTIVE');
  });

  it.each(['without global key', 'with global key'])('AC-4/5: self update is immediate %s', async (keyState) => {
    const own = await target();
    await grantKeys(db, { type: 'AGENT', id: own.id }, ['project.read'], world.projectId);
    if (keyState === 'with global key') await grantKeys(db, { type: 'AGENT', id: own.id }, ['agent.update'], null);
    await app.get(PermissionCache).invalidate();
    await seedWaitPolicy(db, 'agent.update', null);
    const response = await patch(own.slug, own.apiKey, { status: 'OFFLINE' }).expect(200);
    expect(data<{ status: string }>(response).status).toBe('OFFLINE');
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('serializes an approved write behind roster removal and refuses after removal commits', async () => {
    const targetAgent = await target();
    const service = app.get(AgentsService);
    let acquired!: () => void;
    let release!: () => void;
    const lockHeld = new Promise<void>((resolve) => { acquired = resolve; });
    const continueRemoval = new Promise<void>((resolve) => { release = resolve; });
    const removal = db.$transaction(async (tx) => {
      await lockProjectAgents(tx, world.projectId);
      acquired();
      await continueRemoval;
      await tx.roleBinding.deleteMany({ where: { principalType: 'AGENT', principalId: targetAgent.id, projectId: world.projectId } });
    });
    await lockHeld;
    const repository = app.get(PrismaAgentRepository, { strict: false });
    const realLock = repository.lockProjectAgents.bind(repository);
    let updatePid: number | undefined;
    const lockSpy = vi.spyOn(repository, 'lockProjectAgents').mockImplementationOnce(async (projectId) => {
      // fixtureDb follows the ambient transaction client used by the repository.
      // Capture identity before the real lock call, not from whichever waiter appears first.
      const [backend] = await db.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      updatePid = backend.pid;
      await realLock(projectId);
    });
    let updateSettled = false;
    const update = service.updateRosteredAgent('web', targetAgent.slug, { status: 'PAUSED' }, world.projectId, targetAgent.id)
      .finally(() => { updateSettled = true; });
    // Attach the rejection assertion immediately to avoid an unhandled rejection during cleanup.
    const updateRejected = expect(update).rejects.toMatchObject({ prefix: 'projectAgents' });
    try {
      let waiterPid: number | undefined;
      for (let attempt = 0; attempt < 50 && waiterPid === undefined; attempt += 1) {
        if (updatePid !== undefined) {
          const waiters = await db.$queryRaw<Array<{ pid: number }>>`SELECT activity.pid
            FROM pg_locks AS lock
            JOIN pg_stat_activity AS activity USING (pid)
            WHERE lock.pid = ${updatePid}
              AND lock.locktype = 'advisory'
              AND lock.classid = 72402::oid
              AND lock.objid = hashtext(${world.projectId})::oid
              AND lock.granted = false
              AND activity.wait_event_type = 'Lock'
              AND activity.query LIKE '%pg_advisory_xact_lock%'`;
          waiterPid = waiters[0]?.pid;
        }
        if (waiterPid === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(updatePid).toEqual(expect.any(Number));
      expect(waiterPid).toBe(updatePid);
      expect(updateSettled).toBe(false);
    } finally {
      release();
      try {
        await removal;
        await updateRejected;
      } finally {
        lockSpy.mockRestore();
      }
    }
    expect((await db.agent.findUniqueOrThrow({ where: { id: targetAgent.id } })).status).toBe('ACTIVE');
  });

  it('AC-6: non-key-holder receives permissions 403 without a request', async () => {
    const targetAgent = await target();
    const denied = await seedFleetHttpAgent(server(), world.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: denied.id }, ['project.read'], world.projectId);
    await app.get(PermissionCache).invalidate();
    await seedWaitPolicy(db, 'agent.update', null);
    const response = await patch(targetAgent.slug, denied.apiKey, { status: 'PAUSED' }).expect(403);
    expect(response.body).toMatchObject({ ret: 40003, message: 'You do not have permissions to perform this action' });
    expect(await db.approvalRequest.count()).toBe(0);
  });
});
