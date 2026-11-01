import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeDb = canRunDbTests() ? describe : describe.skip;
interface Pending { id: string; permissionKey: string; projectId: string }
interface Settled { status: string; result: unknown }

describeDb('decision retirement approval execution', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let root: Awaited<ReturnType<typeof seedFleetHttpWorld>>;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    root = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), root.tokens.root);
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'memory.decision.record', 'memory.decision.retire', 'memory.update'], root.projectId);
    await app.get(PermissionCache).invalidate();
  }, 60000);
  beforeEach(async () => {
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });
  afterAll(async () => { await app?.close(); });

  const record = async (topic: string): Promise<string> => {
    await request(server()).post('/api/memory/decisions').set(auth(agent.apiKey))
      .send({ projectId: root.projectId, topic, decision: 'retain' }).expect(201);
    return (await db.memoryItem.findFirstOrThrow({ where: { projectId: root.projectId, predicate: topic, status: 'active' } })).id;
  };
  const retire = (id: string) => request(server()).post(`/api/memory/${id}/retire`).set(auth(agent.apiKey)).send({ reason: 'obsolete' });
  const approve = async (id: string) => data<Settled>(await request(server()).post(`/api/approvals/${id}/decisions`).set(auth(root.tokens.root)).send({ decision: 'approve' }).expect(200));

  it('AC-4/5/6/7: waits for human approval, leaves item active, then retires it', async () => {
    const id = await record('pending-retire');
    await seedWaitPolicy(db, 'memory.decision.retire', root.projectId);
    const pending = data<Pending>(await retire(id).expect(202));
    expect(pending).toMatchObject({ permissionKey: 'memory.decision.retire', projectId: root.projectId });
    expect(pending.id).toEqual(expect.any(String));
    expect(await db.memoryItem.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'active' });
    expect(await approve(pending.id)).toMatchObject({ status: 'executed' });
    expect(await db.memoryItem.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'rejected', activeKey: null });
  });

  it('AC-8: fails an approved request when another actor retires the item first', async () => {
    const id = await record('late-retire');
    await seedWaitPolicy(db, 'memory.decision.retire', root.projectId);
    const pending = data<Pending>(await retire(id).expect(202));
    await request(server()).post(`/api/memory/${id}/retire`).set(auth(root.tokens.root)).send({}).expect(201);
    expect(await approve(pending.id)).toMatchObject({ status: 'failed', result: { error: 'execution-failed' } });
    expect(await db.memoryItem.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'rejected', activeKey: null });
  });
});
