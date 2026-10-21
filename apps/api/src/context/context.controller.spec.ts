import type { Mock } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { REQUIRES_METADATA } from '../permissions/requires.decorator';
import { ContextController } from './context.controller';
import { ContextBuilderService } from './context-builder.service';
import { PermissionService } from '../permissions/permission.service';
import { RequiresGuard } from '../permissions/requires.guard';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import type { ProjectContext } from '../projects/project-context';

const makeContextResponse = () => ({
  projectId: 'project-1',
  canonicalState: { tickets: [], recentEvents: [], activeDecisions: [] },
  retrievedContext: { documents: { results: [], scores: [], retrievedAt: new Date().toISOString() }, semanticMemory: [] },
  provenance: { sources: [], retrievalStrategy: 'canonical-only' },
  meta: { intent: 'answer', tokensUsed: 100, retrievedAt: new Date(), latencyMs: 50 },
});

const adminUser: KodaPrincipal = {
  actorType: 'user',
  id: 'user-admin',
  email: 'admin@example.com',
  name: 'admin@example.com',
  role: 'ADMIN',
  blacklisted: false,
  revoked: false,
  authorities: ['ADMIN'],
};

const memberUser: KodaPrincipal = {
  actorType: 'user',
  id: 'user-member',
  email: 'member@example.com',
  name: 'member@example.com',
  role: 'MEMBER',
  blacklisted: false,
  revoked: false,
  authorities: ['MEMBER'],
};

const agentPrincipal: KodaPrincipal = {
  actorType: 'agent',
  id: 'agent-1',
  name: 'test-agent',
  slug: 'test-agent',
  status: 'ACTIVE',
  agentRoles: ['DEVELOPER'],
  capabilities: [],
  blacklisted: false,
  revoked: false,
  authorities: ['WORKER'],
};

const projectContext: ProjectContext = {
  project: { id: 'project-1', slug: 'my-project' },
  role: 'ADMIN',
};

describe('ContextController route authorization metadata', () => {
  it.each([
    [ContextController.prototype.getContext, 'context.read'],
    [ContextController.prototype.queryContext, 'context.query'],
  ])('declares %s with ordered project and permission guards', (handler, key) => {
    expect(Reflect.getMetadata(REQUIRES_METADATA, handler)).toMatchObject({ keys: [key] });
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([
      ProjectMembershipGuard,
      RequiresGuard,
    ]);
  });
});

describe('ContextController', () => {
  let controller: ContextController;
  let contextBuilderService: { getProjectContext: Mock };
  let permissions: { can: Mock };
  let module: TestingModule;

  beforeEach(async () => {
    contextBuilderService = {
      getProjectContext: vi.fn().mockResolvedValue(makeContextResponse()),
    };
    permissions = { can: vi.fn().mockResolvedValue({ allowed: true }) };

    module = await Test.createTestingModule({
      controllers: [ContextController],
      providers: [
        { provide: ContextBuilderService, useValue: contextBuilderService },
        { provide: PermissionService, useValue: permissions },
      ],
    })
      .overrideGuard(RequiresGuard)
      .useValue({ canActivate: vi.fn().mockResolvedValue(true) })
      .overrideGuard(ProjectMembershipGuard)
      .useValue({ canActivate: vi.fn().mockResolvedValue(true) })
      .compile();

    controller = module.get(ContextController);
  });

  afterEach(async () => {
    await module.close();
  });

  describe('GET /context/:slug — getContext', () => {
    it('uses the guarded project id and principal id to build context', async () => {
      const result = await controller.getContext({ intent: 'answer' }, adminUser, projectContext);

      expect(contextBuilderService.getProjectContext).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-1', actorId: 'user-admin' }),
      );
      expect(result).toMatchObject({ data: expect.objectContaining({ projectId: 'project-1' }) });
    });

    it('passes intent and optional query fields through', async () => {
      await controller.getContext(
        { intent: 'diagnose', query: 'auth flow', ticketIds: ['t-1'], repoRefs: ['sha-1'] },
        adminUser,
        projectContext,
      );

      expect(contextBuilderService.getProjectContext).toHaveBeenCalledWith(
        expect.objectContaining({
          intent: 'diagnose',
          query: 'auth flow',
          ticketIds: ['t-1'],
          repoRefs: ['sha-1'],
        }),
      );
    });

    it('parses tokenBudget and keeps it undefined when omitted', async () => {
      await controller.getContext({ intent: 'answer', tokenBudget: '2000' as unknown as number }, adminUser, projectContext);
      expect(contextBuilderService.getProjectContext).toHaveBeenLastCalledWith(
        expect.objectContaining({ tokenBudget: 2000 }),
      );

      await controller.getContext({ intent: 'answer' }, adminUser, projectContext);
      expect(contextBuilderService.getProjectContext).toHaveBeenLastCalledWith(
        expect.objectContaining({ tokenBudget: undefined }),
      );
    });

    it('returns the context in a JsonResponse.Ok envelope', async () => {
      const result = await controller.getContext({ intent: 'answer' }, adminUser, projectContext);
      expect(result).toMatchObject({ data: expect.objectContaining({ projectId: 'project-1' }) });
    });
  });

  describe('POST /context/:slug/query — queryContext', () => {
    it('uses the guarded project id and principal id and passes body fields', async () => {
      const body = { intent: 'search' as const, query: 'ticket bugs', ticketIds: ['t-2'] };
      const result = await controller.queryContext(body, memberUser, projectContext);

      expect(contextBuilderService.getProjectContext).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-1',
          actorId: 'user-member',
          intent: 'search',
          query: 'ticket bugs',
          ticketIds: ['t-2'],
        }),
      );
      expect(result).toBeDefined();
    });

    it('allows an agent principal to act as the context actor', async () => {
      await controller.queryContext({ intent: 'plan' }, agentPrincipal, projectContext);
      expect(contextBuilderService.getProjectContext).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-1', actorId: 'agent-1', intent: 'plan' }),
      );
    });

    it('returns the context in a JsonResponse.Ok envelope', async () => {
      const result = await controller.queryContext({ intent: 'answer' }, adminUser, projectContext);
      expect(result).toMatchObject({ data: expect.objectContaining({ projectId: 'project-1' }) });
    });
  });
});
