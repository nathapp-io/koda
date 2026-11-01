import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { AgentPrincipal } from '../../../src/auth/principal/koda-principal.types';
import { ApprovalGate } from '../../../src/approvals/approval-gate.service';
import { ApprovalCommandRegistry } from '../../../src/approvals/approval-command.registry';
import { ApprovalMcpTools } from '../../../src/approvals/mcp/approval-mcp-tools';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { configurableTestCommand } from '../../../src/approvals/test-helpers/test-approval-command';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { bootHttpApp, data, TEST_PASSWORD, resetThrottle } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

(canRunDbTests() ? describe : describe.skip)('Approval MCP through authenticated HTTP', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let token: string;
  let agent: { id: string; apiKey: string };
  let projectId: string;
  const labels = configurableTestCommand('label.delete');
  const saved = process.env.MCP_ENABLED;
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const res = await request(app.getHttpServer()).post('/api/mcp')
      .set('Accept', 'application/json, text/event-stream').set('Authorization', `Bearer ${agent.apiKey}`)
      .send({ jsonrpc: '2.0', id: 1, method, params }).expect(200);
    return String(res.headers['content-type']).includes('text/event-stream')
      ? JSON.parse((res.text.split('\n').find((line) => line.startsWith('data:')) ?? '').slice(5)) : res.body;
  };
  beforeAll(async () => {
    process.env.MCP_ENABLED = 'true';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    db = fixtureDb(app);
    token = data<{ accessToken: string }>(await request(app.getHttpServer()).post('/api/auth/register')
      .send({ email: 'approval-mcp@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201)).accessToken;
    app.get(ApprovalCommandRegistry, { strict: false }).register(labels.command);
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    if (saved === undefined) delete process.env.MCP_ENABLED; else process.env.MCP_ENABLED = saved;
  });
  beforeEach(async () => {
    labels.reset(); resetThrottle(app);
    await db.approvalDecision.deleteMany(); await db.approvalRequest.deleteMany(); await db.approvalPolicy.deleteMany();
    const id = randomUUID();
    const created = data<{ apiKey: string; agent: { id: string } }>(await request(app.getHttpServer()).post('/api/agents')
      .set('Authorization', `Bearer ${token}`).send({ name: id, slug: `mcp-${id}` }).expect(201));
    agent = { id: created.agent.id, apiKey: created.apiKey };
    projectId = randomUUID();
    await db.project.create({ data: { id: projectId, slug: `mcp-${projectId}`, key: projectId, name: 'P' } });
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['label.delete'], projectId);
    await app.get(PermissionCache, { strict: false }).invalidate();
  });
  it('AC-12: an agent with no decide key sees the approval tools last', async () => {
    const answer = await rpc('tools/list');
    expect(answer.result.tools.slice(-3, -1).map((tool: { name: string }) => tool.name)).toEqual(['koda_list_approvals', 'koda_decide_approval']);
    expect(answer.result.tools.at(-1)?.name).toBe('koda_retire_decision');
    expect(new Set(answer.result.tools.map((tool: { name: string }) => tool.name)).size).toBe(answer.result.tools.length);
    expect(answer.result.tools.filter((tool: { name: string }) => tool.name === 'koda_list_approvals')).toHaveLength(1);
  });
  it('AC-11 (US-004): tools/list answers exactly one koda_list_approvals, described by the approval MCP tool', async () => {
    // The agent holds the key the tool is gated by, so neither an alias nor a second descriptor of the same name
    // can appear. US-013 retired `fleet.approval.read`: a role still naming it is dropped whole, so holding it here
    // would deny the agent `project.read` too.
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read'], projectId);
    await app.get(PermissionCache, { strict: false }).invalidate();

    const listed = (await rpc('tools/list')).result.tools as Array<{ name: string; description: string }>;

    expect(listed.filter((tool) => tool.name === 'koda_list_approvals')).toHaveLength(1);
    // Permissions P3 US-004: the fleet alias is gone; the name belongs to the approval engine alone.
    expect(listed.map((tool) => tool.name)).not.toContain('koda_list_fleet_approvals');
    const engine = app.get(ApprovalMcpTools, { strict: false })
      .registrations({ id: agent.id } as AgentPrincipal)
      .find((registration) => registration.name === 'koda_list_approvals');
    expect(engine?.description).toBeDefined();
    expect(listed.find((tool) => tool.name === 'koda_list_approvals')?.description).toBe(engine?.description);
  });
  it('AC-13: the opener reads its own P request through tools/call', async () => {
    const opened = await withTestActor({ type: 'AGENT', id: agent.id }, () => app.get(ApprovalGate, { strict: false })
      .gate('label.delete', { labelId: randomUUID() }, { projectId }, new Date()));
    if (opened.status !== 'pending') throw new Error('expected pending request');
    const answer = await rpc('tools/call', { name: 'koda_list_approvals', arguments: {} });
    expect(answer.result.isError).toBe(false);
    expect(answer.result.content[0].text.split('\n')[0]).toMatch(new RegExp(`^${opened.request.id} pending label.delete project=${projectId} `));
  });
});
