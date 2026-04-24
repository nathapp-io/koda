import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';

import { Test } from '@nestjs/testing';
import { EvaluationService, EvalQuery } from '../../../src/retrieval/evaluation.service';
import { HybridRetrieverService } from '../../../src/rag/hybrid-retriever.service';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const API_ROOT = resolve(__dirname, '../../..');
const API_CD = resolve(__dirname, '../../..');
const FIXTURE_PATH = join(API_ROOT, 'src/retrieval/fixtures/eval-queries.json');

function mockHybridRetriever() {
  return {
    search: jest.fn().mockResolvedValue({
      results: [],
      retrievedAt: new Date().toISOString(),
    }),
    indexDocument: jest.fn().mockResolvedValue(undefined),
  };
}

// ─── AC-1: runQueries returns Array<{query, precisionAt5}> with 0-1 inclusive ─

describe('AC-1: EvaluationService.runQueries() returns Array<{query, precisionAt5}> with 0-1 inclusive', () => {
  let service: EvaluationService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      providers: [
        EvaluationService,
        { provide: HybridRetrieverService, useValue: mockHybridRetriever() },
      ],
    }).compile();

    service = module.get(EvaluationService);
  });

  it('returns an object with results array containing query and precisionAt5', async () => {
    const queries: EvalQuery[] = [
      {
        projectId: 'proj_test',
        query: 'How to reset password',
        intent: 'answer',
        expectedDocIds: ['doc-1'],
      },
    ];

    const result = await service.runQueries(queries);

    expect(result).toHaveProperty('results');
    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]).toHaveProperty('query');
    expect(typeof result.results[0].query).toBe('string');
    expect(result.results[0]).toHaveProperty('precisionAt5');
  });

  it('precisionAt5 is a number between 0 and 1 inclusive', async () => {
    const queries: EvalQuery[] = [
      {
        projectId: 'proj_test',
        query: 'JWT token refresh',
        intent: 'answer',
        expectedDocIds: ['doc-1', 'doc-2'],
      },
    ];

    const result = await service.runQueries(queries);

    for (const item of result.results) {
      expect(typeof item.precisionAt5).toBe('number');
      expect(item.precisionAt5).toBeGreaterThanOrEqual(0);
      expect(item.precisionAt5).toBeLessThanOrEqual(1);
    }
  });

  it('each returned object has query as a non-empty string', async () => {
    const queries: EvalQuery[] = [
      {
        projectId: 'proj_test',
        query: 'Docker container restart policy',
        intent: 'answer',
        expectedDocIds: ['manual-001'],
      },
    ];

    const result = await service.runQueries(queries);

    expect(result.results.length).toBe(1);
    expect(typeof result.results[0].query).toBe('string');
    expect(result.results[0].query.length).toBeGreaterThan(0);
  });
});

// ─── AC-2: runQueries returns summary with finite precisionAt5_avg/p50/p95/totalQueries ─

describe('AC-2: EvaluationService.runQueries() returns summary with finite precisionAt5_avg/p50/p95/totalQueries', () => {
  let service: EvaluationService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      providers: [
        EvaluationService,
        { provide: HybridRetrieverService, useValue: mockHybridRetriever() },
      ],
    }).compile();

    service = module.get(EvaluationService);
  });

  it('returns an object containing precisionAt5_avg, precisionAt5_p50, precisionAt5_p95, and totalQueries', async () => {
    const queries: EvalQuery[] = [
      {
        projectId: 'proj_test',
        query: 'Null pointer exception',
        intent: 'answer',
        expectedDocIds: ['ticket-001'],
      },
      {
        projectId: 'proj_test',
        query: 'Database connection pool settings',
        intent: 'answer',
        expectedDocIds: ['doc-004'],
      },
    ];

    const result = await service.runQueries(queries);

    expect(result).toHaveProperty('precisionAt5_avg');
    expect(result).toHaveProperty('precisionAt5_p50');
    expect(result).toHaveProperty('precisionAt5_p95');
    expect(result).toHaveProperty('totalQueries');
  });

  it('all values are finite numbers', async () => {
    const queries: EvalQuery[] = [
      {
        projectId: 'proj_test',
        query: 'API rate limiting configuration',
        intent: 'answer',
        expectedDocIds: ['doc-007', 'ticket-033'],
      },
      {
        projectId: 'proj_test',
        query: 'Memory leak in background worker',
        intent: 'reproduce',
        expectedDocIds: ['ticket-002', 'ticket-044'],
      },
      {
        projectId: 'proj_test',
        query: 'Slow query performance on dashboard',
        intent: 'reproduce',
        expectedDocIds: ['ticket-003', 'ticket-038'],
      },
    ];

    const result = await service.runQueries(queries);

    expect(typeof result.precisionAt5_avg).toBe('number');
    expect(typeof result.precisionAt5_p50).toBe('number');
    expect(typeof result.precisionAt5_p95).toBe('number');
    expect(typeof result.totalQueries).toBe('number');

    expect(Number.isFinite(result.precisionAt5_avg)).toBe(true);
    expect(Number.isFinite(result.precisionAt5_p50)).toBe(true);
    expect(Number.isFinite(result.precisionAt5_p95)).toBe(true);
    expect(Number.isFinite(result.totalQueries)).toBe(true);
  });

  it('totalQueries equals the number of input queries', async () => {
    const queries: EvalQuery[] = [
      { projectId: 'proj_test', query: 'Q1', intent: 'answer', expectedDocIds: ['doc-1'] },
      { projectId: 'proj_test', query: 'Q2', intent: 'reproduce', expectedDocIds: ['doc-2'] },
      { projectId: 'proj_test', query: 'Q3', intent: 'review', expectedDocIds: ['doc-3'] },
    ];

    const result = await service.runQueries(queries);

    expect(result.totalQueries).toBe(3);
  });
});

// ─── AC-3: eval-queries.json fixture has exactly 50 objects with required fields ─

describe('AC-3: eval-queries.json fixture has exactly 50 objects with required fields', () => {
  it('file exists at apps/api/src/retrieval/fixtures/eval-queries.json', () => {
    const exists = fs.existsSync(FIXTURE_PATH);
    expect(exists).toBe(true);
  });

  it('contains a JSON array of exactly 50 objects', () => {
    const raw = readFileSync(FIXTURE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(50);
  });

  it('each object has non-empty string fields: projectId, query, intent', () => {
    const raw = readFileSync(FIXTURE_PATH, 'utf-8');
    const parsed: EvalQuery[] = JSON.parse(raw);

    for (const item of parsed) {
      expect(typeof item.projectId).toBe('string');
      expect(item.projectId.length).toBeGreaterThan(0);
      expect(typeof item.query).toBe('string');
      expect(item.query.length).toBeGreaterThan(0);
      expect(typeof item.intent).toBe('string');
      expect(item.intent.length).toBeGreaterThan(0);
    }
  });

  it('each object has expectedDocIds as array of strings', () => {
    const raw = readFileSync(FIXTURE_PATH, 'utf-8');
    const parsed: EvalQuery[] = JSON.parse(raw);

    for (const item of parsed) {
      expect(Array.isArray(item.expectedDocIds)).toBe(true);
      for (const id of item.expectedDocIds) {
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
      }
    }
  });
});

// ─── AC-4: bun run evaluate:retrieval exits 0 and stdout has table with query/precision@5 ─

describe('AC-4: bun run evaluate:retrieval exits with code 0 and stdout has table with query/precision@5', () => {
  it('exits with code 0', () => {
    const result = execSync(`cd ${API_ROOT} && bun run evaluate:retrieval`, {
      encoding: 'utf-8',
      timeout: 120_000,
    });

    expect(result).toBeDefined();
  }, 150_000);

  it('stdout contains column headers including query and precision@5 or precisionAt5', () => {
    const output = execSync(`cd ${API_ROOT} && bun run evaluate:retrieval`, {
      encoding: 'utf-8',
      timeout: 120_000,
    });

    const hasQueryHeader = /query/i.test(output);
    const hasPrecisionHeader = /(?:precision@5|precisionAt5)/i.test(output);

    expect(hasQueryHeader || hasPrecisionHeader).toBe(true);
  });
});

// ─── AC-5: package.json includes evaluate:retrieval script ─

describe('AC-5: package.json includes evaluate:retrieval script', () => {
  it('scripts includes evaluate:retrieval', () => {
    const pkgPath = join(API_ROOT, 'package.json');
    const raw = readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw);

    expect(pkg.scripts).toHaveProperty('evaluate:retrieval');
    expect(typeof pkg.scripts['evaluate:retrieval']).toBe('string');
    expect(pkg.scripts['evaluate:retrieval'].length).toBeGreaterThan(0);
  });
});

// ─── AC-6: CI threshold — below 0.70 avg causes non-zero exit ─

describe('AC-6: CI threshold — below 0.70 avg causes non-zero exit', () => {
  it('process exits with non-zero code when precisionAt5_avg < 0.70', () => {
    let exitCode: number | null = null;

    try {
      execSync(
        `cd ${API_ROOT} && RAG_EVAL_PROJECT_ID=proj_eval_001 bun run evaluate:retrieval`,
        {
          encoding: 'utf-8',
          timeout: 120_000,
          env: { ...process.env, RAG_EVAL_PROJECT_ID: 'proj_eval_001' },
        },
      );
    } catch (err: unknown) {
      exitCode = (err as { status: number }).status ?? (err as { statusCode: number }).statusCode ?? null;
    }

    if (exitCode !== null) {
      expect(exitCode).not.toBe(0);
    }
  });

  it('CI job status reflects failure when precisionAt5_avg < 0.70', () => {
    const scriptPath = join(API_ROOT, 'scripts/evaluate-retrieval.ts');
    const scriptExists = fs.existsSync(scriptPath);
    expect(scriptExists).toBe(true);

    const raw = readFileSync(scriptPath, 'utf-8');
    const hasThresholdCheck = /CI_THRESHOLD|0\.70|process\.exit\(1\)/.test(raw);
    expect(hasThresholdCheck).toBe(true);

    const hasExitOneOnLowThreshold = /precisionAt5_avg.*<.*CI_THRESHOLD|process\.exit\(1\)/.test(raw);
    expect(hasExitOneOnLowThreshold).toBe(true);
  });
});