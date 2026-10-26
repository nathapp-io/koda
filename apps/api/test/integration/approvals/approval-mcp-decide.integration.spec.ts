import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { ApprovalGate } from '../../../src/approvals/approval-gate.service';
import { ApprovalCommandRegistry } from '../../../src/approvals/approval-command.registry';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { configurableTestCommand } from '../../../src/approvals/test-helpers/test-approval-command';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { bootHttpApp, data, TEST_PASSWORD, resetThrottle } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

(canRunDbTests() ? describe : describe.skip)('MCP approval decision through authenticated HTTP', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let token: string;
  let decider: { id: string; apiKey: string };
  let openerId: string;
  let projectId: string;
  const command = configurableTestCommand('label.delete');
  const saved = process.env.MCP_ENABLED;

  const rpc = async (params: Record<string, unknown>) => {
    const res = await request(app.getHttpServer()).post('/api/mcp')
      .set('Accept', 'application/json, text/event-stream').set('Authorization', `Bearer ${decider.apiKey}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }).expect(200);
    return String(res.headers['content-type']).includes('text/event-stream')
      ? JSON.parse((res.text.split('\n').find((line) => line.startsWith('data:')) ?? '').slice(5)) : res.body;
  };

  beforeAll(async () => {
    process.env.MCP_ENABLED = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    db = fixtureDb(app);
    token = data<{ accessToken: string }>(await request(app.getHttpServer()).post('/api/auth/register')
      .send({ email: `approval-mcp-decide-${randomUUID()}@koda.test`, name: 'Root', password: TEST_PASSWORD }).expect(201)).accessToken;
    app.get(ApprovalCommandRegistry, { strict: false }).register(command.command);
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    if (saved === undefined) delete process.env.MCP_ENABLED; else process.env.MCP_ENABLED = saved;
  });
  beforeEach(async () => {
    command.reset(); resetThrottle(app);
    await db.approvalDecision.deleteMany(); await db.approvalRequest.deleteMany(); await db.approvalPolicy.deleteMany();
    const makeAgent = async (name: string) => {
      const id = randomUUID();
      const result = data<{ apiKey: string; agent: { id: string } }>(await request(app.getHttpServer()).post('/api/agents')
        .set('Authorization', `Bearer ${token}`).send({ name, slug: `${name}-${id}` }).expect(201));
      return { id: result.agent.id, apiKey: result.apiKey };
    };
    decider = await makeAgent('mcp-decider');
    const opener = await makeAgent('mcp-opener'); openerId = opener.id;
    projectId = randomUUID();
    await db.project.create({ data: { id: projectId, slug: `mcp-${projectId}`, key: projectId, name: 'P' } });
    await grantKeys(db, { type: 'AGENT', id: openerId }, ['label.delete'], projectId);
    await grantKeys(db, { type: 'AGENT', id: decider.id }, ['label.delete', 'approval.decide'], projectId);
    await app.get(PermissionCache, { strict: false }).invalidate();
  });

  it('AC-14: a REST agent decides another agent’s pending P request and the request is executed', async () => {
    const opened = await withTestActor({ type: 'AGENT', id: openerId }, () => app.get(ApprovalGate, { strict: false })
      .gate('label.delete', { labelId: randomUUID() }, { projectId }, new Date()));
    if (opened.status !== 'pending') throw new Error(`expected pending request, got ${opened.status}`);

    const answer = await rpc({ name: 'koda_decide_approval', arguments: { id: opened.request.id, decision: 'approve' } });

    expect(answer.result.isError).toBe(false);
    expect(answer.result.content[0].text).toBe(`${opened.request.id} executed`);
    const stored = await db.approvalRequest.findUniqueOrThrow({ where: { id: opened.request.id } });
    expect(stored.status).toBe('executed');
    expect(stored.actorId).toBe(openerId);
  }, 30_000);
});
