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
import { PermissionService } from '../../../permissions/permission.service';
import { AssistantToolExecutor } from '../assistant-tool.executor';
import { AssistantToolRegistry } from '../assistant-tool.registry';
import type { AssistantTool } from '../assistant-tool.types';
import { McpController } from './mcp.controller';
import { mcpToolDescriptors } from './mcp-tool-catalog';

const agent = { actorType: 'agent', id: 'agent-claude', slug: 'claude' } as unknown as AgentPrincipal;
const user = { actorType: 'user', id: 'user-1' } as unknown as UserPrincipal;
const ACCEPT = 'application/json, text/event-stream';

/**
 * US-005: the two tool shapes that bypass a project key — the workspace-scope tool and the implicit key — spelled
 * as the real registry holds them; every other MCP name answers a project key, which the permission stub decides.
 */
const TOOLS_WITHOUT_PROJECT_KEY: Readonly<Record<string, { key: string; scope?: 'project' | 'workspace' }>> = {
  koda_my_projects: { key: 'project.read', scope: 'workspace' },
  koda_get_action: { key: 'assistant.action.read' },
};
const registry = {
  get: (name: string) => (TOOLS_WITHOUT_PROJECT_KEY[name] ?? { key: 'ticket.read' }) as unknown as AssistantTool,
};
/** Objects a tool no agent holds: every project key is answered as held nowhere. */
const HOLDS_NOTHING = { all: false as const, projectIds: [] as string[] };
const HOLDS_EVERYWHERE = { all: true as const };

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
  const projectIdsWithKey = vi.fn();

  async function boot(enabled: boolean): Promise<void> {
    if (enabled) process.env.MCP_ENABLED = 'true';
    else delete process.env.MCP_ENABLED;
    module = await Test.createTestingModule({
      imports: [ConfigModule.forFeature(mcpConfig)],
      controllers: [McpController],
      providers: [
        { provide: AssistantToolExecutor, useValue: { executeFor } },
        // US-005: the controller reads each tool's key from the registry and the agent's projects from the
        // permission service, so its isolated module provides both instead of the whole assistant graph.
        { provide: AssistantToolRegistry, useValue: registry },
        { provide: PermissionService, useValue: { projectIdsWithKey } },
      ],
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
    // The default: this agent holds every project key everywhere, so the listing is the whole catalog.
    projectIdsWithKey.mockReset();
    projectIdsWithKey.mockResolvedValue(HOLDS_EVERYWHERE);
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

  it('US-005: tools/list answers only the tools an agent holding no project key may see', async () => {
    projectIdsWithKey.mockResolvedValue(HOLDS_NOTHING);
    await boot(true);

    const res = await send(app, 'POST', rpc('tools/list'));

    expect(res.statusCode).toBe(200);
    expect(rpcBody(res).result.tools.map((t: { name: string }) => t.name)).toEqual(['koda_my_projects', 'koda_get_action']);
    // One read per distinct key: the workspace tool and the implicit key take no project at all.
    const keysAsked = projectIdsWithKey.mock.calls.map(([, key]) => key as string);
    expect(keysAsked).not.toContain('project.read');
    expect(keysAsked).not.toContain('assistant.action.read');
    expect(new Set(keysAsked).size).toBe(keysAsked.length);
  });

  it('US-005: a call to a tool the agent does not hold answers the SDK unknown-tool error, never the executor', async () => {
    projectIdsWithKey.mockResolvedValue(HOLDS_NOTHING);
    await boot(true);

    const res = await send(app, 'POST', rpc('tools/call', { name: 'koda_dispatch_job', arguments: { project: 'web' } }));

    expect(res.statusCode).toBe(200);
    expect(rpcBody(res).error).toMatchObject({ code: -32602, message: 'Tool koda_dispatch_job not found' });
    expect(executeFor).not.toHaveBeenCalled();
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

  it('B1: a malformed `project` reaches executeFor, whose exact answer the client reads, and the schema stays advertised', async () => {
    await boot(true);
    executeFor.mockResolvedValue({ content: 'invalid_input: project', isError: true });

    const list = rpcBody(await send(app, 'POST', rpc('tools/list'))).result.tools as Array<{ name: string; inputSchema: { required?: string[] } }>;
    const advertised = list.find((t) => t.name === 'koda_get_ticket') as { name: string; inputSchema: { required?: string[] } };
    expect(advertised.inputSchema).toEqual(mcpToolDescriptors().find((d) => d.name === 'koda_get_ticket')?.inputSchema);
    expect(advertised.inputSchema.required).toContain('project');

    const res = await send(app, 'POST', rpc('tools/call', { name: 'koda_get_ticket', arguments: { project: 'BAD' } }));

    expect(res.statusCode).toBe(200);
    expect(executeFor).toHaveBeenCalledWith(
      expect.objectContaining({ origin: { kind: 'mcp' } }),
      { name: 'koda_get_ticket', input: { project: 'BAD' } },
    );
    expect(rpcBody(res).result).toEqual({ content: [{ type: 'text', text: 'invalid_input: project' }], isError: true });
  });

  it('B1: a call with no arguments at all reaches executeFor', async () => {
    await boot(true);

    const res = await send(app, 'POST', rpc('tools/call', { name: 'koda_get_ticket' }));

    expect(res.statusCode).toBe(200);
    expect(executeFor).toHaveBeenCalledWith(expect.objectContaining({ origin: { kind: 'mcp' } }), { name: 'koda_get_ticket', input: {} });
    expect(rpcBody(res).result).toMatchObject({ isError: false });
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
