import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { CodeIntelController } from './code-intel.controller';
import { AstIndexService, SymbolIndexResult, Symbol } from './ast-index.service';
import { CallerInfo, CalleeInfo } from './symbol-store';
import { UserPrincipal, AgentPrincipal, KodaPrincipal } from '../auth/principal/koda-principal.types';
import { IndexCommitDto, SourceFileDto } from './dto/index-commit.dto';

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

  // Prisma mock — provides client.project.findUnique and client.projectMember.findUnique
  let mockProjectFindUnique: jest.Mock;
  let mockProjectMemberFindUnique: jest.Mock;
  let mockPrisma: { client: { project: { findUnique: jest.Mock }; projectMember: { findUnique: jest.Mock } } };

  beforeEach(async () => {
    mockProjectFindUnique = jest.fn();
    mockProjectMemberFindUnique = jest.fn();

    mockPrisma = {
      client: {
        project: { findUnique: mockProjectFindUnique },
        projectMember: { findUnique: mockProjectMemberFindUnique },
      },
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
        // PrismaService is @Optional() — provide via the token name used by NestJS
        { provide: 'PrismaService', useValue: mockPrisma },
      ],
    }).compile();

    controller = module.get<CodeIntelController>(CodeIntelController);

    // Inject prisma manually since it is @Optional()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (controller as any).prisma = mockPrisma;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // indexCommit
  // -------------------------------------------------------------------------

  describe('indexCommit()', () => {
    it('returns JsonResponse.Ok wrapping the indexing result for an admin user', async () => {
      mockProjectFindUnique.mockResolvedValue(makeProject());
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
      mockProjectFindUnique.mockResolvedValue(makeProject());
      astIndexService.indexCommit.mockResolvedValue(makeIndexResult());

      const result = await controller.indexCommit(makeDto(), makeAgent());

      expect(result.data).toBeDefined();
    });

    it('throws NotFoundException when project slug does not exist', async () => {
      mockProjectFindUnique.mockResolvedValue(null);

      await expect(
        controller.indexCommit(makeDto({ projectSlug: 'missing-slug' }), makeAdminUser()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws ForbiddenAppException when MEMBER user is not a project member', async () => {
      mockProjectFindUnique.mockResolvedValue(makeProject());
      mockProjectMemberFindUnique.mockResolvedValue(null); // no membership

      await expect(
        controller.indexCommit(makeDto(), makeMemberUser()),
      ).rejects.toBeInstanceOf(ForbiddenAppException);
    });

    it('allows MEMBER user who has project membership', async () => {
      mockProjectFindUnique.mockResolvedValue(makeProject());
      mockProjectMemberFindUnique.mockResolvedValue({ projectId: 'proj-1', userId: 'user-member' });
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
      mockProjectFindUnique.mockResolvedValue(makeProject());
      astIndexService.getSymbol.mockResolvedValue(makeSymbol());

      const result = await controller.getSymbol('repo-1:src/a.ts::Foo', 'my-project', makeAdminUser());

      const sym = result.data as import('./ast-index.service').Symbol;
      expect(sym.name).toBe('Foo');
      expect(astIndexService.getSymbol).toHaveBeenCalledWith('proj-1', 'repo-1:src/a.ts::Foo');
    });

    it('throws NotFoundException when symbol is not found', async () => {
      mockProjectFindUnique.mockResolvedValue(makeProject());
      astIndexService.getSymbol.mockResolvedValue(null);

      await expect(
        controller.getSymbol('nonexistent', 'my-project', makeAdminUser()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFoundException when project slug is unknown', async () => {
      mockProjectFindUnique.mockResolvedValue(null);

      await expect(
        controller.getSymbol('any-id', 'no-such-project', makeAdminUser()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws ForbiddenAppException for MEMBER without membership', async () => {
      mockProjectFindUnique.mockResolvedValue(makeProject());
      mockProjectMemberFindUnique.mockResolvedValue(null);

      await expect(
        controller.getSymbol('sym-id', 'my-project', makeMemberUser()),
      ).rejects.toBeInstanceOf(ForbiddenAppException);
    });

    it('returns symbol for agent principal', async () => {
      mockProjectFindUnique.mockResolvedValue(makeProject());
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
      mockProjectFindUnique.mockResolvedValue(makeProject());
      astIndexService.getCallers.mockResolvedValue(callers);

      const result = await controller.getCallers('my-sym', 'my-project', makeAdminUser());

      expect(result.data).toEqual(callers);
      expect(astIndexService.getCallers).toHaveBeenCalledWith('proj-1', 'my-sym');
    });

    it('returns empty array when no callers exist', async () => {
      mockProjectFindUnique.mockResolvedValue(makeProject());
      astIndexService.getCallers.mockResolvedValue([]);

      const result = await controller.getCallers('lonely-sym', 'my-project', makeAdminUser());

      expect(result.data).toHaveLength(0);
    });

    it('throws NotFoundException when project not found', async () => {
      mockProjectFindUnique.mockResolvedValue(null);

      await expect(
        controller.getCallers('sym', 'no-project', makeAdminUser()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws ForbiddenAppException for MEMBER without membership', async () => {
      mockProjectFindUnique.mockResolvedValue(makeProject());
      mockProjectMemberFindUnique.mockResolvedValue(null);

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
      mockProjectFindUnique.mockResolvedValue(makeProject());
      astIndexService.getCallees.mockResolvedValue(callees);

      const result = await controller.getCallees('my-sym', 'my-project', makeAdminUser());

      expect(result.data).toEqual(callees);
      expect(astIndexService.getCallees).toHaveBeenCalledWith('proj-1', 'my-sym');
    });

    it('returns empty array when no callees exist', async () => {
      mockProjectFindUnique.mockResolvedValue(makeProject());
      astIndexService.getCallees.mockResolvedValue([]);

      const result = await controller.getCallees('leaf-sym', 'my-project', makeAdminUser());

      expect(result.data).toHaveLength(0);
    });

    it('throws NotFoundException when project not found', async () => {
      mockProjectFindUnique.mockResolvedValue(null);

      await expect(
        controller.getCallees('sym', 'no-project', makeAdminUser()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws ForbiddenAppException for MEMBER without membership', async () => {
      mockProjectFindUnique.mockResolvedValue(makeProject());
      mockProjectMemberFindUnique.mockResolvedValue(null);

      await expect(
        controller.getCallees('sym', 'my-project', makeMemberUser()),
      ).rejects.toBeInstanceOf(ForbiddenAppException);
    });

    it('allows agent principal to call getCallees', async () => {
      mockProjectFindUnique.mockResolvedValue(makeProject());
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
      mockProjectFindUnique.mockResolvedValue(makeProject());
      astIndexService.getSymbol.mockResolvedValue(makeSymbol());

      await expect(
        controller.getSymbol('sym-id', 'my-project', null as unknown as KodaPrincipal),
      ).rejects.toBeInstanceOf(ForbiddenAppException);
    });
  });
});
