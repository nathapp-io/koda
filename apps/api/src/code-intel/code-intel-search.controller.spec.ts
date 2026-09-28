import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { CodeIntelController } from './code-intel.controller';
import { AstIndexService } from './ast-index.service';
import { ProjectAccessService } from '../projects/project-access.service';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import { ProjectContext } from '../projects/project-context';

// ---------------------------------------------------------------------------
// Local type stubs matching the search interface
// ---------------------------------------------------------------------------

interface SymbolSearchItem {
  id: string;
  name: string;
  kind: string;
  file: string;
  signature: string | null;
}

interface SearchSymbolsQuery {
  projectSlug: string;
  q?: string;
  file?: string;
  page?: number;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Slice 4: the search route receives the ProjectContext ProjectMembershipGuard
 * resolved (slug from ?projectSlug=, membership and role checked there —
 * covered by project-membership.guard.spec.ts and the integration specs).
 */
function makeCtx(id = 'proj-1', slug = 'my-project'): ProjectContext {
  return { project: { id, slug }, role: 'ADMIN' };
}

function makeSearchItem(overrides: Partial<SymbolSearchItem> = {}): SymbolSearchItem {
  return {
    id: 'repo:src/a.ts::Foo',
    name: 'Foo',
    kind: 'function',
    file: 'src/a.ts',
    signature: 'function Foo(): void',
    ...overrides,
  };
}

/** Route-dispatch tests run the handler directly, bypassing the HTTP guard. */
const guardStub = {
  canActivate: (ctx: { switchToHttp: () => { getRequest: () => { projectContext?: ProjectContext } } }) => {
    ctx.switchToHttp().getRequest().projectContext = makeCtx();
    return true;
  },
} as unknown as ProjectMembershipGuard;

// Calls searchSymbols so a missing method fails at the subsequent assertion
// rather than throwing pre-assertion.
async function callSearch(
  controller: CodeIntelController,
  query: SearchSymbolsQuery,
  ctx: ProjectContext,
) {
  return (controller as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[
    'searchSymbols'
  ]?.(query, ctx);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('CodeIntelController.searchSymbols()', () => {
  let controller: CodeIntelController;
  let mockSearchSymbols: jest.Mock;
  let mockGetSymbol: jest.Mock;
  let module: TestingModule;

  beforeEach(async () => {
    mockSearchSymbols = jest.fn();
    mockGetSymbol = jest.fn();

    module = await Test.createTestingModule({
      controllers: [CodeIntelController],
      providers: [
        {
          provide: AstIndexService,
          useValue: {
            indexCommit: jest.fn(),
            getSymbol: mockGetSymbol,
            getCallers: jest.fn(),
            getCallees: jest.fn(),
            searchSymbols: mockSearchSymbols,
          } as unknown as AstIndexService,
        },
        {
          provide: ProjectAccessService,
          useValue: {
            findProjectIdBySlug: jest.fn().mockResolvedValue('proj-1'),
            assertProjectMembership: jest.fn().mockResolvedValue(undefined),
          } as unknown as ProjectAccessService,
        },
      ],
    }).compile();

    controller = module.get(CodeIntelController);
  });

  afterEach(async () => {
    await module.close();
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // AC1: q filter — items returned with required fields
  // -------------------------------------------------------------------------

  describe('AC1: q filter returns items with id, name, kind, file, and signature', () => {
    it('AC1: returns items whose name contains q', async () => {
      const items: SymbolSearchItem[] = [
        makeSearchItem({ id: 'sym-1', name: 'fooBar' }),
        makeSearchItem({ id: 'sym-2', name: 'fooUtil' }),
      ];
      mockSearchSymbols.mockResolvedValue({ items, total: 2 });

      const result = await callSearch(controller, { projectSlug: 'my-project', q: 'foo' }, makeCtx());

      expect((result as { data?: { items?: unknown[] } })?.data?.items).toHaveLength(2);
    });

    it('AC1: each returned item has id, name, kind, file, and signature', async () => {
      const item = makeSearchItem({
        id: 'sym-1',
        name: 'fooBar',
        kind: 'function',
        file: 'src/a.ts',
        signature: 'function fooBar(): void',
      });
      mockSearchSymbols.mockResolvedValue({ items: [item], total: 1 });

      const result = await callSearch(controller, { projectSlug: 'my-project', q: 'foo' }, makeCtx());

      const resultItem = (result as { data?: { items?: SymbolSearchItem[] } })?.data?.items?.[0];
      expect(resultItem).toHaveProperty('id');
      expect(resultItem).toHaveProperty('name');
      expect(resultItem).toHaveProperty('kind');
      expect(resultItem).toHaveProperty('file');
      expect(resultItem).toHaveProperty('signature');
    });

    it('AC1 boundary: q with no matches returns empty items array', async () => {
      mockSearchSymbols.mockResolvedValue({ items: [], total: 0 });

      const result = await callSearch(controller, { projectSlug: 'my-project', q: 'zzz-no-match' }, makeCtx());

      expect((result as { data?: { items?: unknown[] } })?.data?.items).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // AC2: total equals match count
  // -------------------------------------------------------------------------

  describe('AC2: data.total equals the service match count', () => {
    it('AC2: returns data.total matching the service result', async () => {
      mockSearchSymbols.mockResolvedValue({ items: [makeSearchItem()], total: 42 });

      const result = await callSearch(controller, { projectSlug: 'my-project', q: 'foo' }, makeCtx());

      expect((result as { data?: { total?: number } })?.data?.total).toBe(42);
    });

    it('AC2 boundary: total is 0 when no items match', async () => {
      mockSearchSymbols.mockResolvedValue({ items: [], total: 0 });

      const result = await callSearch(controller, { projectSlug: 'my-project', q: 'no-match' }, makeCtx());

      expect((result as { data?: { total?: number } })?.data?.total).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // AC3: file fragment filter
  // -------------------------------------------------------------------------

  describe('AC3: file filter passes fragment to service', () => {
    it('AC3: passes file fragment to the service search call', async () => {
      mockSearchSymbols.mockResolvedValue({
        items: [makeSearchItem({ file: 'src/auth/auth.service.ts' })],
        total: 1,
      });

      await callSearch(controller, { projectSlug: 'my-project', file: 'auth' }, makeCtx());

      expect(mockSearchSymbols).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({ file: 'auth' }),
      );
    });

    it('AC3: returns items from service for file filter', async () => {
      const items = [makeSearchItem({ file: 'src/auth/auth.service.ts' })];
      mockSearchSymbols.mockResolvedValue({ items, total: 1 });

      const result = await callSearch(controller, { projectSlug: 'my-project', file: 'auth' }, makeCtx());

      expect((result as { data?: { items?: unknown[] } })?.data?.items).toHaveLength(1);
    });

    it('AC3 boundary: empty items when file fragment matches nothing', async () => {
      mockSearchSymbols.mockResolvedValue({ items: [], total: 0 });

      const result = await callSearch(controller, { projectSlug: 'my-project', file: 'zz-no-such-path' }, makeCtx());

      expect((result as { data?: { items?: unknown[] } })?.data?.items).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // AC4: pagination
  // -------------------------------------------------------------------------

  describe('AC4: page and limit are forwarded to the service', () => {
    it('AC4: passes page=2 and limit=20 to the service', async () => {
      mockSearchSymbols.mockResolvedValue({ items: [], total: 50 });

      await callSearch(controller, { projectSlug: 'my-project', q: 'foo', page: 2, limit: 20 }, makeCtx());

      expect(mockSearchSymbols).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({ page: 2, limit: 20 }),
      );
    });

    it('AC4: returns at most limit items (service respects pagination)', async () => {
      const items = Array.from({ length: 20 }, (_, i) =>
        makeSearchItem({ id: `sym-${i}`, name: `foo${i + 21}` }),
      );
      mockSearchSymbols.mockResolvedValue({ items, total: 50 });

      const result = await callSearch(
        controller,
        { projectSlug: 'my-project', q: 'foo', page: 2, limit: 20 },
        makeCtx(),
      );

      expect((result as { data?: { items?: unknown[] } })?.data?.items).toHaveLength(20);
    });
  });

  // -------------------------------------------------------------------------
  // AC5: limit clamping
  // -------------------------------------------------------------------------

  describe('AC5: limit above maximum is clamped', () => {
    it('AC5: service is called with effective limit at or below 100 when limit=9999 is requested', async () => {
      mockSearchSymbols.mockResolvedValue({ items: [], total: 0 });

      await callSearch(controller, { projectSlug: 'my-project', limit: 9999 }, makeCtx());

      // searchSymbols must have been called (fails if method doesn't exist yet)
      expect(mockSearchSymbols).toHaveBeenCalledTimes(1);
      const callOpts = mockSearchSymbols.mock.calls[0]?.[1] as { limit?: number } | undefined;
      expect(callOpts?.limit).toBeLessThanOrEqual(100);
    });
  });

  // -------------------------------------------------------------------------
  // AC6: no q or file — returns first page in deterministic order
  // -------------------------------------------------------------------------

  describe('AC6: no q or file returns all symbols (first page, deterministic order)', () => {
    it('AC6: calls service without q or file when neither is provided', async () => {
      mockSearchSymbols.mockResolvedValue({ items: [makeSearchItem()], total: 1 });

      await callSearch(controller, { projectSlug: 'my-project' }, makeCtx());

      expect(mockSearchSymbols).toHaveBeenCalledTimes(1);
      const callOpts = mockSearchSymbols.mock.calls[0]?.[1] as { q?: unknown; file?: unknown } | undefined;
      expect(callOpts?.q == null).toBe(true);
      expect(callOpts?.file == null).toBe(true);
    });

    it('AC6: returns items from the service when no filters are applied', async () => {
      const items = [makeSearchItem({ name: 'Alpha' }), makeSearchItem({ name: 'Beta' })];
      mockSearchSymbols.mockResolvedValue({ items, total: 2 });

      const result = await callSearch(controller, { projectSlug: 'my-project' }, makeCtx());

      expect((result as { data?: { items?: unknown[] } })?.data?.items).toHaveLength(2);
    });

    it('AC6 boundary: empty project returns empty items with total 0', async () => {
      mockSearchSymbols.mockResolvedValue({ items: [], total: 0 });

      const result = await callSearch(controller, { projectSlug: 'my-project' }, makeCtx());

      expect((result as { data?: { items?: unknown[]; total?: number } })?.data?.items).toHaveLength(0);
      expect((result as { data?: { total?: number } })?.data?.total).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // AC10: existing detail route not shadowed by search route
  // -------------------------------------------------------------------------

  describe('AC10: getSymbol detail route is not shadowed by the new search route', () => {
    it('AC10: searchSymbols exists as a distinct method from getSymbol', () => {
      // Both methods must exist on the controller. If searchSymbols is missing, this
      // assertion fails — confirming the detail route cannot yet be "shadowed" and
      // the implementer must add the route.
      expect(typeof (controller as unknown as Record<string, unknown>)['searchSymbols']).toBe('function');
      expect(typeof (controller as unknown as Record<string, unknown>)['getSymbol']).toBe('function');
    });

    it('AC10: getSymbol still delegates to astIndexService.getSymbol, not to searchSymbols', async () => {
      const sym = {
        id: 'repo:src/a.ts::Foo',
        symbolId: 'repo:src/a.ts::Foo',
        projectId: 'proj-1',
        repoId: 'repo-1',
        commitHash: 'abc',
        name: 'Foo',
        kind: 'function' as const,
        file: 'src/a.ts',
        startLine: 1,
        endLine: 5,
        callers: [],
        callees: [],
      };
      mockGetSymbol.mockResolvedValue(sym);

      const result = await controller.getSymbol('repo:src/a.ts::Foo', makeCtx());

      expect(mockGetSymbol).toHaveBeenCalledWith('proj-1', 'repo:src/a.ts::Foo');
      expect(mockSearchSymbols).not.toHaveBeenCalled();
      expect((result as { data?: { name?: string } })?.data?.name).toBe('Foo');
    });
  });
});

// ---------------------------------------------------------------------------
// AC10 HTTP routing layer: verify at the Fastify dispatch level that
// GET /code-intel/symbols/:symbolId does NOT get captured by the search route.
// A decorator/path-order regression (e.g. wrong path string, wildcard route)
// would cause the wrong mock to be called and fail these tests. The project
// guard is stubbed: its slug/membership decisions are covered by the guard
// unit spec and the DB-backed integration specs.
// ---------------------------------------------------------------------------

describe('AC10 HTTP routing: detail route is not shadowed by the search route', () => {
  let routingApp: NestFastifyApplication;
  let mockSearchForRouting: jest.Mock;
  let mockGetSymbolForRouting: jest.Mock;

  const stubbedSymbol = {
    id: 'repo:src/a.ts::Sym',
    symbolId: 'repo:src/a.ts::Sym',
    projectId: 'proj-1',
    repoId: 'repo-1',
    commitHash: 'abc',
    name: 'Sym',
    kind: 'function' as const,
    file: 'src/a.ts',
    startLine: 1,
    endLine: 5,
    callers: [],
    callees: [],
  };

  beforeAll(async () => {
    mockSearchForRouting = jest.fn().mockResolvedValue({ items: [], total: 0 });
    mockGetSymbolForRouting = jest.fn().mockResolvedValue(stubbedSymbol);

    const routingModule = await Test.createTestingModule({
      controllers: [CodeIntelController],
      providers: [
        {
          provide: AstIndexService,
          useValue: {
            indexCommit: jest.fn(),
            getSymbol: mockGetSymbolForRouting,
            getCallers: jest.fn().mockResolvedValue([]),
            getCallees: jest.fn().mockResolvedValue([]),
            searchSymbols: mockSearchForRouting,
          } as unknown as AstIndexService,
        },
        {
          provide: ProjectAccessService,
          useValue: {
            findProjectIdBySlug: jest.fn().mockResolvedValue('proj-1'),
            assertProjectMembership: jest.fn().mockResolvedValue(undefined),
          } as unknown as ProjectAccessService,
        },
      ],
    })
      .overrideGuard(ProjectMembershipGuard)
      .useValue(guardStub)
      .compile();

    routingApp = routingModule.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await routingApp.init();
    await routingApp.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    if (routingApp) await routingApp.close();
  });

  beforeEach(() => {
    mockSearchForRouting.mockClear();
    mockGetSymbolForRouting.mockClear();
  });

  it('AC10: GET /code-intel/symbols dispatches to the search handler', async () => {
    await request(routingApp.getHttpServer())
      .get('/code-intel/symbols?projectSlug=my-project');

    expect(mockSearchForRouting).toHaveBeenCalledTimes(1);
    expect(mockGetSymbolForRouting).not.toHaveBeenCalled();
  });

  it('AC10: GET /code-intel/symbols/:symbolId dispatches to getSymbol, not searchSymbols', async () => {
    await request(routingApp.getHttpServer())
      .get('/code-intel/symbols/some-symbol-id?projectSlug=my-project');

    expect(mockGetSymbolForRouting).toHaveBeenCalledTimes(1);
    expect(mockSearchForRouting).not.toHaveBeenCalled();
  });
});
