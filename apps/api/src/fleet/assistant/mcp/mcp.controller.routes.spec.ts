/**
 * US-007 — the MCP route over a real Fastify server (no database): the principal is injected by a global test guard
 * that stands in for CombinedAuthGuard, and the executor is a stub, so the refusals, the SDK wiring and the caller
 * the executor receives are driven end to end. The DB-backed counterpart is
 * test/integration/fleet/mcp-route.integration.spec.ts.
 */
import { CanActivate, ExecutionContext } from '@nestjs/common';
import { IncomingMessage } from 'http';
import { Socket } from 'net';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { mcpConfig } from '../../../config/mcp.config';
import { restoreEnvAfterEach } from '../../../common/test-helpers/restore-env';
import type { AgentPrincipal, KodaPrincipal, UserPrincipal } from '../../../auth/principal/koda-principal.types';
import { AssistantToolExecutor } from '../assistant-tool.executor';
import { McpController } from './mcp.controller';
import { mcpToolDescriptors } from './mcp-tool-catalog';

const agent = { actorType: 'agent', id: 'agent-claude', slug: 'claude' } as unknown as AgentPrincipal;
const user = { actorType: 'user', id: 'user-1' } as unknown as UserPrincipal;
const ACCEPT = 'application/json, text/event-stream';

/** Fastify's in-process `inject`: no socket, so it runs where local port binding is off. */
const send = (app: NestFastifyApplication, method: 'POST' | 'GET' | 'DELETE', payload?: unknown) =>
  app.inject({ method, url: '/api/mcp', headers: { accept: ACCEPT }, ...(payload === undefined ? {} : { payload: payload as object }) });

/** A 2025-era client is answered as one SSE event (`data: <json>`); a JSON body is read as is. */
const rpcBody = (res: { body: string; headers: Record<string, unknown> }) => {
  const text = String(res.headers['content-type']).includes('text/event-stream')
    ? res.body.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim() ?? ''
    : res.body;
  return JSON.parse(text);
};

const rpc = (method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id: 1, method, params });

describe('McpController routes', () => {
  restoreEnvAfterEach();
  let module: TestingModule;
  let app: NestFastifyApplication;
  let currentPrincipal: KodaPrincipal | undefined;
  const executeFor = vi.fn();

  async function boot(enabled: boolean): Promise<void> {
    if (enabled) process.env.MCP_ENABLED = 'true';
    else delete process.env.MCP_ENABLED;
    module = await Test.createTestingModule({
      imports: [ConfigModule.forFeature(mcpConfig)],
      controllers: [McpController],
      providers: [{ provide: AssistantToolExecutor, useValue: { executeFor } }],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    const principalInjector: CanActivate = {
      canActivate: (ctx: ExecutionContext) => {
        ctx.switchToHttp().getRequest<{ user?: KodaPrincipal }>().user = currentPrincipal;
        return true;
      },
    };
    app.useGlobalGuards(principalInjector);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }

  beforeEach(() => {
    currentPrincipal = agent;
    executeFor.mockReset();
    executeFor.mockResolvedValue({ content: 'found WEB-1', isError: false });
  });

  afterEach(async () => {
    await app?.close();
  });

  it('AC-1: answers 409 when MCP_ENABLED is unset', async () => {
    await boot(false);

    expect((await send(app, 'POST', rpc('tools/list'))).statusCode).toBe(409);
  });

  it('AC-2: answers 403 to a user principal', async () => {
    await boot(true);
    currentPrincipal = user;

    expect((await send(app, 'POST', rpc('tools/list'))).statusCode).toBe(403);
  });

  it('AC-4: initialize answers 200 with serverInfo.name koda', async () => {
    await boot(true);

    const res = await send(app, 'POST', rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } }));

    expect(res.statusCode).toBe(200);
    expect(rpcBody(res).result.serverInfo.name).toBe('koda');
  });

  it('AC-5: tools/list answers the MCP descriptor names', async () => {
    await boot(true);

    const res = await send(app, 'POST', rpc('tools/list'));

    expect(res.statusCode).toBe(200);
    expect(rpcBody(res).result.tools.map((t: { name: string }) => t.name)).toEqual(mcpToolDescriptors().map((d) => d.name));
  });

  it('AC-12: tools/call reaches executeFor with the agent principal and an mcp origin, and answers its result', async () => {
    await boot(true);

    const res = await send(app, 'POST', rpc('tools/call', { name: 'koda_get_ticket', arguments: { project: 'web', ref: 'WEB-1' } }));

    expect(res.statusCode).toBe(200);
    expect(executeFor).toHaveBeenCalledWith(
      expect.objectContaining({ principal: expect.objectContaining({ id: agent.id }), origin: { kind: 'mcp' } }),
      { name: 'koda_get_ticket', input: { project: 'web', ref: 'WEB-1' } },
    );
    expect(rpcBody(res).result).toMatchObject({ isError: false, content: [{ type: 'text', text: 'found WEB-1' }] });
  });

  it('AC-13: GET and DELETE answer 405 from the SDK', async () => {
    await boot(true);

    expect((await send(app, 'GET')).statusCode).toBe(405);
    expect((await send(app, 'DELETE')).statusCode).toBe(405);
  });

  it('serves an Express-shaped request (no `raw`, body already parsed), as the integration app boots', async () => {
    await boot(true);
    const controller = module.get(McpController);
    const incoming = new IncomingMessage(new Socket());
    Object.assign(incoming, {
      method: 'POST',
      url: '/api/mcp',
      headers: { host: 'localhost', accept: ACCEPT, 'content-type': 'application/json' },
      body: rpc('tools/list'),
    });
    const sent: { status?: number; headers: Record<string, string>; payload?: Buffer } = { headers: {} };
    const reply = {
      header: (k: string, v: string) => { sent.headers[k] = v; },
      status: (code: number) => { sent.status = code; },
      send: (payload: Buffer) => { sent.payload = payload; },
    };

    await controller.post(agent, incoming as never, reply);

    expect(sent.status).toBe(200);
    expect(rpcBody({ body: String(sent.payload), headers: sent.headers }).result.tools).toHaveLength(mcpToolDescriptors().length);
  });

  it('serves an Express-shaped GET whose parsed body is an empty object with a 405', async () => {
    await boot(true);
    const incoming = new IncomingMessage(new Socket());
    Object.assign(incoming, { method: 'GET', url: '/api/mcp', headers: { host: 'localhost', accept: ACCEPT }, body: {} });
    const sent: { status?: number } = {};
    const reply = { header: () => undefined, status: (code: number) => { sent.status = code; }, send: () => undefined };

    await module.get(McpController).get(agent, incoming as never, reply);

    expect(sent.status).toBe(405);
  });
});
