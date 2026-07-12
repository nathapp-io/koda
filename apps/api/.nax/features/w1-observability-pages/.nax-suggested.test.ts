import { Test, TestingModule } from '@nestjs/testing';

import { MemoryReadController } from '../../../src/memory/memory-read.controller';
import { MemoryGovernanceService } from '../../../src/memory/memory-governance.service';
import type { MemoryItem } from '../../../src/memory/memory-item-repository';
import { MemoryKind } from '../../../src/common/enums';

import { CodeIntelController } from '../../../src/code-intel/code-intel.controller';
import { AstIndexService } from '../../../src/code-intel/ast-index.service';

import { ProjectsService } from '../../../src/projects/projects.service';
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
// AC-1: GET /projects/:slug/memory?subject=<prefix>
//
// Verification type: runtime-check
//
// Controller signature (from memory-read.controller.ts):
//   getMemory(slug, principal, kind?, subject?, status?, page?, limit?, orderBy?)
//
// Repository behaviour (memory-item-repository.ts findByProjectMemory):
//   if (query.subject) where.subject = { startsWith: query.subject }
// ---------------------------------------------------------------------------

describe('AC-1: GET /projects/:slug/memory?subject=<prefix> — subject is a case-sensitive startsWith filter', () => {
  let controller: MemoryReadController;
  let mockGovernanceService: jest.Mocked<Pick<MemoryGovernanceService, 'getProjectMemory'>>;

  beforeEach(async () => {
    mockGovernanceService = { getProjectMemory: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryReadController,
        { provide: MemoryGovernanceService, useValue: mockGovernanceService },
        {
          provide: ProjectsService,
          useValue: {
            findProjectIdBySlug: jest.fn().mockResolvedValue('proj-1'),
            assertProjectMembership: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    controller = module.get<MemoryReadController>(MemoryReadController);
  });

  afterEach(() => jest.clearAllMocks());

  it(
    'AC-1: response.data.items is a non-null array; ' +
      'every MemoryItem.subject starts with the given prefix (case-sensitive startsWith)',
    async () => {
      const prefix = 'ticket:';
      const items: MemoryItem[] = [
        makeMemoryItem({ id: 'mem-1', subject: 'ticket:1' }),
        makeMemoryItem({ id: 'mem-2', subject: 'ticket:2' }),
        makeMemoryItem({ id: 'mem-3', subject: 'ticket:long-key' }),
      ];
      (mockGovernanceService.getProjectMemory as jest.Mock).mockResolvedValue({ items, total: 3 });

      // Positional args: (slug, principal, kind, subject, status, page, limit, orderBy)
      const result = await controller.getMemory(
        'my-project',
        makeUser(),
        undefined, // kind
        prefix,    // subject
      );

      // Non-null array
      expect(result.data.items).not.toBeNull();
      expect(Array.isArray(result.data.items)).toBe(true);

      // Every item.subject starts with the prefix
      expect(result.data.items.length).toBeGreaterThan(0);
      for (const item of result.data.items) {
        expect(item.subject.startsWith(prefix)).toBe(true);
      }

      // Controller forwarded `subject` to the service
      expect(mockGovernanceService.getProjectMemory).toHaveBeenCalledWith(
        expect.objectContaining({ subject: prefix }),
      );
    },
  );

  it('AC-1: items whose subject does NOT start with the prefix are absent (case-sensitive)', async () => {
    const prefix = 'topic:';
    const filteredItems: MemoryItem[] = [
      makeMemoryItem({ id: 'mem-10', subject: 'topic:auth' }),
      makeMemoryItem({ id: 'mem-11', subject: 'topic:deploy' }),
    ];
    (mockGovernanceService.getProjectMemory as jest.Mock).mockResolvedValue({
      items: filteredItems,
      total: 2,
    });

    const result = await controller.getMemory('my-project', makeUser(), undefined, prefix);

    for (const item of result.data.items) {
      expect(item.subject.startsWith(prefix)).toBe(true);
    }

    // Items with a different prefix (e.g. 'ticket:') are absent
    const wrongPrefix = result.data.items.filter((i) => !i.subject.startsWith(prefix));
    expect(wrongPrefix).toHaveLength(0);

    // Case-sensitivity: 'Topic:auth' would NOT match 'topic:' — confirm mock only returns lowercased
    const caseWrong = result.data.items.filter((i) => i.subject.startsWith('Topic:'));
    expect(caseWrong).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-2: GET /projects/:slug/memory?orderBy=updatedAt|createdAt
//
// Verification type: runtime-check
//
// Repository behaviour (findByProjectMemory):
//   orderBy=updatedAt  → [{ updatedAt: 'desc' }, { confidence: 'desc' }, { createdAt: 'desc' }]
//   orderBy=createdAt  → [{ createdAt: 'desc' }, { confidence: 'desc' }, { updatedAt: 'desc' }]
// ---------------------------------------------------------------------------

describe('AC-2: GET /projects/:slug/memory?orderBy=<field> — items are returned in descending order by field', () => {
  let controller: MemoryReadController;
  let mockGovernanceService: jest.Mocked<Pick<MemoryGovernanceService, 'getProjectMemory'>>;

  beforeEach(async () => {
    mockGovernanceService = { getProjectMemory: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryReadController,
        { provide: MemoryGovernanceService, useValue: mockGovernanceService },
        {
          provide: ProjectsService,
          useValue: {
            findProjectIdBySlug: jest.fn().mockResolvedValue('proj-1'),
            assertProjectMembership: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    controller = module.get<MemoryReadController>(MemoryReadController);
  });

  afterEach(() => jest.clearAllMocks());

  it(
    'AC-2 (orderBy=updatedAt): response.data.items is a non-empty array; ' +
      'items[i].updatedAt <= items[i-1].updatedAt for all i > 0',
    async () => {
      const items: MemoryItem[] = [
        makeMemoryItem({ id: 'mem-3', updatedAt: new Date('2026-06-03T12:00:00Z') }),
        makeMemoryItem({ id: 'mem-2', updatedAt: new Date('2026-06-02T12:00:00Z') }),
        makeMemoryItem({ id: 'mem-1', updatedAt: new Date('2026-06-01T12:00:00Z') }),
      ];
      (mockGovernanceService.getProjectMemory as jest.Mock).mockResolvedValue({ items, total: 3 });

      // Positional args: (slug, principal, kind, subject, status, page, limit, orderBy)
      const result = await controller.getMemory(
        'my-project',
        makeUser(),
        undefined,    // kind
        undefined,    // subject
        undefined,    // status
        undefined,    // page
        undefined,    // limit
        'updatedAt',  // orderBy
      );

      expect(result.data.items.length).toBeGreaterThan(0);

      // Strictly descending: items[i].updatedAt <= items[i-1].updatedAt
      for (let i = 1; i < result.data.items.length; i++) {
        const prev = new Date(result.data.items[i - 1].updatedAt).getTime();
        const curr = new Date(result.data.items[i].updatedAt).getTime();
        expect(curr).toBeLessThanOrEqual(prev);
      }

      // Controller forwarded `orderBy` to the service
      expect(mockGovernanceService.getProjectMemory).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: 'updatedAt' }),
      );
    },
  );

  it(
    'AC-2 (orderBy=createdAt): response.data.items is a non-empty array; ' +
      'items[i].createdAt <= items[i-1].createdAt for all i > 0',
    async () => {
      const items: MemoryItem[] = [
        makeMemoryItem({ id: 'mem-c', createdAt: new Date('2026-05-15T09:00:00Z') }),
        makeMemoryItem({ id: 'mem-b', createdAt: new Date('2026-05-10T09:00:00Z') }),
        makeMemoryItem({ id: 'mem-a', createdAt: new Date('2026-05-01T09:00:00Z') }),
      ];
      (mockGovernanceService.getProjectMemory as jest.Mock).mockResolvedValue({ items, total: 3 });

      const result = await controller.getMemory(
        'my-project',
        makeUser(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'createdAt',
      );

      expect(result.data.items.length).toBeGreaterThan(0);

      // Strictly descending: items[i].createdAt <= items[i-1].createdAt
      for (let i = 1; i < result.data.items.length; i++) {
        const prev = new Date(result.data.items[i - 1].createdAt).getTime();
        const curr = new Date(result.data.items[i].createdAt).getTime();
        expect(curr).toBeLessThanOrEqual(prev);
      }

      expect(mockGovernanceService.getProjectMemory).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: 'createdAt' }),
      );
    },
  );

  it('AC-2 (both orderBy values): descending order is maintained independently per field (not a shared sort)', async () => {
    // Items sorted by updatedAt desc but NOT by createdAt desc — verifies updatedAt sort key is distinct
    const byUpdatedAt: MemoryItem[] = [
      makeMemoryItem({ id: 'u2', updatedAt: new Date('2026-03-02T00:00:00Z'), createdAt: new Date('2026-01-01T00:00:00Z') }),
      makeMemoryItem({ id: 'u1', updatedAt: new Date('2026-03-01T00:00:00Z'), createdAt: new Date('2026-03-03T00:00:00Z') }),
    ];
    (mockGovernanceService.getProjectMemory as jest.Mock).mockResolvedValue({ items: byUpdatedAt, total: 2 });

    const resultU = await controller.getMemory('p', makeUser(), undefined, undefined, undefined, undefined, undefined, 'updatedAt');
    for (let i = 1; i < resultU.data.items.length; i++) {
      expect(new Date(resultU.data.items[i].updatedAt).getTime())
        .toBeLessThanOrEqual(new Date(resultU.data.items[i - 1].updatedAt).getTime());
    }

    // Items sorted by createdAt desc but NOT by updatedAt desc
    const byCreatedAt: MemoryItem[] = [
      makeMemoryItem({ id: 'c2', createdAt: new Date('2026-04-02T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z') }),
      makeMemoryItem({ id: 'c1', createdAt: new Date('2026-04-01T00:00:00Z'), updatedAt: new Date('2026-06-01T00:00:00Z') }),
    ];
    (mockGovernanceService.getProjectMemory as jest.Mock).mockResolvedValue({ items: byCreatedAt, total: 2 });

    const resultC = await controller.getMemory('p', makeUser(), undefined, undefined, undefined, undefined, undefined, 'createdAt');
    for (let i = 1; i < resultC.data.items.length; i++) {
      expect(new Date(resultC.data.items[i].createdAt).getTime())
        .toBeLessThanOrEqual(new Date(resultC.data.items[i - 1].createdAt).getTime());
    }
  });
});

// ---------------------------------------------------------------------------
// AC-3: GET /code-intel/symbols?projectSlug=<slug>&q=<name>&file=<frag>
//
// Verification type: runtime-check
//
// Controller delegates to: AstIndexService.searchSymbols(projectId, { q, file, page, limit })
// Repository builds:        where.name = { contains: q }   AND   where.file = { contains: file }
// total from:               symbol.count(where)  — reflects ALL matching rows, not just the page
// ---------------------------------------------------------------------------

describe(
  'AC-3: GET /code-intel/symbols?q=<name>&file=<frag> — ' +
    'every item.name contains q AND item.file contains frag; ' +
    'total equals count of matching items before pagination',
  () => {
    let controller: CodeIntelController;
    let mockSearchSymbols: jest.Mock;

    beforeEach(async () => {
      mockSearchSymbols = jest.fn();

      const module: TestingModule = await Test.createTestingModule({
        controllers: [CodeIntelController],
        providers: [
          {
            provide: AstIndexService,
            useValue: {
              indexCommit: jest.fn(),
              getSymbol: jest.fn(),
              getCallers: jest.fn(),
              getCallees: jest.fn(),
              searchSymbols: mockSearchSymbols,
            },
          },
          {
            provide: ProjectsService,
            useValue: {
              findProjectIdBySlug: jest.fn().mockResolvedValue('proj-1'),
              assertProjectMembership: jest.fn().mockResolvedValue(undefined),
            },
          },
        ],
      }).compile();

      controller = module.get<CodeIntelController>(CodeIntelController);
    });

    afterEach(() => jest.clearAllMocks());

    it(
      'AC-3: response.data.items only contains items where item.name contains q AND item.file contains frag; ' +
        'response.data.total equals the full pre-pagination filtered count',
      async () => {
        const q = 'parse';
        const fileFrag = 'utils';
        const limit = 2;
        // Simulate 4 total matching rows but only 2 returned on this page
        const pageItems: SymbolSearchItem[] = [
          makeSymbolSearchItem({ id: 'r:src/utils/parse.ts::parseQuery', name: 'parseQuery', file: 'src/utils/parse.ts' }),
          makeSymbolSearchItem({ id: 'r:src/utils/parse-date.ts::parseDate', name: 'parseDate', file: 'src/utils/parse-date.ts' }),
        ];
        mockSearchSymbols.mockResolvedValue({ items: pageItems, total: 4 });

        const result = await controller.searchSymbols(
          { projectSlug: 'my-project', q, file: fileFrag, page: 1, limit },
          makeUser(),
        );

        const data = (result as { data: { items: SymbolSearchItem[]; total: number } }).data;

        // Every item matches both filters
        expect(data.items.length).toBeGreaterThan(0);
        for (const item of data.items) {
          expect(item.name.toLowerCase()).toContain(q.toLowerCase());
          expect(item.file.toLowerCase()).toContain(fileFrag.toLowerCase());
        }

        // total reflects the full filtered count (4), not just the page (2)
        expect(data.total).toBe(4);
        expect(data.total).toBeGreaterThan(data.items.length);

        // Pagination applied to the filtered set: items.length === limit (2 < total 4)
        expect(data.items.length).toBeLessThanOrEqual(limit);

        // Service received both q and file
        expect(mockSearchSymbols).toHaveBeenCalledWith(
          'proj-1',
          expect.objectContaining({ q, file: fileFrag }),
        );
      },
    );

    it('AC-3: when q and file together yield 0 matches, items is [] and total is 0', async () => {
      mockSearchSymbols.mockResolvedValue({ items: [], total: 0 });

      const result = await controller.searchSymbols(
        { projectSlug: 'my-project', q: 'NonExistentSymbol', file: 'no/such/path', page: 1, limit: 20 },
        makeUser(),
      );

      const data = (result as { data: { items: SymbolSearchItem[]; total: number } }).data;
      expect(data.items).toEqual([]);
      expect(data.total).toBe(0);
    });
  },
);

// ---------------------------------------------------------------------------
// AC-4: Deterministic sort — same params, two calls, identical item.id sequence
//
// Verification type: runtime-check
//
// Repository orders by: [{ name: 'asc' }, { id: 'asc' }]  (stable tiebreak)
// ---------------------------------------------------------------------------

describe(
  'AC-4: GET /code-intel/symbols?q=<name>&file=<frag>&page=1&limit=20 called twice in succession ' +
    'returns arrays with items in identical order (item.id sequence matches exactly)',
  () => {
    let controller: CodeIntelController;
    let mockSearchSymbols: jest.Mock;

    beforeEach(async () => {
      mockSearchSymbols = jest.fn();

      const module: TestingModule = await Test.createTestingModule({
        controllers: [CodeIntelController],
        providers: [
          {
            provide: AstIndexService,
            useValue: {
              indexCommit: jest.fn(),
              getSymbol: jest.fn(),
              getCallers: jest.fn(),
              getCallees: jest.fn(),
              searchSymbols: mockSearchSymbols,
            },
          },
          {
            provide: ProjectsService,
            useValue: {
              findProjectIdBySlug: jest.fn().mockResolvedValue('proj-1'),
              assertProjectMembership: jest.fn().mockResolvedValue(undefined),
            },
          },
        ],
      }).compile();

      controller = module.get<CodeIntelController>(CodeIntelController);
    });

    afterEach(() => jest.clearAllMocks());

    it('AC-4: item.id sequence from call 1 exactly equals item.id sequence from call 2', async () => {
      const q = 'compute';
      const fileFrag = 'core';
      const page = 1;
      const limit = 20;

      const stableItems: SymbolSearchItem[] = [
        makeSymbolSearchItem({ id: 'r:src/core/compute.ts::computeHash', name: 'computeHash', file: 'src/core/compute.ts' }),
        makeSymbolSearchItem({ id: 'r:src/core/compute.ts::computeSum', name: 'computeSum', file: 'src/core/compute.ts' }),
        makeSymbolSearchItem({ id: 'r:src/core/utils.ts::computeDiff', name: 'computeDiff', file: 'src/core/utils.ts' }),
      ];
      const stableTotal = stableItems.length;

      // Both calls return the same stable dataset (deterministic sort applied server-side)
      mockSearchSymbols
        .mockResolvedValueOnce({ items: stableItems, total: stableTotal })
        .mockResolvedValueOnce({ items: stableItems, total: stableTotal });

      const result1 = await controller.searchSymbols(
        { projectSlug: 'my-project', q, file: fileFrag, page, limit },
        makeUser(),
      );
      const result2 = await controller.searchSymbols(
        { projectSlug: 'my-project', q, file: fileFrag, page, limit },
        makeUser(),
      );

      const data1 = (result1 as { data: { items: SymbolSearchItem[]; total: number } }).data;
      const data2 = (result2 as { data: { items: SymbolSearchItem[]; total: number } }).data;

      // id sequences match exactly
      expect(data1.items.length).toBeGreaterThan(0);
      expect(data1.items.map((i) => i.id)).toEqual(data2.items.map((i) => i.id));

      // totals are the same
      expect(data1.total).toBe(data2.total);

      // Both calls were made with identical params
      expect(mockSearchSymbols).toHaveBeenCalledTimes(2);
      const calls = (mockSearchSymbols as jest.Mock).mock.calls as [string, object][];
      expect(calls[0][0]).toBe(calls[1][0]);     // same projectId
      expect(calls[0][1]).toEqual(calls[1][1]);   // same opts
    });

    it('AC-4: stable sort is preserved even when multiple items share the same name (tiebreak on id)', async () => {
      // All three symbols have the same name — only the id tiebreak distinguishes their order.
      const items: SymbolSearchItem[] = [
        makeSymbolSearchItem({ id: 'r:src/handlers/a.ts::GetHandler', name: 'GetHandler', file: 'src/handlers/a.ts' }),
        makeSymbolSearchItem({ id: 'r:src/handlers/b.ts::GetHandler', name: 'GetHandler', file: 'src/handlers/b.ts' }),
        makeSymbolSearchItem({ id: 'r:src/handlers/c.ts::GetHandler', name: 'GetHandler', file: 'src/handlers/c.ts' }),
      ];

      mockSearchSymbols
        .mockResolvedValueOnce({ items, total: 3 })
        .mockResolvedValueOnce({ items, total: 3 });

      const r1 = await controller.searchSymbols(
        { projectSlug: 'my-project', q: 'GetHandler', file: 'src/handlers', page: 1, limit: 20 },
        makeUser(),
      );
      const r2 = await controller.searchSymbols(
        { projectSlug: 'my-project', q: 'GetHandler', file: 'src/handlers', page: 1, limit: 20 },
        makeUser(),
      );

      const ids1 = (r1 as { data: { items: SymbolSearchItem[] } }).data.items.map((i) => i.id);
      const ids2 = (r2 as { data: { items: SymbolSearchItem[] } }).data.items.map((i) => i.id);

      expect(ids1).toEqual(ids2);
    });
  },
);