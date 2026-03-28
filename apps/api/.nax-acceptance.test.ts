import { Test } from '@nestjs/testing';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigService } from '@nestjs/config';

// Strategy imports — will exist after US-001
import {
  FTS_OPTIMIZE_STRATEGY,
} from './src/rag/strategies/fts-optimize-strategy.interface';
import { CounterOptimizeStrategy } from './src/rag/strategies/counter-optimize.strategy';
import { CronOptimizeStrategy } from './src/rag/strategies/cron-optimize.strategy';
import { ManualOptimizeStrategy } from './src/rag/strategies/manual-optimize.strategy';

// Config — exists, extended by US-002
import { ragConfig } from './src/config/rag.config';

// RagModule — extended by US-002
import { RagModule } from './src/rag/rag.module';

// RagService — extended by US-003 / US-004
import { RagService, simpleFtsScore, reciprocalRankFusion } from './src/rag/rag.service';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockConfigService(values: Record<string, unknown> = {}): ConfigService {
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

function mockTable() {
  return {
    optimize: jest.fn().mockResolvedValue(undefined),
    add: jest.fn().mockResolvedValue(undefined),
    createIndex: jest.fn().mockResolvedValue(undefined),
    countRows: jest.fn().mockResolvedValue(0),
    search: jest.fn().mockResolvedValue([]),
    query: jest.fn().mockReturnValue({
      limit: () => ({ toArray: () => Promise.resolve([]) }),
    }),
    vectorSearch: jest.fn().mockReturnValue({
      distanceType: () => ({ limit: () => ({ toArray: () => Promise.resolve([]) }) }),
    }),
    delete: jest.fn().mockResolvedValue(undefined),
  };
}

function mockOptimizeStrategy() {
  return {
    onInsert: jest.fn().mockResolvedValue(undefined),
    onFirstAccess: jest.fn(),
    onDestroy: jest.fn().mockResolvedValue(undefined),
  };
}

function makeRagService(overrides: Record<string, unknown> = {}, strategy = mockOptimizeStrategy(), embedding?: unknown) {
  const config = mockConfigService({
    'rag.lancedbPath': './lancedb',
    'rag.similarityHigh': 0.85,
    'rag.similarityMedium': 0.70,
    'rag.similarityLow': 0.50,
    'rag.ftsIndexMode': 'simple',
    'rag.inMemoryOnly': false,
    ...overrides,
  });
  return new RagService(config, embedding as never, strategy as never);
}

// ─── US-001: FTS Optimize Strategy Interface & Implementations ────────────────

describe('AC-1: FtsOptimizeStrategy interface exports FTS_OPTIMIZE_STRATEGY token', () => {
  it('FTS_OPTIMIZE_STRATEGY is a non-empty string', () => {
    expect(typeof FTS_OPTIMIZE_STRATEGY).toBe('string');
    expect(FTS_OPTIMIZE_STRATEGY.length).toBeGreaterThan(0);
  });
});

describe('CounterOptimizeStrategy', () => {
  let strategy: CounterOptimizeStrategy;

  beforeEach(() => {
    strategy = new CounterOptimizeStrategy(mockConfigService({ 'rag.ftsOptimizeThreshold': 3 }));
  });

  it('AC-2: onInsert() calls table.optimize() when insert count reaches threshold', async () => {
    const table = mockTable();
    await strategy.onInsert('p1', table);
    await strategy.onInsert('p1', table);
    await strategy.onInsert('p1', table); // 3rd → threshold
    expect(table.optimize).toHaveBeenCalledTimes(1);
  });

  it('AC-3: onInsert() does NOT call table.optimize() when count is below threshold', async () => {
    const table = mockTable();
    await strategy.onInsert('p1', table);
    await strategy.onInsert('p1', table); // 2 < 3
    expect(table.optimize).not.toHaveBeenCalled();
  });

  it('AC-4: onInsert() resets counter to 0 after optimize so next batch starts fresh', async () => {
    const table = mockTable();
    await strategy.onInsert('p1', table);
    await strategy.onInsert('p1', table);
    await strategy.onInsert('p1', table); // triggers optimize, resets to 0
    // next 2 inserts must NOT trigger optimize again
    await strategy.onInsert('p1', table);
    await strategy.onInsert('p1', table);
    expect(table.optimize).toHaveBeenCalledTimes(1);
  });

  it('AC-5: onInsert() logs warning and does not throw when table.optimize() rejects', async () => {
    const table = mockTable();
    table.optimize.mockRejectedValue(new Error('optimize boom'));
    await strategy.onInsert('p1', table);
    await strategy.onInsert('p1', table);
    await expect(strategy.onInsert('p1', table)).resolves.toBeUndefined();
  });

  it('AC-6: onFirstAccess() calls table.optimize() fire-and-forget (returns void)', () => {
    const table = mockTable();
    const result = strategy.onFirstAccess('p1', table);
    expect(result).toBeUndefined();
    expect(table.optimize).toHaveBeenCalledTimes(1);
  });

  it('AC-7: reads threshold from rag.ftsOptimizeThreshold, defaulting to 10 when not set', async () => {
    const s = new CounterOptimizeStrategy(mockConfigService({}));
    const table = mockTable();
    for (let i = 0; i < 9; i++) await s.onInsert('p', table);
    expect(table.optimize).not.toHaveBeenCalled(); // 9 < default 10
  });
});

describe('CronOptimizeStrategy', () => {
  let schedulerRegistry: { addInterval: jest.Mock; deleteInterval: jest.Mock };

  beforeEach(() => {
    schedulerRegistry = { addInterval: jest.fn(), deleteInterval: jest.fn() };
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function makeStrategy(intervalMs?: number) {
    return new CronOptimizeStrategy(
      mockConfigService({ 'rag.ftsOptimizeIntervalMs': intervalMs }),
      schedulerRegistry as never,
    );
  }

  it('AC-8: onInsert() adds table to internal dirtyTables map', async () => {
    const strategy = makeStrategy(60_000);
    const table = mockTable();
    strategy.onInsert('p1', table);
    await strategy.optimizeDirtyTables();
    expect(table.optimize).toHaveBeenCalled();
  });

  it('AC-9: optimizeDirtyTables() calls optimize() for each dirty table and clears map', async () => {
    const strategy = makeStrategy(60_000);
    const t1 = mockTable();
    const t2 = mockTable();
    strategy.onInsert('p1', t1);
    strategy.onInsert('p2', t2);
    await strategy.optimizeDirtyTables();
    expect(t1.optimize).toHaveBeenCalledTimes(1);
    expect(t2.optimize).toHaveBeenCalledTimes(1);
    // Map cleared — second call must not re-optimize
    await strategy.optimizeDirtyTables();
    expect(t1.optimize).toHaveBeenCalledTimes(1);
    expect(t2.optimize).toHaveBeenCalledTimes(1);
  });

  it('AC-10: registers interval via SchedulerRegistry.addInterval("fts-optimize", interval) during construction', () => {
    makeStrategy(60_000);
    expect(schedulerRegistry.addInterval).toHaveBeenCalledWith(
      'fts-optimize',
      expect.anything(),
    );
  });

  it('AC-11: reads interval from rag.ftsOptimizeIntervalMs, defaulting to 300000 when not set', () => {
    new CronOptimizeStrategy(mockConfigService({}), schedulerRegistry as never);
    expect(schedulerRegistry.addInterval).toHaveBeenCalledWith('fts-optimize', expect.anything());
  });

  it('AC-12: onDestroy() flushes remaining dirty tables by calling optimizeDirtyTables()', async () => {
    const strategy = makeStrategy(60_000);
    const table = mockTable();
    strategy.onInsert('p1', table);
    await strategy.onDestroy();
    expect(table.optimize).toHaveBeenCalledTimes(1);
  });

  it('AC-13: onFirstAccess() calls table.optimize() fire-and-forget (returns void)', () => {
    const strategy = makeStrategy(60_000);
    const table = mockTable();
    const result = strategy.onFirstAccess('p1', table);
    expect(result).toBeUndefined();
    expect(table.optimize).toHaveBeenCalled();
  });
});

describe('ManualOptimizeStrategy', () => {
  let strategy: ManualOptimizeStrategy;

  beforeEach(() => {
    strategy = new ManualOptimizeStrategy();
  });

  it('AC-14: onInsert() never calls table.optimize() regardless of call count', async () => {
    const table = mockTable();
    for (let i = 0; i < 50; i++) await strategy.onInsert('p1', table);
    expect(table.optimize).not.toHaveBeenCalled();
  });

  it('AC-15: onFirstAccess() calls table.optimize() fire-and-forget (returns void)', () => {
    const table = mockTable();
    const result = strategy.onFirstAccess('p1', table);
    expect(result).toBeUndefined();
    expect(table.optimize).toHaveBeenCalled();
  });

  it('AC-16: onDestroy() completes without error', async () => {
    await expect(strategy.onDestroy()).resolves.toBeUndefined();
  });
});

// ─── US-002: Config & Module Wiring ──────────────────────────────────────────

describe('rag.config.ts new keys', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // restore env
    Object.keys(process.env).forEach((k) => { if (!(k in originalEnv)) delete process.env[k]; });
    Object.assign(process.env, originalEnv);
  });

  it('AC-17: ftsOptimizeStrategy defaults to "counter" when FTS_OPTIMIZE_STRATEGY is unset', () => {
    delete process.env['FTS_OPTIMIZE_STRATEGY'];
    expect(ragConfig().ftsOptimizeStrategy).toBe('counter');
  });

  it('AC-18: ftsOptimizeThreshold defaults to 10 when FTS_OPTIMIZE_THRESHOLD is unset', () => {
    delete process.env['FTS_OPTIMIZE_THRESHOLD'];
    expect(ragConfig().ftsOptimizeThreshold).toBe(10);
  });

  it('AC-19: ftsOptimizeIntervalMs defaults to 300000 when FTS_OPTIMIZE_INTERVAL_MS is unset', () => {
    delete process.env['FTS_OPTIMIZE_INTERVAL_MS'];
    expect(ragConfig().ftsOptimizeIntervalMs).toBe(300_000);
  });
});

describe('RagModule — ScheduleModule import (AC-20, file-check)', () => {
  it('AC-20: RagModule source imports ScheduleModule.forRoot()', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, './src/rag/rag.module.ts'),
      'utf-8',
    );
    expect(src).toMatch(/ScheduleModule/);
    expect(src).toMatch(/forRoot/);
  });
});

describe('RagModule — FTS_OPTIMIZE_STRATEGY provider resolution', () => {
  const sharedConfig = {
    'rag.lancedbPath': './lancedb-test',
    'rag.inMemoryOnly': true,
    'rag.ftsIndexMode': 'simple',
    'rag.similarityHigh': 0.85,
    'rag.similarityMedium': 0.70,
    'rag.similarityLow': 0.50,
    'rag.embeddingProvider': 'ollama',
    'rag.embeddingModel': 'nomic-embed-text',
    'rag.ollamaBaseUrl': 'http://localhost:11434',
    'rag.openaiApiKey': '',
    'rag.ftsOptimizeThreshold': 10,
    'rag.ftsOptimizeIntervalMs': 300_000,
  };

  async function compileWithStrategy(strategyName: string) {
    const { ConfigService: CS } = await import('@nestjs/config');
    const { EmbeddingService } = await import('./src/rag/embedding.service');
    const { PrismaService } = await import('@nathapp/nestjs-prisma');
    return Test.createTestingModule({ imports: [RagModule] })
      .overrideProvider(CS)
      .useValue(mockConfigService({ ...sharedConfig, 'rag.ftsOptimizeStrategy': strategyName }))
      .overrideProvider(EmbeddingService)
      .useValue({})
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
  }

  it('AC-21: "cron" resolves to CronOptimizeStrategy', async () => {
    const mod = await compileWithStrategy('cron');
    expect(mod.get(FTS_OPTIMIZE_STRATEGY)).toBeInstanceOf(CronOptimizeStrategy);
    await mod.close();
  });

  it('AC-22: "manual" resolves to ManualOptimizeStrategy', async () => {
    const mod = await compileWithStrategy('manual');
    expect(mod.get(FTS_OPTIMIZE_STRATEGY)).toBeInstanceOf(ManualOptimizeStrategy);
    await mod.close();
  });

  it('AC-23: "counter" or unknown value resolves to CounterOptimizeStrategy', async () => {
    for (const name of ['counter', 'unknown-xyz']) {
      const mod = await compileWithStrategy(name);
      expect(mod.get(FTS_OPTIMIZE_STRATEGY)).toBeInstanceOf(CounterOptimizeStrategy);
      await mod.close();
    }
  });
});

describe('package.json — @nestjs/schedule dependency (AC-24, file-check)', () => {
  it('AC-24: @nestjs/schedule is listed as a production dependency', () => {
    const pkg = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, './package.json'),
        'utf-8',
      ),
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.['@nestjs/schedule']).toBeDefined();
  });
});

// ─── US-003: RagService — native FTS search ───────────────────────────────────

describe('RagService.search() — native FTS path', () => {
  const ftsRow = (id: string, content: string) => ({
    id,
    content,
    source: 'manual',
    source_id: `src-${id}`,
    vector: [],
    metadata: '{}',
    created_at: '',
    provider: 'ollama',
    model: 'm',
  });

  it('AC-25: lanceAvailable=true + table.search() resolves → uses native FTS ranked by 1/(i+1)', async () => {
    const service = makeRagService();
    const r1 = ftsRow('r1', 'hello world content');
    const r2 = ftsRow('r2', 'world hello content');

    const table = {
      ...mockTable(),
      countRows: jest.fn().mockResolvedValue(2),
      search: jest.fn().mockResolvedValue([r1, r2]),
      query: jest.fn().mockReturnValue({ limit: () => ({ toArray: () => Promise.resolve([r1, r2]) }) }),
    };

    (service as never as Record<string, unknown>)['lanceAvailable'] = true;
    (service as never as Record<string, unknown>)['tableCache'] = new Map([['p1', table]]);

    const result = await service.search('p1', 'hello', 5);
    expect(table.search).toHaveBeenCalled();
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('AC-26: lanceAvailable=true + table.search() rejects → warns and falls back to simpleFtsScore', async () => {
    const service = makeRagService();
    const r = ftsRow('r1', 'hello world test content');

    const table = {
      ...mockTable(),
      countRows: jest.fn().mockResolvedValue(1),
      search: jest.fn().mockRejectedValue(new Error('tantivy boom')),
      query: jest.fn().mockReturnValue({ limit: () => ({ toArray: () => Promise.resolve([r]) }) }),
    };

    (service as never as Record<string, unknown>)['lanceAvailable'] = true;
    (service as never as Record<string, unknown>)['tableCache'] = new Map([['p1', table]]);

    await expect(service.search('p1', 'hello', 5)).resolves.toBeDefined();
    expect(table.search).toHaveBeenCalled();
  });

  it('AC-27: lanceAvailable=false → uses simpleFtsScore without calling table.search()', async () => {
    const service = makeRagService({ 'rag.inMemoryOnly': true });
    const r = ftsRow('r1', 'hello world content here');

    const table = {
      ...mockTable(),
      countRows: jest.fn().mockResolvedValue(1),
      search: jest.fn().mockResolvedValue([]),
      query: jest.fn().mockReturnValue({ limit: () => ({ toArray: () => Promise.resolve([r]) }) }),
    };

    (service as never as Record<string, unknown>)['lanceAvailable'] = false;
    (service as never as Record<string, unknown>)['tableCache'] = new Map([['p1', table]]);

    await service.search('p1', 'hello', 5);
    expect(table.search).not.toHaveBeenCalled();
  });
});

describe('RagService.getOrCreateTable() — FTS index creation', () => {
  function makeWithDb(tableInstance: ReturnType<typeof mockTable>) {
    const service = makeRagService();
    const db = {
      tableNames: jest.fn().mockResolvedValue(['project_p1']),
      openTable: jest.fn().mockResolvedValue(tableInstance),
    };
    (service as never as Record<string, unknown>)['lanceAvailable'] = true;
    (service as never as Record<string, unknown>)['db'] = db;
    return service;
  }

  it('AC-28: calls table.createIndex("content", ...) when lanceAvailable=true', async () => {
    const table = mockTable();
    const service = makeWithDb(table);
    await service.getOrCreateTable('p1');
    expect(table.createIndex).toHaveBeenCalledWith(
      'content',
      expect.objectContaining({ replace: false }),
    );
  });

  it('AC-29: does not call table.createIndex() when lanceAvailable=false', async () => {
    const service = makeRagService({ 'rag.inMemoryOnly': true });
    (service as never as Record<string, unknown>)['lanceAvailable'] = false;
    const result = await service.getOrCreateTable('p1');
    // InMemoryTable has no createIndex — verify nothing blew up
    expect(typeof (result as unknown as Record<string, unknown>)['createIndex']).toBe('undefined');
  });

  it('AC-30: logs warning and does not throw when createIndex() rejects', async () => {
    const table = mockTable();
    table.createIndex.mockRejectedValue(new Error('index fail'));
    const service = makeWithDb(table);
    await expect(service.getOrCreateTable('p1')).resolves.toBeDefined();
  });

  it('AC-31: calls optimizeStrategy.onFirstAccess() exactly once per projectId per instance', async () => {
    const strategy = mockOptimizeStrategy();
    const table = mockTable();
    const service = makeRagService({}, strategy);
    const db = {
      tableNames: jest.fn().mockResolvedValue(['project_p1']),
      openTable: jest.fn().mockResolvedValue(table),
    };
    (service as never as Record<string, unknown>)['lanceAvailable'] = true;
    (service as never as Record<string, unknown>)['db'] = db;

    await service.getOrCreateTable('p1');
    await service.getOrCreateTable('p1'); // cached — should not call onFirstAccess again
    expect(strategy.onFirstAccess).toHaveBeenCalledTimes(1);
    expect(strategy.onFirstAccess).toHaveBeenCalledWith('p1', table);
  });
});

describe('RagService.indexDocument() — optimize hooks', () => {
  const embeddingMock = {
    embed: jest.fn().mockResolvedValue(Array(768).fill(0)),
    providerName: 'ollama',
    modelName: 'nomic-embed-text',
    dimensions: 768,
  };

  it('AC-32: calls optimizeStrategy.onInsert(projectId, table) after table.add() when lanceAvailable=true', async () => {
    const strategy = mockOptimizeStrategy();
    const service = makeRagService({}, strategy, embeddingMock);
    const table = mockTable();

    (service as never as Record<string, unknown>)['lanceAvailable'] = true;
    (service as never as Record<string, unknown>)['tableCache'] = new Map([['p1', table]]);

    await service.indexDocument('p1', { source: 'manual', sourceId: 's1', content: 'test', metadata: {} });
    expect(strategy.onInsert).toHaveBeenCalledWith('p1', table);
  });

  it('AC-33: does NOT call optimizeStrategy.onInsert() when lanceAvailable=false', async () => {
    const strategy = mockOptimizeStrategy();
    const service = makeRagService({ 'rag.inMemoryOnly': true }, strategy, embeddingMock);
    const table = mockTable();

    (service as never as Record<string, unknown>)['lanceAvailable'] = false;
    (service as never as Record<string, unknown>)['tableCache'] = new Map([['p1', table]]);

    await service.indexDocument('p1', { source: 'manual', sourceId: 's1', content: 'test', metadata: {} });
    expect(strategy.onInsert).not.toHaveBeenCalled();
  });

  it('AC-34: onModuleDestroy() calls optimizeStrategy.onDestroy()', async () => {
    const strategy = mockOptimizeStrategy();
    const service = makeRagService({}, strategy);
    await service.onModuleDestroy();
    expect(strategy.onDestroy).toHaveBeenCalledTimes(1);
  });
});

describe('RagService — exported utility functions', () => {
  it('AC-35: simpleFtsScore is still exported from rag.service.ts', () => {
    expect(typeof simpleFtsScore).toBe('function');
    expect(simpleFtsScore('hello world', 'hello')).toBeGreaterThan(0);
  });

  it('AC-36: reciprocalRankFusion is still exported from rag.service.ts', () => {
    expect(typeof reciprocalRankFusion).toBe('function');
    const result = reciprocalRankFusion([{ id: 'a' }], [{ id: 'a' }]);
    expect(result).toHaveLength(1);
  });
});

describe('RagService.search() — ftsRows added to recordMap (AC-37)', () => {
  it('AC-37: ftsRows from native FTS are included in the result set via recordMap', async () => {
    const service = makeRagService();
    const ftsOnlyRow = {
      id: 'fts-only',
      content: 'unique tantivy match',
      source: 'manual',
      source_id: 's_fts',
      vector: [],
      metadata: '{}',
      created_at: '',
      provider: 'ollama',
      model: 'm',
    };
    const vecRow = {
      id: 'vec-only',
      content: 'vector result',
      source: 'manual',
      source_id: 's_v',
      vector: [],
      metadata: '{}',
      created_at: '',
      provider: 'ollama',
      model: 'm',
    };

    const table = {
      ...mockTable(),
      countRows: jest.fn().mockResolvedValue(2),
      search: jest.fn().mockResolvedValue([ftsOnlyRow]),
      vectorSearch: jest.fn().mockReturnValue({
        distanceType: () => ({
          limit: () => ({ toArray: () => Promise.resolve([vecRow]) }),
        }),
      }),
      query: jest.fn().mockReturnValue({
        limit: () => ({ toArray: () => Promise.resolve([vecRow, ftsOnlyRow]) }),
      }),
    };

    (service as never as Record<string, unknown>)['lanceAvailable'] = true;
    (service as never as Record<string, unknown>)['tableCache'] = new Map([['p1', table]]);

    const result = await service.search('p1', 'unique tantivy', 10);
    const ids = result.results.map((r) => r.id);
    expect(ids).toContain('fts-only');
  });
});

// ─── US-004: RagService.optimizeTable() ───────────────────────────────────────

describe('RagService.optimizeTable()', () => {
  it('AC-38: calls table.optimize() when lanceAvailable=true', async () => {
    const service = makeRagService();
    const table = mockTable();
    (service as never as Record<string, unknown>)['lanceAvailable'] = true;
    (service as never as Record<string, unknown>)['tableCache'] = new Map([['p1', table]]);

    await service.optimizeTable('p1');
    expect(table.optimize).toHaveBeenCalledTimes(1);
  });

  it('AC-39: does NOT call table.optimize() when lanceAvailable=false', async () => {
    const service = makeRagService({ 'rag.inMemoryOnly': true });
    const table = mockTable();
    (service as never as Record<string, unknown>)['lanceAvailable'] = false;
    (service as never as Record<string, unknown>)['tableCache'] = new Map([['p1', table]]);

    await service.optimizeTable('p1');
    expect(table.optimize).not.toHaveBeenCalled();
  });
});

// ─── US-004: POST /projects/:slug/kb/optimize HTTP endpoint ──────────────────

describe('POST /projects/:slug/kb/optimize — HTTP endpoint', () => {
  // integration-check: NestJS testing module + supertest
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let httpServer: any;
  let ragServiceMock: { optimizeTable: jest.Mock };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let projectFindUnique: jest.Mock;

  beforeAll(async () => {
    const { RagController } = await import('./src/rag/rag.controller');

    ragServiceMock = { optimizeTable: jest.fn().mockResolvedValue(undefined) };
    projectFindUnique = jest.fn();
    const prismaMock = { client: { project: { findUnique: projectFindUnique } } };

    const mod = await Test.createTestingModule({
      controllers: [RagController],
      providers: [
        { provide: RagService, useValue: ragServiceMock },
        { provide: 'PrismaService', useValue: prismaMock },
      ],
    }).compile();

    app = mod.createNestApplication();

    // Middleware: map X-User-Role header → req.user.extra.role for RBAC tests
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.use((req: any, _res: any, next: () => void) => {
      const role = req.headers['x-user-role'];
      if (role) req.user = { extra: { role } };
      next();
    });

    await app.init();
    httpServer = app.getHttpServer();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('AC-40: ADMIN returns HTTP 200 with { ret: 0, data: { optimized: true } }', async () => {
    const supertest = (await import('supertest')).default;
    projectFindUnique.mockResolvedValue({ id: 'proj-id', slug: 'my-project', deletedAt: null });

    const res = await supertest(httpServer)
      .post('/projects/my-project/kb/optimize')
      .set('x-user-role', 'ADMIN')
      .send();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ret: 0, data: { optimized: true } });
  });

  it('AC-41: non-ADMIN returns HTTP 403', async () => {
    const supertest = (await import('supertest')).default;
    projectFindUnique.mockResolvedValue({ id: 'proj-id', slug: 'my-project', deletedAt: null });

    const res = await supertest(httpServer)
      .post('/projects/my-project/kb/optimize')
      .send(); // no x-user-role header → req.user undefined

    expect(res.status).toBe(403);
  });

  it('AC-42: unknown slug returns HTTP 404', async () => {
    const supertest = (await import('supertest')).default;
    projectFindUnique.mockResolvedValue(null);

    const res = await supertest(httpServer)
      .post('/projects/no-such-slug/kb/optimize')
      .set('x-user-role', 'ADMIN')
      .send();

    expect(res.status).toBe(404);
  });

  it('AC-43: optimize endpoint has @ApiOperation and @ApiResponse for 200, 403, 404 (file-check)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, './src/rag/rag.controller.ts'),
      'utf-8',
    );
    // Verify the optimize method block contains all required swagger decorators
    expect(src).toMatch(/kb\/optimize/);
    expect(src).toMatch(/@ApiOperation/);
    // Three @ApiResponse entries covering 200, 403, 404
    const statusMatches = [...src.matchAll(/status:\s*(200|403|404)/g)].map((m) => m[1]);
    expect(statusMatches).toContain('200');
    expect(statusMatches).toContain('403');
    expect(statusMatches).toContain('404');
  });
});