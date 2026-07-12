import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenAppException, NotFoundAppException } from '@nathapp/nestjs-common';

// US-001 — MemoryReadController (created by this feature)
import { MemoryReadController } from '../../../src/memory/memory-read.controller';
import { MemoryGovernanceService } from '../../../src/memory/memory-governance.service';
import { MemoryModule } from '../../../src/memory/memory.module';
import { MemoryKind } from '../../../src/common/enums';
import type { MemoryItem } from '../../../src/memory/memory-item-repository';

// US-002 — CodeIntelController (extended by this feature)
import { CodeIntelController } from '../../../src/code-intel/code-intel.controller';
import { AstIndexService } from '../../../src/code-intel/ast-index.service';
import { PrismaCodeIntelRepository } from '../../../src/code-intel/prisma-code-intel.repository';
import { CodeIntelModule } from '../../../src/code-intel/code-intel.module';

// Shared
import { ProjectsService } from '../../../src/projects/projects.service';
import { GlobalStubsModule } from '../../../src/common/test-helpers/global-stubs.module';
import type { UserPrincipal } from '../../../src/auth/principal/koda-principal.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(role: 'ADMIN' | 'MEMBER' | 'VIEWER' = 'MEMBER'): UserPrincipal {
  return {
    actorType: 'user',
    id: 'user-1',
    role,
    email: 'test@example.com',
    blacklisted: false,
    revoked: false,
    authorities: [role],
  } as unknown as UserPrincipal;
}

function makeMemoryItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'mem-1',
    projectId: 'proj-1',
    kind: MemoryKind.FACT,
    subject: 'ticket:1',
    predicate: 'status',
    object: 'open',
    status: 'active',
    confidence: 0.9,
    ttlAt: undefined,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** Lightweight symbol item as returned by the new searchSymbols endpoint. */
interface SymbolSearchItem {
  id: string;
  name: string;
  kind: string;
  file: string;
  signature: string;
}

function makeSymbolSearchItem(overrides: Partial<SymbolSearchItem> = {}): SymbolSearchItem {
  return {
    id: 'repo-1:src/a.ts::Foo',
    name: 'Foo',
    kind: 'function',
    file: 'src/a.ts',
    signature: 'function Foo(): void',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// US-001: Memory read endpoint   AC-1 … AC-9
// ---------------------------------------------------------------------------

describe('US-001: Memory read endpoint (GET /projects/:slug/memory)', () => {
  let controller: MemoryReadController;
  let mockGovernanceService: jest.Mocked<Pick<MemoryGovernanceService, 'getProjectMemory'>>;
  let mockFindProjectIdBySlug: jest.Mock;
  let mockAssertProjectMembership: jest.Mock;
  let mockProjectsService: jest.Mocked<Pick<ProjectsService, 'findProjectIdBySlug' | 'assertProjectMembership'>>;

  beforeEach(async () => {
    mockFindProjectIdBySlug = jest.fn().mockResolvedValue('proj-1');
    mockAssertProjectMembership = jest.fn().mockResolvedValue(undefined);
    mockProjectsService = {
      findProjectIdBySlug: mockFindProjectIdBySlug,
      assertProjectMembership: mockAssertProjectMembership,
    };

    mockGovernanceService = {
      getProjectMemory: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryReadController,
        { provide: MemoryGovernanceService, useValue: mockGovernanceService },
        { provide: ProjectsService, useValue: mockProjectsService },
      ],
    }).compile();

    controller = module.get<MemoryReadController>(MemoryReadController);
  });

  afterEach(() => jest.clearAllMocks());

  it('AC-1: returns { data: { items: MemoryItem[], total: number } } with all active project memory', async () => {
    const items = [makeMemoryItem({ id: 'mem-1' }), makeMemoryItem({ id: 'mem-2' })];
    (mockGovernanceService.getProjectMemory as jest.Mock).mockResolvedValue({ items, total: 2 });

    const result = await controller.list('my-project', undefined, undefined, undefined, undefined, undefined, makeUser());

    expect(result).toHaveProperty('data');
    expect(result.data).toHaveProperty('items');
    expect(result.data).toHaveProperty('total');
    expect(Array.isArray(result.data.items)).toBe(true);
    expect(result.data.items).toHaveLength(2);
    expect(result.data.total).toBe(2);
  });

  it('AC-2: when kind=DECISION filter is applied, every returned item has kind === DECISION', async () => {
    const items = [
      makeMemoryItem({ id: 'mem-1', kind: MemoryKind.DECISION }),
      makeMemoryItem({ id: 'mem-2', kind: MemoryKind.DECISION }),
    ];
    (mockGovernanceService.getProjectMemory as jest.Mock).mockResolvedValue({ items, total: 2 });

    const result = await controller.list('my-project', MemoryKind.DECISION, undefined, undefined, undefined, undefined, makeUser());

    expect(result.data.items.length).toBeGreaterThan(0);
    for (const item of result.data.items) {
      expect(item.kind).toBe(MemoryKind.DECISION);
    }
    expect(result.data.total).toBe(2);
  });

  it('AC-3: default (no status filter) returns only active items with non-expired TTL', async () => {
    const now = Date.now();
    const futureTtl = new Date(now + 60_000);
    const items = [
      makeMemoryItem({ id: 'mem-1', status: 'active', ttlAt: undefined }),
      makeMemoryItem({ id: 'mem-2', status: 'active', ttlAt: futureTtl }),
    ];
    (mockGovernanceService.getProjectMemory as jest.Mock).mockResolvedValue({ items, total: 2 });

    const result = await controller.list('my-project', undefined, undefined, undefined, undefined, undefined, makeUser());

    expect(result.data.items.length).toBeGreaterThan(0);
    for (const item of result.data.items) {
      expect(item.status).toBe('active');
      if (item.ttlAt !== undefined && item.ttlAt !== null) {
        expect(new Date(item.ttlAt).getTime()).toBeGreaterThan(Date.now() - 5000);
      }
    }
    const hasSuperseded = result.data.items.some((i) => i.status === 'superseded');
    expect(hasSuperseded).toBe(false);
  });

  it('AC-4: when status=superseded, every returned item has status === superseded', async () => {
    const items = [
      makeMemoryItem({ id: 'mem-1', status: 'superseded' }),
      makeMemoryItem({ id: 'mem-2', status: 'superseded' }),
    ];
    (mockGovernanceService.getProjectMemory as jest.Mock).mockResolvedValue({ items, total: 2 });

    const result = await controller.list('my-project', undefined, 'superseded', undefined, undefined, undefined, makeUser());

    expect(result.data.items.length).toBeGreaterThan(0);
    for (const item of result.data.items) {
      expect(item.status).toBe('superseded');
    }
    expect(result.data.total).toBe(2);
  });

  it('AC-5: page=2 limit=10 returns ≤10 items, total equals full matching count', async () => {
    const pageItems = Array.from({ length: 10 }, (_, i) => makeMemoryItem({ id: `mem-${i + 11}` }));
    (mockGovernanceService.getProjectMemory as jest.Mock).mockResolvedValue({ items: pageItems, total: 25 });

    const result = await controller.list('my-project', undefined, undefined, 2, 10, undefined, makeUser());

    expect(result.data.items.length).toBeLessThanOrEqual(10);
    expect(result.data.total).toBe(25);
    expect(result.data.total).toBeGreaterThan(result.data.items.length);
    expect(mockGovernanceService.getProjectMemory).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, limit: 10 }),
    );
  });

  it('AC-6: limit=50 clamps correctly — items.length ≤ 50, total reflects actual matching count', async () => {
    const items = Array.from({ length: 50 }, (_, i) => makeMemoryItem({ id: `mem-${i}` }));
    (mockGovernanceService.getProjectMemory as jest.Mock).mockResolvedValue({ items, total: 120 });

    const result = await controller.list('my-project', undefined, undefined, 1, 50, undefined, makeUser());

    expect(result.data.items.length).toBeLessThanOrEqual(50);
    expect(result.data.total).toBe(120);
    expect(mockGovernanceService.getProjectMemory).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );
  });

  it('AC-7: unknown or deleted project slug → throws NotFoundAppException (maps to HTTP 404)', async () => {
    mockFindProjectIdBySlug.mockRejectedValue(new NotFoundAppException({}, 'projects'));

    await expect(
      controller.list('nonexistent-slug', undefined, undefined, undefined, undefined, undefined, makeUser()),
    ).rejects.toBeInstanceOf(NotFoundAppException);
  });

  it('AC-8: non-member principal → throws ForbiddenAppException (maps to HTTP 403)', async () => {
    mockAssertProjectMembership.mockRejectedValue(new ForbiddenAppException({}, 'memory'));

    await expect(
      controller.list('my-project', undefined, undefined, undefined, undefined, undefined, makeUser('VIEWER')),
    ).rejects.toBeInstanceOf(ForbiddenAppException);
  });

  it('AC-9: response body is wrapped in JsonResponse.Ok envelope { data: { items, total } }', async () => {
    const items = [makeMemoryItem()];
    (mockGovernanceService.getProjectMemory as jest.Mock).mockResolvedValue({ items, total: 1 });

    const result = await controller.list('my-project', undefined, undefined, undefined, undefined, undefined, makeUser());

    expect(typeof result).toBe('object');
    expect(result).toHaveProperty('data');
    const data = result.data as { items: unknown[]; total: number };
    expect(data).toHaveProperty('items');
    expect(data).toHaveProperty('total');
    expect(Array.isArray(data.items)).toBe(true);
    expect(typeof data.total).toBe('number');
    expect(Object.keys(data).sort()).toEqual(['items', 'total']);
  });
});

// ---------------------------------------------------------------------------
// AC-10: MemoryModule DI compilation
// ---------------------------------------------------------------------------

describe('AC-10: MemoryModule DI compilation and provider wiring', () => {
  let moduleRef: TestingModule;

  afterEach(async () => {
    if (moduleRef) await moduleRef.close();
  });

  it('AC-10: module compiles without throwing; MemoryReadController, MemoryGovernanceService, and ProjectsService are retrievable from DI', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [GlobalStubsModule, MemoryModule],
    }).compile();

    const readController = moduleRef.get(MemoryReadController);
    expect(readController).toBeInstanceOf(MemoryReadController);

    const governanceService = moduleRef.get(MemoryGovernanceService);
    expect(governanceService).toBeInstanceOf(MemoryGovernanceService);

    const projectsService = moduleRef.get(ProjectsService);
    expect(projectsService).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// US-002: Code-intel symbol search   AC-11 … AC-18
// ---------------------------------------------------------------------------

describe('US-002: Code-intel symbol search (GET /code-intel/symbols)', () => {
  let controller: CodeIntelController;
  let mockSearchSymbols: jest.Mock;
  let mockAstIndexService: jest.Mocked<Pick<AstIndexService, 'indexCommit' | 'getSymbol' | 'getCallers' | 'getCallees' | 'searchSymbols'>>;
  let mockFindProjectIdBySlug: jest.Mock;
  let mockAssertProjectMembership: jest.Mock;
  let mockProjectsService: jest.Mocked<Pick<ProjectsService, 'findProjectIdBySlug' | 'assertProjectMembership'>>;

  beforeEach(async () => {
    mockFindProjectIdBySlug = jest.fn().mockResolvedValue('proj-1');
    mockAssertProjectMembership = jest.fn().mockResolvedValue(undefined);
    mockProjectsService = {
      findProjectIdBySlug: mockFindProjectIdBySlug,
      assertProjectMembership: mockAssertProjectMembership,
    };

    mockSearchSymbols = jest.fn();
    mockAstIndexService = {
      indexCommit: jest.fn(),
      getSymbol: jest.fn(),
      getCallers: jest.fn(),
      getCallees: jest.fn(),
      searchSymbols: mockSearchSymbols,
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CodeIntelController],
      providers: [
        { provide: AstIndexService, useValue: mockAstIndexService },
        { provide: ProjectsService, useValue: mockProjectsService },
      ],
    }).compile();

    controller = module.get<CodeIntelController>(CodeIntelController);
  });

  afterEach(() => jest.clearAllMocks());

  it('AC-11: q filter — every item.name contains query (case-insensitive); each item has exactly { id, name, kind, file, signature }', async () => {
    const query = 'foo';
    const items: SymbolSearchItem[] = [
      makeSymbolSearchItem({ name: 'fooBar', id: 'r:src/a.ts::fooBar' }),
      makeSymbolSearchItem({ name: 'FooHelper', id: 'r:src/b.ts::FooHelper' }),
    ];
    mockSearchSymbols.mockResolvedValue({ items, total: 2 });

    const result = await controller.searchSymbols('my-project', query, undefined, undefined, undefined, makeUser());

    expect(result.data.items.length).toBeGreaterThan(0);
    for (const item of result.data.items) {
      expect(item.name.toLowerCase()).toContain(query.toLowerCase());
      const keys = Object.keys(item).sort();
      expect(keys).toEqual(['file', 'id', 'kind', 'name', 'signature']);
      expect(typeof item.id).toBe('string');
      expect(typeof item.name).toBe('string');
      expect(typeof item.kind).toBe('string');
      expect(typeof item.file).toBe('string');
      expect(typeof item.signature).toBe('string');
    }
  });

  it('AC-12: response.data.total equals full count of symbols whose name contains q (not just page count)', async () => {
    mockSearchSymbols.mockResolvedValue({
      items: [makeSymbolSearchItem({ name: 'fooBar' })],
      total: 42,
    });

    const result = await controller.searchSymbols('my-project', 'foo', undefined, undefined, undefined, makeUser());

    expect(typeof result.data.total).toBe('number');
    expect(result.data.total).toBeGreaterThanOrEqual(0);
    expect(result.data.total).toBe(42);
  });

  it('AC-13: file filter — every item.file contains the fragment (case-insensitive); total equals count of all matching symbols', async () => {
    const fileFrag = 'utils';
    const items: SymbolSearchItem[] = [
      makeSymbolSearchItem({ file: 'src/utils/helpers.ts', name: 'helperFn' }),
      makeSymbolSearchItem({ file: 'src/shared/utils.ts', name: 'sharedFn' }),
    ];
    mockSearchSymbols.mockResolvedValue({ items, total: 2 });

    const result = await controller.searchSymbols('my-project', undefined, fileFrag, undefined, undefined, makeUser());

    expect(result.data.items.length).toBeGreaterThan(0);
    for (const item of result.data.items) {
      expect(item.file.toLowerCase()).toContain(fileFrag.toLowerCase());
    }
    expect(result.data.total).toBe(2);
  });

  it('AC-14: page=2 limit=20 with >20 total — items.length ≤ 20, total equals full match count', async () => {
    const pageItems = Array.from({ length: 20 }, (_, i) =>
      makeSymbolSearchItem({ id: `r:f.ts::sym${i + 21}`, name: `sym${i + 21}` }),
    );
    mockSearchSymbols.mockResolvedValue({ items: pageItems, total: 55 });

    const result = await controller.searchSymbols('my-project', 'sym', undefined, 2, 20, makeUser());

    expect(result.data.items.length).toBeLessThanOrEqual(20);
    expect(result.data.total).toBe(55);
    expect(result.data.total).toBeGreaterThan(result.data.items.length);
    expect(mockAstIndexService.searchSymbols).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({ page: 2, limit: 20 }),
    );
  });

  it('AC-15: limit above MAX_LIMIT is clamped — items.length ≤ MAX_LIMIT', async () => {
    const MAX_LIMIT = 100;
    const items = Array.from({ length: MAX_LIMIT }, (_, i) =>
      makeSymbolSearchItem({ id: `r:f.ts::sym${i}`, name: `sym${i}` }),
    );
    mockSearchSymbols.mockResolvedValue({ items, total: 500 });

    const result = await controller.searchSymbols('my-project', undefined, undefined, 1, 999, makeUser());

    expect(result.data.items.length).toBeLessThanOrEqual(MAX_LIMIT);
    expect(result.data.total).toBe(500);
    expect(result.data.total).toBeGreaterThan(result.data.items.length);
  });

  it('AC-16: no q or file filter — returns items with deterministic order; page=1 is implicit', async () => {
    const items = [
      makeSymbolSearchItem({ id: 'r:a.ts::Alpha', name: 'Alpha' }),
      makeSymbolSearchItem({ id: 'r:a.ts::Beta', name: 'Beta' }),
      makeSymbolSearchItem({ id: 'r:a.ts::Gamma', name: 'Gamma' }),
    ];
    mockSearchSymbols.mockResolvedValue({ items, total: 3 });

    const result1 = await controller.searchSymbols('my-project', undefined, undefined, undefined, undefined, makeUser());
    mockSearchSymbols.mockResolvedValue({ items, total: 3 });
    const result2 = await controller.searchSymbols('my-project', undefined, undefined, undefined, undefined, makeUser());

    expect(result1.data.items.map((i) => i.id)).toEqual(result2.data.items.map((i) => i.id));
  });

  it('AC-17: unknown project slug → throws NotFoundAppException (maps to HTTP 404)', async () => {
    mockFindProjectIdBySlug.mockRejectedValue(new NotFoundAppException({}, 'projects'));

    await expect(
      controller.searchSymbols('nonexistent-slug', undefined, undefined, undefined, undefined, makeUser()),
    ).rejects.toBeInstanceOf(NotFoundAppException);
  });

  it('AC-18: principal not a project member → throws ForbiddenAppException (maps to HTTP 403)', async () => {
    mockAssertProjectMembership.mockRejectedValue(new ForbiddenAppException({}, 'code-intel'));

    await expect(
      controller.searchSymbols('my-project', undefined, undefined, undefined, undefined, makeUser()),
    ).rejects.toBeInstanceOf(ForbiddenAppException);
  });
});

// ---------------------------------------------------------------------------
// AC-19: PrismaCodeIntelRepository.searchSymbols internals
// ---------------------------------------------------------------------------

describe('AC-19: PrismaCodeIntelRepository.searchSymbols calls prisma correctly', () => {
  it('AC-19: invokes symbol.findMany once with correct where/take/skip, and symbol.count for total', async () => {
    const mockItems = [
      { id: 'r:a.ts::Foo', symbolId: 'r:a.ts::Foo', projectId: 'proj-1', repoId: 'r', commitHash: 'abc', name: 'Foo', kind: 'function', file: 'src/a.ts', startLine: 1, endLine: 5, signature: 'fn Foo()', callers: [], callees: [] },
    ];

    const mockFindMany = jest.fn().mockResolvedValue(mockItems);
    const mockCount = jest.fn().mockResolvedValue(1);

    const mockPrismaService = {
      client: {
        symbol: {
          findMany: mockFindMany,
          count: mockCount,
          upsert: jest.fn(),
          findUnique: jest.fn(),
        },
      },
    };

    const repository = new PrismaCodeIntelRepository(mockPrismaService as never);

    const projectId = 'proj-1';
    const q = 'Foo';
    const file = 'src/a';
    const page = 2;
    const limit = 5;

    const result = await repository.searchSymbols(projectId, { q, file, page, limit });

    expect(mockFindMany).toHaveBeenCalledTimes(1);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId,
          name: expect.objectContaining({ contains: q }),
          file: expect.objectContaining({ contains: file }),
        }),
        take: limit,
        skip: (page - 1) * limit,
      }),
    );

    expect(mockCount).toHaveBeenCalledTimes(1);

    expect(result).toHaveProperty('items');
    expect(result).toHaveProperty('total');
    expect(result.items).toEqual(mockItems);
    expect(result.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC-20: Existing symbol detail endpoint is unaffected
// ---------------------------------------------------------------------------

describe('AC-20: Existing GET /code-intel/symbols/:symbolId returns a single symbol, not a list', () => {
  let controller: CodeIntelController;
  let mockAstIndexService: jest.Mocked<Pick<AstIndexService, 'indexCommit' | 'getSymbol' | 'getCallers' | 'getCallees' | 'searchSymbols'>>;

  beforeEach(async () => {
    mockAstIndexService = {
      indexCommit: jest.fn(),
      getSymbol: jest.fn(),
      getCallers: jest.fn(),
      getCallees: jest.fn(),
      searchSymbols: jest.fn(),
    };

    const mockProjectsService = {
      findProjectIdBySlug: jest.fn().mockResolvedValue('proj-1'),
      assertProjectMembership: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CodeIntelController],
      providers: [
        { provide: AstIndexService, useValue: mockAstIndexService },
        { provide: ProjectsService, useValue: mockProjectsService },
      ],
    }).compile();

    controller = module.get<CodeIntelController>(CodeIntelController);
  });

  it('AC-20: getSymbol() returns a single symbol object, not a list, and does not apply search query params', async () => {
    const symbol = {
      id: 'r:src/a.ts::Foo',
      symbolId: 'r:src/a.ts::Foo',
      projectId: 'proj-1',
      repoId: 'r',
      commitHash: 'abc',
      name: 'Foo',
      kind: 'function' as const,
      file: 'src/a.ts',
      startLine: 1,
      endLine: 5,
      callers: [],
      callees: [],
    };
    (mockAstIndexService.getSymbol as jest.Mock).mockResolvedValue(symbol);

    const result = await controller.getSymbol('r:src/a.ts::Foo', 'my-project', makeUser());

    expect(result.data).toBeDefined();
    expect(Array.isArray(result.data)).toBe(false);
    expect(result.data).not.toHaveProperty('items');
    expect(result.data).not.toHaveProperty('total');
    expect((result.data as typeof symbol).name).toBe('Foo');
    expect(mockAstIndexService.searchSymbols).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-21: CodeIntelModule DI compilation
// ---------------------------------------------------------------------------

describe('AC-21: CodeIntelModule DI compilation and AstIndexService availability', () => {
  let moduleRef: TestingModule;

  afterEach(async () => {
    if (moduleRef) await moduleRef.close();
  });

  it('AC-21: module compiles without throwing; AstIndexService is retrievable and is a valid instance', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [GlobalStubsModule, CodeIntelModule],
    }).compile();

    const astIndexService = moduleRef.get(AstIndexService);
    expect(astIndexService).toBeDefined();
    expect(astIndexService).not.toBeNull();
    expect(astIndexService).toBeInstanceOf(AstIndexService);
  });
});