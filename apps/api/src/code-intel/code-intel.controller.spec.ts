import type { Mock, Mocked } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { CodeIntelController } from './code-intel.controller';
import { AstIndexService, SymbolIndexResult, Symbol } from './ast-index.service';
import { CallerInfo, CalleeInfo } from './symbol-store';
import { UserPrincipal, AgentPrincipal } from '../auth/principal/koda-principal.types';
import { IndexCommitDto, SourceFileDto } from './dto/index-commit.dto';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectContext } from '../projects/project-context';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdminUser(): UserPrincipal {
  return {
    actorType: 'user',
    id: 'user-admin',
    role: 'ADMIN',
    email: 'admin@example.com',
    blacklisted: false,
    revoked: false,
    authorities: ['ADMIN'],
    extra: {},
  } as unknown as UserPrincipal;
}

function makeMemberUser(id = 'user-member'): UserPrincipal {
  return {
    actorType: 'user',
    id,
    role: 'MEMBER',
    email: 'member@example.com',
    blacklisted: false,
    revoked: false,
    authorities: ['MEMBER'],
    extra: {},
  } as unknown as UserPrincipal;
}

function makeAgent(): AgentPrincipal {
  return {
    actorType: 'agent',
    id: 'agent-1',
    slug: 'my-agent',
    status: 'ACTIVE',
    agentRoles: ['DEVELOPER'],
    capabilities: [],
    blacklisted: false,
    revoked: false,
    authorities: [],
    extra: {},
  } as unknown as AgentPrincipal;
}

function makeProject(id = 'proj-1', slug = 'my-project') {
  return { id, slug };
}

/**
 * Slice 4: the read routes receive the ProjectContext the project guard
 * resolved (project membership and role are asserted by ProjectMembershipGuard,
 * covered by project-membership.guard.spec.ts and the integration specs).
 */
function makeCtx(id = 'proj-1', slug = 'my-project', role: string | null = 'ADMIN'): ProjectContext {
  return { project: makeProject(id, slug), role };
}

function makeIndexResult(): SymbolIndexResult {
  return {
    commitHash: 'abc123',
    symbolsIndexed: 1,
    filesIndexed: 1,
    fileErrors: [],
    durationMs: 10,
  };
}

function makeSymbol(): Symbol {
  return {
    id: 'repo-1:src/a.ts::Foo',
    symbolId: 'repo-1:src/a.ts::Foo',
    projectId: 'proj-1',
    repoId: 'repo-1',
    commitHash: 'abc123',
    name: 'Foo',
    kind: 'function',
    file: 'src/a.ts',
    startLine: 1,
    endLine: 5,
    callers: [],
    callees: [],
  };
}

function makeDto(overrides: Partial<IndexCommitDto> = {}): IndexCommitDto {
  const dto = new IndexCommitDto();
  dto.repoId = 'repo-1';
  dto.commitHash = 'abc123';
  dto.projectSlug = 'my-project';
  dto.files = [{ path: 'src/a.ts', content: 'const x = 1;' } as SourceFileDto];
  return { ...dto, ...overrides };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('CodeIntelController', () => {
  let controller: CodeIntelController;
  let astIndexService: Mocked<Pick<AstIndexService, 'indexCommit' | 'getSymbol' | 'getCallers' | 'getCallees'>>;

  // ProjectAccessService mock — provides findProjectIdBySlug and assertProjectMembership
  let mockFindProjectIdBySlug: Mock;
  let mockAssertProjectMembership: Mock;
  let mockProjectAccessService: Mocked<Pick<ProjectAccessService, 'findProjectIdBySlug' | 'assertProjectMembership'>>;

  beforeEach(async () => {
    mockFindProjectIdBySlug = vi.fn();
    mockAssertProjectMembership = vi.fn();

    mockProjectAccessService = {
      findProjectIdBySlug: mockFindProjectIdBySlug,
      assertProjectMembership: mockAssertProjectMembership,
    };

    astIndexService = {
      indexCommit: vi.fn(),
      getSymbol: vi.fn(),
      getCallers: vi.fn(),
      getCallees: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CodeIntelController],
      providers: [
        { provide: AstIndexService, useValue: astIndexService },
        { provide: ProjectAccessService, useValue: mockProjectAccessService },
      ],
    }).compile();

    controller = module.get<CodeIntelController>(CodeIntelController);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // indexCommit
  // -------------------------------------------------------------------------

  describe('indexCommit()', () => {
    it('returns JsonResponse.Ok wrapping the indexing result for an admin user', async () => {
      mockFindProjectIdBySlug.mockResolvedValue('proj-1');
      mockAssertProjectMembership.mockResolvedValue(undefined);
      astIndexService.indexCommit.mockResolvedValue(makeIndexResult());

      const result = await controller.indexCommit(makeDto(), makeAdminUser());

      expect(result.data).toMatchObject({ commitHash: 'abc123', symbolsIndexed: 1 });
      expect(astIndexService.indexCommit).toHaveBeenCalledWith(
        'repo-1',
        'abc123',
        expect.any(Array),
        'proj-1',
      );
    });

    it('returns JsonResponse.Ok for an agent principal', async () => {
      mockFindProjectIdBySlug.mockResolvedValue('proj-1');
      mockAssertProjectMembership.mockResolvedValue(undefined);
      astIndexService.indexCommit.mockResolvedValue(makeIndexResult());

      const result = await controller.indexCommit(makeDto(), makeAgent());

      expect(result.data).toBeDefined();
    });

    it('throws NotFoundAppException when project slug does not exist', async () => {
      mockFindProjectIdBySlug.mockRejectedValue(new NotFoundAppException({}, 'projects'));

      await expect(
        controller.indexCommit(makeDto({ projectSlug: 'missing-slug' }), makeAdminUser()),
      ).rejects.toBeInstanceOf(NotFoundAppException);
    });

    it('throws ForbiddenAppException when MEMBER user is not a project member', async () => {
      mockFindProjectIdBySlug.mockResolvedValue('proj-1');
      mockAssertProjectMembership.mockRejectedValue(new ForbiddenAppException({}, 'code-intel'));

      await expect(
        controller.indexCommit(makeDto(), makeMemberUser()),
      ).rejects.toBeInstanceOf(ForbiddenAppException);
    });

    it('allows MEMBER user who has project membership', async () => {
      mockFindProjectIdBySlug.mockResolvedValue('proj-1');
      mockAssertProjectMembership.mockResolvedValue(undefined);
      astIndexService.indexCommit.mockResolvedValue(makeIndexResult());

      const result = await controller.indexCommit(makeDto(), makeMemberUser());

      expect(result.data).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // getSymbol
  // -------------------------------------------------------------------------

  describe('getSymbol()', () => {
    it('returns JsonResponse.Ok with symbol data for the guarded project', async () => {
      astIndexService.getSymbol.mockResolvedValue(makeSymbol());

      const result = await controller.getSymbol('repo-1:src/a.ts::Foo', makeCtx());

      const sym = result.data as import('./ast-index.service').Symbol;
      expect(sym.name).toBe('Foo');
      expect(astIndexService.getSymbol).toHaveBeenCalledWith('proj-1', 'repo-1:src/a.ts::Foo');
    });

    it('throws NotFoundAppException when symbol is not found', async () => {
      astIndexService.getSymbol.mockResolvedValue(null);

      await expect(
        controller.getSymbol('nonexistent', makeCtx()),
      ).rejects.toBeInstanceOf(NotFoundAppException);
    });

    it('uses the project id from the guard-resolved ProjectContext', async () => {
      astIndexService.getSymbol.mockResolvedValue(makeSymbol());

      await controller.getSymbol('sym-id', makeCtx('proj-9', 'other'));

      expect(astIndexService.getSymbol).toHaveBeenCalledWith('proj-9', 'sym-id');
    });
  });

  // -------------------------------------------------------------------------
  // getCallers
  // -------------------------------------------------------------------------

  describe('getCallers()', () => {
    it('returns JsonResponse.Ok with caller list for the guarded project', async () => {
      const callers: CallerInfo[] = [{ symbolId: 'other', file: 'src/b.ts', name: 'bar', kind: 'function' }];
      astIndexService.getCallers.mockResolvedValue(callers);

      const result = await controller.getCallers('my-sym', makeCtx());

      expect(result.data).toEqual(callers);
      expect(astIndexService.getCallers).toHaveBeenCalledWith('proj-1', 'my-sym');
    });

    it('returns empty array when no callers exist', async () => {
      astIndexService.getCallers.mockResolvedValue([]);

      const result = await controller.getCallers('lonely-sym', makeCtx());

      expect(result.data).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // getCallees
  // -------------------------------------------------------------------------

  describe('getCallees()', () => {
    it('returns JsonResponse.Ok with callee list for the guarded project', async () => {
      const callees: CalleeInfo[] = [{ symbolId: 'util', file: 'src/util.ts', name: 'utilFn', kind: 'function' }];
      astIndexService.getCallees.mockResolvedValue(callees);

      const result = await controller.getCallees('my-sym', makeCtx());

      expect(result.data).toEqual(callees);
      expect(astIndexService.getCallees).toHaveBeenCalledWith('proj-1', 'my-sym');
    });

    it('returns empty array when no callees exist', async () => {
      astIndexService.getCallees.mockResolvedValue([]);

      const result = await controller.getCallees('leaf-sym', makeCtx());

      expect(result.data).toHaveLength(0);
    });
  });
});
