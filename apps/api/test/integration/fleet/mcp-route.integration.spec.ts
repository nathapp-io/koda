/**
 * Fleet S5b US-007 — `POST|GET|DELETE /api/mcp` end to end (PG): the real guard chain authenticates the agent key,
 * the real executor runs the tool, and the rows the write tools leave are read back through Prisma.
 *
 * `claude` is an agent created through `POST /api/agents` and rostered on `web` only. A 2025-era client is answered
 * as one SSE event, so the JSON-RPC body is read from the `data:` line.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/fleet/mcp-route.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { AssistantToolExecutor } from '../../../src/fleet/assistant/assistant-tool.executor';
import { mcpToolDescriptors } from '../../../src/fleet/assistant/mcp/mcp-tool-catalog';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
vi.setConfig({ testTimeout: 20_000 });
const ACCEPT = 'application/json, text/event-stream';

interface ToolAnswer { isError: boolean; content: Array<{ type: string; text: string }> }
const textOf = (answer: ToolAnswer) => answer.content.map((c) => c.text).join('\n');

describeIntegration('MCP route (PG, US-007)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let claude: { id: string; slug: string; apiKey: string };
  let webTicket: { id: string; number: number };
  const saved = process.env.MCP_ENABLED;

  const mcp = (token: string | undefined, payload: unknown) => {
    const call = request(app.getHttpServer()).post('/api/mcp').set('Accept', ACCEPT);
    return (token ? call.set('Authorization', `Bearer ${token}`) : call).send(payload as object);
  };
  const rpc = (method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id: 1, method, params });
  const body = (res: request.Response) => {
    const sse = String(res.headers['content-type']).includes('text/event-stream');
    const dataLine = res.text.split('\n').find((l) => l.startsWith('data:')) ?? '';
    return sse ? JSON.parse(dataLine.slice(5)) : res.body;
  };
  const callTool = async (name: string, args: Record<string, unknown>): Promise<ToolAnswer> => {
    const res = await mcp(claude.apiKey, rpc('tools/call', { name, arguments: args })).expect(200);
    return body(res).result as ToolAnswer;
  };

  async function boot(enabled: boolean): Promise<void> {
    await app?.close();
    if (enabled) process.env.MCP_ENABLED = 'true';
    else delete process.env.MCP_ENABLED;
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
  }

  beforeAll(async () => {
    await resetDb();
    await boot(true);
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    claude = await seedFleetHttpAgent(app.getHttpServer(), world.tokens.root);
    await prisma.agentProject.create({ data: { projectId: world.projectId, agentId: claude.id } });
    webTicket = await prisma.ticket.create({ data: { projectId: world.projectId, number: 501, type: 'TASK', title: 'MCP route ticket' } });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    if (saved === undefined) delete process.env.MCP_ENABLED;
    else process.env.MCP_ENABLED = saved;
  });

  it('AC-3: answers 401 with no Authorization header', async () => {
    await mcp(undefined, rpc('tools/list')).expect(401);
  });

  it('AC-2: answers 403 to a user JWT bearer', async () => {
    await mcp(world.tokens.dev, rpc('tools/list')).expect(403);
  });

  it('AC-4: initialize answers serverInfo.name koda', async () => {
    const res = await mcp(claude.apiKey, rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'it', version: '1' } })).expect(200);

    expect(body(res).result.serverInfo.name).toBe('koda');
  });

  it('AC-5: tools/list answers the MCP descriptor names', async () => {
    const res = await mcp(claude.apiKey, rpc('tools/list')).expect(200);

    expect(body(res).result.tools.map((t: { name: string }) => t.name)).toEqual(mcpToolDescriptors().map((d) => d.name));
  });

  it('AC-6: koda_search_tickets on web answers a ticket of web', async () => {
    const answer = await callTool('koda_search_tickets', { project: 'web' });

    expect(answer.isError).toBe(false);
    expect(textOf(answer)).toContain(`WEB-${webTicket.number}`);
  });

  it('AC-7: koda_search_tickets on an unrostered project answers not_found: project', async () => {
    const answer = await callTool('koda_search_tickets', { project: 'ops' });

    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toBe('not_found: project');
  });

  it('AC-8, AC-9: koda_add_comment runs at once, names a none-mode action and stores the agent comment', async () => {
    const answer = await callTool('koda_add_comment', { project: 'web', ref: `WEB-${webTicket.number}`, body: 'via mcp' });

    expect(answer.isError).toBe(false);
    const actionId = /action (\S+)$/.exec(textOf(answer))?.[1];
    expect(actionId).toBeDefined();
    const action = await prisma.pendingAction.findUniqueOrThrow({ where: { id: actionId } });
    expect(action.approvalMode).toBe('none');
    const comment = await prisma.comment.findFirstOrThrow({ where: { ticketId: webTicket.id, body: 'via mcp' } });
    expect(comment.authorAgentId).toBe(claude.id);
  });

  it('AC-10, AC-11: koda_dispatch_job is refused for the agent and leaves no job or action', async () => {
    const feature = 'mcp-route-us007-dispatch';
    const answer = await callTool('koda_dispatch_job', { project: 'web', repo: 'acme/app', command: 'RUN', feature, maxCostUsd: 0.5 });

    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toBe('forbidden: koda_dispatch_job needs create FleetJob on web');
    expect(await prisma.fleetJob.count({ where: { feature } })).toBe(0);
    expect(await prisma.pendingAction.count({ where: { actorId: claude.id, tool: 'koda_dispatch_job' } })).toBe(0);
  });

  it('AC-12: the executor receives the agent principal and an mcp origin', async () => {
    const executeFor = vi.spyOn(app.get(AssistantToolExecutor, { strict: false }), 'executeFor');
    try {
      await callTool('koda_get_ticket', { project: 'web', ref: `WEB-${webTicket.number}` });

      const [caller] = executeFor.mock.calls[0] ?? [];
      expect(caller?.principal.id).toBe(claude.id);
      expect(caller?.origin).toEqual({ kind: 'mcp' });
    } finally {
      executeFor.mockRestore();
    }
  });

  it('AC-13: GET answers 405 for an agent key', async () => {
    await request(app.getHttpServer()).get('/api/mcp').set('Accept', ACCEPT).set('Authorization', `Bearer ${claude.apiKey}`).expect(405);
  });

  it('AC-1: answers 409 with MCP_ENABLED unset', async () => {
    await boot(false);

    await mcp(claude.apiKey, rpc('tools/list')).expect(409);
  });
});
