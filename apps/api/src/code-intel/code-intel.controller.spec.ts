import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import { ApprovalPending } from '../approvals/route/approval-pending';
import type { Mocked } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { CodeIntelController } from './code-intel.controller';
import { AstIndexService, SymbolIndexResult, Symbol } from './ast-index.service';
import { CallerInfo, CalleeInfo } from './symbol-store';
import { IndexCommitDto, SourceFileDto } from './dto/index-commit.dto';
import { ProjectContext } from '../projects/project-context';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import { RequiresGuard } from '../permissions/requires.guard';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  let module: TestingModule;
  let astIndexService: Mocked<Pick<AstIndexService, 'indexCommit' | 'getSymbol' | 'getCallers' | 'getCallees'>>;

  let gate: { run: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    gate = { run: vi.fn().mockResolvedValue({ status: 'executed', result: makeIndexResult() }) };
    astIndexService = {
      indexCommit: vi.fn(),
      getSymbol: vi.fn(),
      getCallers: vi.fn(),
      getCallees: vi.fn(),
    };

    module = await Test.createTestingModule({
      controllers: [CodeIntelController],
      providers: [
        { provide: AstIndexService, useValue: astIndexService },
        { provide: ApprovalRouteGate, useValue: gate },
      ],
    })
      .overrideGuard(ProjectMembershipGuard).useValue({ canActivate: () => true })
      .overrideGuard(RequiresGuard).useValue({ canActivate: () => true })
      .compile();

    controller = module.get<CodeIntelController>(CodeIntelController);
  });

  afterEach(async () => {
    await module.close();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // indexCommit
  // -------------------------------------------------------------------------

  describe('indexCommit()', () => {
    it('surfaces pending without indexing', async () => {
      gate.run.mockResolvedValue({ status: 'pending', request: { id: 'approval-1' } });
      await expect(controller.indexCommit(makeDto(), makeCtx())).rejects.toBeInstanceOf(ApprovalPending);
      expect(astIndexService.indexCommit).not.toHaveBeenCalled();
    });
    it('gates indexing with the guard-resolved project id and wraps the result', async () => {
      astIndexService.indexCommit.mockResolvedValue(makeIndexResult());
      const dto = makeDto();

      const result = await controller.indexCommit(dto, makeCtx());

      expect(result.data).toMatchObject({ commitHash: 'abc123', symbolsIndexed: 1 });
      expect(gate.run).toHaveBeenCalledExactlyOnceWith({ key: 'codeintel.index.write', variant: 'rest:code-intel.index', projectId: 'proj-1', input: { projectId: 'proj-1', index: dto } });
      expect(astIndexService.indexCommit).not.toHaveBeenCalled();
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
