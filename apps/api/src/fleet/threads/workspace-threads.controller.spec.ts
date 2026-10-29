import { Test, type TestingModule } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { GlobalExceptionsFilter } from '@nathapp/nestjs-common';
import { WorkspaceThreadsController } from './workspace-threads.controller';
import { WorkspaceThreadsService } from './workspace-threads.service';
import { PermissionService } from '../../permissions/permission.service';
import { validateCreateWorkspaceThread } from './thread-input';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';

// Principal injection reads request.user, as CombinedAuthGuard does in production.
describe('WorkspaceThreadsController gated stop', () => {
  it('AC-8: pre-reads the owned thread and gates stop in its home project', async () => {
    const thread = { id: 't1', projectId: 'p1' };
    const service = { requireOwnedThread: vi.fn().mockResolvedValue(thread), stop: vi.fn() };
    const routeGate = { run: vi.fn().mockResolvedValue({ status: 'executed', result: {} }) };
    const controller = new WorkspaceThreadsController(service as unknown as WorkspaceThreadsService, routeGate as unknown as ApprovalRouteGate);
    const principal = { actorType: 'agent', id: 'a1' } as never;

    await controller.stop('t1', principal);

    expect(service.requireOwnedThread).toHaveBeenCalledWith('a1', 't1');
    expect(routeGate.run).toHaveBeenCalledWith({ key: 'thread.stop', variant: 'rest:workspace-threads.stop', projectId: 'p1', input: { id: 't1' } });
  });
});
describe('workspace POST body whitelist', () => {
  let app: NestFastifyApplication;
  let module: TestingModule;
  let service: { create: ReturnType<typeof vi.fn> };
  beforeEach(async () => {
    service = { create: vi.fn(async (_principal, dto) => validateCreateWorkspaceThread(dto)) };
    module = await Test.createTestingModule({
      controllers: [WorkspaceThreadsController],
      providers: [
        { provide: WorkspaceThreadsService, useValue: service },
        { provide: ApprovalRouteGate, useValue: { run: vi.fn(async (call: { input: { thread: unknown } }) => ({ status: 'executed', result: await service.create({ actorType: 'user', id: 'u', role: 'MEMBER' }, call.input.thread) })) } },
        // US-003: the routes carry `RequiresGuard`, which reads the global PermissionService.
        { provide: PermissionService, useValue: { can: vi.fn(async () => ({ allowed: true, reason: 'granted' })) } },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new GlobalExceptionsFilter(app.get(HttpAdapterHost)));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.getHttpAdapter().getInstance().addHook('preHandler', async (req: { user?: unknown }) => { req.user = { actorType: 'user', id: 'u', role: 'MEMBER' }; });
    await app.init(); await app.getHttpAdapter().getInstance().ready();
  });
  afterEach(async () => { await app?.close(); });
  it('AC-5: retains repoId for domain validation', async () => {
    const res = await app.inject({ method: 'POST', url: '/threads', payload: { title: 't', backend: { kind: 'native' }, repoId: 'r1' } });
    expect(res.statusCode).toBe(400);
  });
});
