import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import { CodeIntelController } from './code-intel.controller';
import { AstIndexService, SymbolIndexResult, Symbol } from './ast-index.service';
import { CallerInfo, CalleeInfo } from './symbol-store';
import { UserPrincipal, AgentPrincipal, KodaPrincipal } from '../auth/principal/koda-principal.types';
import { IndexCommitDto, SourceFileDto } from './dto/index-commit.dto';
import { ProjectAccessService } from '../projects/project-access.service';

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
  let astIndexService: jest.Mocked<Pick<AstIndexService, 'indexCommit' | 'getSymbol' | 'getCallers' | 'getCallees'>>;

  // ProjectAccessService mock — provides findProjectIdBySlug and assertProjectMembership
  let mockFindProjectIdBySlug: jest.Mock;
  let mockAssertProjectMembership: jest.Mock;
  let mockProjectAccessService: jest.Mocked<Pick<ProjectAccessService, 'findProjectIdBySlug' | 'assertProjectMembership'>>;

  beforeEach(async () => {
    mockFindProjectIdBySlug = jest.fn();
    mockAssertProjectMembership = jest.fn();

    mockProjectAccessService = {
      findProjectIdBySlug: mockFindProjectIdBySlug,
      assertProjectMembership: mockAssertProjectMembership,
    };

    astIndexService = {
      indexCommit: jest.fn(),
      getSymbol: jest.fn(),
      getCallers: jest.fn(),
      getCallees: jest.fn(),
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
    jest.clearAllMocks();
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
    it('returns JsonResponse.Ok with symbol data for admin', async () => {
      mockFindProjectIdBySlug.mockResolvedValue('proj-1');
      mockAssertProjectMembership.mockResolvedValue(undefined);
      astIndexService.getSymbol.mockResolvedValue(makeSymbol());

      const result = await controller.getSymbol('repo-1:src/a.ts::Foo', 'my-project', makeAdminUser());

      const sym = result.data as import('./ast-index.service').Symbol;
      expect(sym.name).toBe('Foo');
      expect(astIndexService.getSymbol).toHaveBeenCalledWith('proj-1', 'repo-1:src/a.ts::Foo');
    });

    it('throws NotFoundAppException when symbol is not found', async () => {
      mockFindProjectIdBySlug.mockResolvedValue('proj-1');
      mockAssertProjectMembership.mockResolvedValue(undefined);
      astIndexService.getSymbol.mockResolvedValue(null);

      await expect(
        controller.getSymbol('nonexistent', 'my-project', makeAdminUser()),
      ).rejects.toBeInstanceOf(NotFoundAppException);
    });

    it('throws NotFoundAppException when project slug is unknown', async () => {
      mockFindProjectIdBySlug.mockRejectedValue(new NotFoundAppException({}, 'projects'));

      await expect(
        controller.getSymbol('any-id', 'no-such-project', makeAdminUser()),
      ).rejects.toBeInstanceOf(NotFoundAppException);
    });

    it('throws ForbiddenAppException for MEMBER without membership', async () => {
      mockFindProjectIdBySlug.mockResolvedValue('proj-1');
      mockAssertProjectMembership.mockRejectedValue(new ForbiddenAppException({}, 'code-intel'));

      await expect(
        controller.getSymbol('sym-id', 'my-project', makeMemberUser()),
      ).rejects.toBeInstanceOf(ForbiddenAppException);
    });

    it('returns symbol for agent principal', async () => {
      mockFindProjectIdBySlug.mockResolvedValue('proj-1');
      mockAssertProjectMembership.mockResolvedValue(undefined);
      astIndexService.getSymbol.mockResolvedValue(makeSymbol());

      const result = await controller.getSymbol('sym-id', 'my-project', makeAgent());

      expect(result.data).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // getCallers
  // -------------------------------------------------------------------------

  describe('getCallers()', () => {
    it('returns JsonResponse.Ok with caller list for admin', async () => {
      const callers: CallerInfo[] = [{ symbolId: 'other', file: 'src/b.ts', name: 'bar', kind: 'function' }];
      mockFindProjectIdBySlug.mockResolvedValue('proj-1');
      mockAssertProjectMembership.mockResolvedValue(undefined);
      astIndexService.getCallers.mockResolvedValue(callers);

      const result = await controller.getCallers('my-sym', 'my-project', makeAdminUser());

      expect(result.data).toEqual(callers);
      expect(astIndexService.getCallers).toHaveBeenCalledWith('proj-1', 'my-sym');
    });

    it('returns empty array when no callers exist', async () => {
      mockFindProjectIdBySlug.mockResolvedValue('proj-1');
      mockAssertProjectMembership.mockResolvedValue(undefined);
      astIndexService.getCallers.mockResolvedValue([]);

      const result = await controller.getCallers('lonely-sym', 'my-project', makeAdminUser());

      expect(result.data).toHaveLength(0);
    });

    it('throws NotFoundAppException when project not found', async () => {
      mockFindProjectIdBySlug.mockRejectedValue(new NotFoundAppException({}, 'projects'));

      await expect(
        controller.getCallers('sym', 'no-project', makeAdminUser()),
      ).rejects.toBeInstanceOf(NotFoundAppException);
    });

    it('throws ForbiddenAppException for MEMBER without membership', async () => {
      mockFindProjectIdBySlug.mockResolvedValue('proj-1');
      mockAssertProjectMembership.mockRejectedValue(new ForbiddenAppException({}, 'code-intel'));

      await expect(
        controller.getCallers('sym', 'my-project', makeMemberUser()),
      ).rejects.toBeInstanceOf(ForbiddenAppException);
    });
  });

  // -------------------------------------------------------------------------
  // getCallees
  // -------------------------------------------------------------------------

  describe('getCallees()', () => {
    it('returns JsonResponse.Ok with callee list for admin', async () => {
      const callees: CalleeInfo[] = [{ symbolId: 'util', file: 'src/util.ts', name: 'utilFn', kind: 'function' }];
      mockFindProjectIdBySlug.mockResolvedValue('proj-1');
      mockAssertProjectMembership.mockResolvedValue(undefined);
      astIndexService.getCallees.mockResolvedValue(callees);

      const result = await controller.getCallees('my-sym', 'my-project', makeAdminUser());

      expect(result.data).toEqual(callees);
      expect(astIndexService.getCallees).toHaveBeenCalledWith('proj-1', 'my-sym');
    });

    it('returns empty array when no callees exist', async () => {
      mockFindProjectIdBySlug.mockResolvedValue('proj-1');
      mockAssertProjectMembership.mockResolvedValue(undefined);
      astIndexService.getCallees.mockResolvedValue([]);

      const result = await controller.getCallees('leaf-sym', 'my-project', makeAdminUser());

      expect(result.data).toHaveLength(0);
    });

    it('throws NotFoundAppException when project not found', async () => {
      mockFindProjectIdBySlug.mockRejectedValue(new NotFoundAppException({}, 'projects'));

      await expect(
        controller.getCallees('sym', 'no-project', makeAdminUser()),
      ).rejects.toBeInstanceOf(NotFoundAppException);
    });

    it('throws ForbiddenAppException for MEMBER without membership', async () => {
      mockFindProjectIdBySlug.mockResolvedValue('proj-1');
      mockAssertProjectMembership.mockRejectedValue(new ForbiddenAppException({}, 'code-intel'));

      await expect(
        controller.getCallees('sym', 'my-project', makeMemberUser()),
      ).rejects.toBeInstanceOf(ForbiddenAppException);
    });

    it('allows agent principal to call getCallees', async () => {
      mockFindProjectIdBySlug.mockResolvedValue('proj-1');
      mockAssertProjectMembership.mockResolvedValue(undefined);
      astIndexService.getCallees.mockResolvedValue([]);

      const result = await controller.getCallees('sym', 'my-project', makeAgent());

      expect(result.data).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // checkProjectMembership — null principal edge case
  // -------------------------------------------------------------------------

  describe('checkProjectMembership() with null principal', () => {
    it('throws ForbiddenAppException when principal is null', async () => {
      mockFindProjectIdBySlug.mockResolvedValue('proj-1');
      mockAssertProjectMembership.mockRejectedValue(new ForbiddenAppException({}, 'code-intel'));
      astIndexService.getSymbol.mockResolvedValue(makeSymbol());

      await expect(
        controller.getSymbol('sym-id', 'my-project', null as unknown as KodaPrincipal),
      ).rejects.toBeInstanceOf(ForbiddenAppException);
    });
  });
});
