import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { resetDb } from '../../helpers/reset-db';
import { rosterFleetAgent, seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';

const integration = canRunDbTests() ? describe : describe.skip;
integration('MCP writes through ApprovalGate (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let agent: { id: string; apiKey: string };
  let ticket: { id: string; number: number };
  let number = 700;
  const saved = process.env.MCP_ENABLED;
  const call = async (name: string, args: Record<string, unknown>, token = agent.apiKey) => {
    const response = await request(app.getHttpServer()).post('/api/mcp')
      .set('Accept', 'application/json, text/event-stream').set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { project: 'web', ...args } } }).expect(200);
    const rpc = String(response.headers['content-type']).includes('text/event-stream')
      ? JSON.parse((response.text.split('\n').find(line => line.startsWith('data:')) ?? '').slice(5)) : response.body;
    expect(rpc.error).toBeUndefined();
    return { content: rpc.result.content.map((part: { text: string }) => part.text).join('\n') as string, isError: rpc.result.isError as boolean };
  };
  const write = () => call('koda_add_comment', { ref: `WEB-${ticket.number}`, body: 'MCP gated comment' });
  const policy = () => db.approvalPolicy.create({ data: {
    selector: `${world.projectId}|comment.create|type:AGENT`, projectId: world.projectId,
    permissionPattern: 'comment.create', principalType: 'AGENT', mode: 'agent',
    updatedByType: 'SYSTEM', updatedById: 'test',
  } });
  beforeAll(async () => {
    process.env.MCP_ENABLED = 'true';
    await resetDb(); app = await bootHttpApp({ registrationEnabled: false }); db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
  }, 120_000);
  beforeEach(async () => {
    await db.approvalPolicy.deleteMany();
    agent = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    await rosterFleetAgent(db, agent.id, world.projectId);
    ticket = await db.ticket.create({ data: { projectId: world.projectId, number: ++number, title: 'MCP gate ticket', type: 'TASK' } });
  });
  afterAll(async () => {
    try { await app?.close(); } finally {
      if (saved === undefined) delete process.env.MCP_ENABLED; else process.env.MCP_ENABLED = saved;
    }
  });
  it('AC-1,2: default none writes as the agent, returns only tool text and opens no request', async () => {
    const answer = await write();
    const comment = await db.comment.findFirstOrThrow({ where: { ticketId: ticket.id } });
    expect(comment).toMatchObject({ authorAgentId: agent.id, authorUserId: null, body: 'MCP gated comment' });
    expect(answer).toEqual({ content: `comment ${comment.id} added to WEB-${ticket.number} /web/tickets/WEB-${ticket.number}`, isError: false });
    expect(await db.approvalRequest.count({ where: { actorId: agent.id } })).toBe(0);
    expect(await db.assistantActionRequest.count()).toBe(0);
  });
  it('AC-3..9: agent policy freezes own input without a link or comment, deduplicates retries and scopes reads', async () => {
    await policy();
    const answer = await write();
    const requests = await db.approvalRequest.findMany({ where: { actorId: agent.id }, take: 10 });
    expect(requests).toHaveLength(1);
    const pending = requests[0];
    if (!pending) throw new Error('expected one pending request');
    expect(pending).toMatchObject({ actorType: 'AGENT', actorId: agent.id, onBehalfOfType: null, onBehalfOfId: null, origin: 'mcp', permissionKey: 'comment.create', status: 'pending', requiredMode: 'agent', input: { projectId: world.projectId, threadId: null, jobId: null, args: { ref: `WEB-${ticket.number}`, body: 'MCP gated comment' } } });
    expect(answer).toEqual({ content: `pending ${pending.id}: awaiting approval; do not retry`, isError: false });
    expect(await db.comment.count({ where: { ticketId: ticket.id } })).toBe(0);
    expect(await db.assistantActionRequest.count({ where: { requestId: pending.id } })).toBe(0);
    expect(await write()).toEqual(answer);
    expect(await db.approvalRequest.count({ where: { actorId: agent.id } })).toBe(1);
    const own = await call('koda_get_action', { id: pending.id });
    expect(own.isError).toBe(false);
    expect(own.content.split('\n')).toEqual([`action ${pending.id} comment.create pending`, `requested ${pending.createdAt.toISOString()}`]);
    const other = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    await rosterFleetAgent(db, other.id, world.projectId);
    expect(await call('koda_get_action', { id: pending.id }, other.apiKey)).toEqual({ content: 'not_found', isError: true });
  });
  it('AC-10: a missing ticket is refused by preview before opening a request', async () => {
    await policy();
    expect(await call('koda_add_comment', { ref: 'WEB-999999', body: 'missing' })).toEqual({ content: 'not_found', isError: true });
    expect(await db.approvalRequest.count({ where: { actorId: agent.id } })).toBe(0);
  });
});
