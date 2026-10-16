import { Test, type TestingModule } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { GlobalExceptionsFilter } from '@nathapp/nestjs-common';
import { WorkspaceThreadsController } from './workspace-threads.controller';
import { WorkspaceThreadsService } from './workspace-threads.service';
import { validateCreateWorkspaceThread } from './thread-input';

// Principal injection reads request.user, as CombinedAuthGuard does in production.
describe('workspace POST body whitelist', () => {
  let app: NestFastifyApplication;
  let module: TestingModule;
  beforeEach(async () => {
    module = await Test.createTestingModule({ controllers: [WorkspaceThreadsController], providers: [{ provide: WorkspaceThreadsService, useValue: { create: vi.fn(async (_principal, dto) => validateCreateWorkspaceThread(dto)) } }] }).compile();
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
