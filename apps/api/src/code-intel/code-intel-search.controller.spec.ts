import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';
import request from 'supertest';
import { CodeIntelController } from './code-intel.controller';
import { AstIndexService } from './ast-index.service';
import { ProjectsService } from '../projects/projects.service';
import { UserPrincipal } from '../auth/principal/koda-principal.types';

// ---------------------------------------------------------------------------
// Local type stubs matching the expected (not-yet-implemented) search interface
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

function makeMemberUser(): UserPrincipal {
  return {
    actorType: 'user',
    id: 'user-member',
    role: 'MEMBER',
    email: 'member@example.com',
    blacklisted: false,
    revoked: false,
    authorities: ['MEMBER'],
    extra: {},
  } as unknown as UserPrincipal;
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

// Calls the not-yet-existing searchSymbols method via optional chaining so the
// test fails at the subsequent assertion rather than throwing pre-assertion.
async function callSearch(
  controller: CodeIntelController,
  query: SearchSymbolsQuery,
  principal: UserPrincipal,
) {
  return (controller as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[
    'searchSymbols'
  ]?.(query, principal);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('CodeIntelController.searchSymbols()', () => {
  let controller: CodeIntelController;
  let mockSearchSymbols: jest.Mock;
  let mockGetSymbol: jest.Mock;
  let mockFindProjectIdBySlug: jest.Mock;
  let mockAssertProjectMembership: jest.Mock;
  let module: TestingModule;

  beforeEach(async () => {
    mockSearchSymbols = jest.fn();
    mockGetSymbol = jest.fn();
    mockFindProjectIdBySlug = jest.fn().mockResolvedValue('proj-1');
    mockAssertProjectMembership = jest.fn().mockResolvedValue(undefined);

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
          provide: ProjectsService,
          useValue: {
            findProjectIdBySlug: mockFindProjectIdBySlug,
            assertProjectMembership: mockAssertProjectMembership,
          } as unknown as ProjectsService,
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

      const result = await callSearch(controller, { projectSlug: 'my-project', q: 'foo' }, makeAdminUser());

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

      const result = await callSearch(controller, { projectSlug: 'my-project', q: 'foo' }, makeAdminUser());

      const resultItem = (result as { data?: { items?: SymbolSearchItem[] } })?.data?.items?.[0];
      expect(resultItem).toHaveProperty('id');
      expect(resultItem).toHaveProperty('name');
      expect(resultItem).toHaveProperty('kind');
      expect(resultItem).toHaveProperty('file');
      expect(resultItem).toHaveProperty('signature');
    });

    it('AC1 boundary: q with no matches returns empty items array', async () => {
      mockSearchSymbols.mockResolvedValue({ items: [], total: 0 });

      const result = await callSearch(controller, { projectSlug: 'my-project', q: 'zzz-no-match' }, makeAdminUser());

      expect((result as { data?: { items?: unknown[] } })?.data?.items).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // AC2: total equals match count
  // -------------------------------------------------------------------------

  describe('AC2: data.total equals the service match count', () => {
    it('AC2: returns data.total matching the service result', async () => {
      mockSearchSymbols.mockResolvedValue({ items: [makeSearchItem()], total: 42 });

      const result = await callSearch(controller, { projectSlug: 'my-project', q: 'foo' }, makeAdminUser());

      expect((result as { data?: { total?: number } })?.data?.total).toBe(42);
    });

    it('AC2 boundary: total is 0 when no items match', async () => {
      mockSearchSymbols.mockResolvedValue({ items: [], total: 0 });

      const result = await callSearch(controller, { projectSlug: 'my-project', q: 'no-match' }, makeAdminUser());

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

      await callSearch(controller, { projectSlug: 'my-project', file: 'auth' }, makeAdminUser());

      expect(mockSearchSymbols).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({ file: 'auth' }),
      );
    });

    it('AC3: returns items from service for file filter', async () => {
      const items = [makeSearchItem({ file: 'src/auth/auth.service.ts' })];
      mockSearchSymbols.mockResolvedValue({ items, total: 1 });

      const result = await callSearch(controller, { projectSlug: 'my-project', file: 'auth' }, makeAdminUser());

      expect((result as { data?: { items?: unknown[] } })?.data?.items).toHaveLength(1);
    });

    it('AC3 boundary: empty items when file fragment matches nothing', async () => {
      mockSearchSymbols.mockResolvedValue({ items: [], total: 0 });

      const result = await callSearch(controller, { projectSlug: 'my-project', file: 'zz-no-such-path' }, makeAdminUser());

      expect((result as { data?: { items?: unknown[] } })?.data?.items).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // AC4: pagination
  // -------------------------------------------------------------------------

  describe('AC4: page and limit are forwarded to the service', () => {
    it('AC4: passes page=2 and limit=20 to the service', async () => {
      mockSearchSymbols.mockResolvedValue({ items: [], total: 50 });

      await callSearch(controller, { projectSlug: 'my-project', q: 'foo', page: 2, limit: 20 }, makeAdminUser());

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
        makeAdminUser(),
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

      await callSearch(controller, { projectSlug: 'my-project', limit: 9999 }, makeAdminUser());

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

      await callSearch(controller, { projectSlug: 'my-project' }, makeAdminUser());

      expect(mockSearchSymbols).toHaveBeenCalledTimes(1);
      const callOpts = mockSearchSymbols.mock.calls[0]?.[1] as { q?: unknown; file?: unknown } | undefined;
      expect(callOpts?.q == null).toBe(true);
      expect(callOpts?.file == null).toBe(true);
    });

    it('AC6: returns items from the service when no filters are applied', async () => {
      const items = [makeSearchItem({ name: 'Alpha' }), makeSearchItem({ name: 'Beta' })];
      mockSearchSymbols.mockResolvedValue({ items, total: 2 });

      const result = await callSearch(controller, { projectSlug: 'my-project' }, makeAdminUser());

      expect((result as { data?: { items?: unknown[] } })?.data?.items).toHaveLength(2);
    });

    it('AC6 boundary: empty project returns empty items with total 0', async () => {
      mockSearchSymbols.mockResolvedValue({ items: [], total: 0 });

      const result = await callSearch(controller, { projectSlug: 'my-project' }, makeAdminUser());

      expect((result as { data?: { items?: unknown[]; total?: number } })?.data?.items).toHaveLength(0);
      expect((result as { data?: { total?: number } })?.data?.total).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // AC7: unknown projectSlug → 404
  // -------------------------------------------------------------------------

  describe('AC7: unknown projectSlug returns HTTP 404', () => {
    it('AC7: throws NotFoundAppException when projectSlug does not resolve', async () => {
      mockFindProjectIdBySlug.mockRejectedValue(new NotFoundAppException({}, 'projects'));

      let caughtError: unknown;
      try {
        await callSearch(controller, { projectSlug: 'no-such-slug' }, makeAdminUser());
      } catch (e) {
        caughtError = e;
      }

      expect(caughtError).toBeInstanceOf(NotFoundAppException);
    });
  });

  // -------------------------------------------------------------------------
  // AC8: non-member principal → 403
  // -------------------------------------------------------------------------

  describe('AC8: non-member principal returns HTTP 403', () => {
    it('AC8: throws ForbiddenAppException when principal is not a project member', async () => {
      mockAssertProjectMembership.mockRejectedValue(new ForbiddenAppException({}, 'code-intel'));

      let caughtError: unknown;
      try {
        await callSearch(controller, { projectSlug: 'my-project' }, makeMemberUser());
      } catch (e) {
        caughtError = e;
      }

      expect(caughtError).toBeInstanceOf(ForbiddenAppException);
    });

    it('AC8 boundary: no service call is made when membership check fails', async () => {
      mockAssertProjectMembership.mockRejectedValue(new ForbiddenAppException({}, 'code-intel'));

      try {
        await callSearch(controller, { projectSlug: 'my-project' }, makeMemberUser());
      } catch {
        // expected
      }

      expect(mockSearchSymbols).not.toHaveBeenCalled();
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

      const result = await controller.getSymbol('repo:src/a.ts::Foo', 'my-project', makeAdminUser());

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
// would cause the wrong mock to be called and fail these tests.
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
          provide: ProjectsService,
          useValue: {
            findProjectIdBySlug: jest.fn().mockResolvedValue('proj-1'),
            assertProjectMembership: jest.fn().mockResolvedValue(undefined),
          } as unknown as ProjectsService,
        },
      ],
    }).compile();

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
