import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const API_ROOT = join(import.meta.dirname, '../../../..');

describe('memory-phase2-hybrid-retrieval acceptance', () => {
  describe('AC-1: runQueries() accepts Array<{projectId, query, intent, expectedDocIds}> and returns Array<{query, precisionAt5}>', () => {
    it('runQueries() is importable and returns an array of query results with precisionAt5 field', async () => {
      const { EvaluationService } = await import('../../../apps/api/src/retrieval/evaluation.service');
      const svc = new EvaluationService();
      const results = await svc.runQueries([
        {
          projectId: 'test-project',
          query: 'authentication setup',
          intent: 'answer',
          expectedDocIds: ['doc-1', 'doc-2'],
        },
      ]);
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
      expect(typeof results[0].precisionAt5).toBe('number');
      expect(typeof results[0].query).toBe('string');
    });

    it('runQueries() processes multiple queries and returns one result per query', async () => {
      const { EvaluationService } = await import('../../../apps/api/src/retrieval/evaluation.service');
      const svc = new EvaluationService();
      const input = [
        { projectId: 'p1', query: 'auth', intent: 'answer', expectedDocIds: ['d1'] },
        { projectId: 'p2', query: 'deploy', intent: 'answer', expectedDocIds: ['d2'] },
        { projectId: 'p3', query: 'cache', intent: 'answer', expectedDocIds: ['d3'] },
      ];
      const results = await svc.runQueries(input);
      expect(results.length).toBe(input.length);
      results.forEach((r) => {
        expect(typeof r.query).toBe('string');
        expect(typeof r.precisionAt5).toBe('number');
        expect(r.precisionAt5).toBeGreaterThanOrEqual(0);
        expect(r.precisionAt5).toBeLessThanOrEqual(1);
      });
    });
  });

  describe('AC-2: runQueries() return value includes precisionAt5_avg, precisionAt5_p50, precisionAt5_p95, totalQueries', () => {
    it('runQueries() summary object contains all four required statistics', async () => {
      const { EvaluationService } = await import('../../../apps/api/src/retrieval/evaluation.service');
      const svc = new EvaluationService();
      const results = await svc.runQueries([
        { projectId: 'p', query: 'auth setup', intent: 'answer', expectedDocIds: ['doc-a'] },
      ]);
      const summary = results.summary;
      expect(typeof summary.precisionAt5_avg).toBe('number');
      expect(typeof summary.precisionAt5_p50).toBe('number');
      expect(typeof summary.precisionAt5_p95).toBe('number');
      expect(typeof summary.totalQueries).toBe('number');
    });

    it('precisionAt5_avg is the mean of per-query precision@5 values', async () => {
      const { EvaluationService } = await import('../../../apps/api/src/retrieval/evaluation.service');
      const svc = new EvaluationService();
      const input = [
        { projectId: 'p', query: 'q1', intent: 'answer', expectedDocIds: ['a'] },
        { projectId: 'p', query: 'q2', intent: 'answer', expectedDocIds: ['b'] },
      ];
      const results = await svc.runQueries(input);
      const avg = results.summary.precisionAt5_avg;
      const values = results.map((r) => r.precisionAt5);
      const expected = values.reduce((a, b) => a + b, 0) / values.length;
      expect(avg).toBeCloseTo(expected, 5);
    });

    it('totalQueries equals the number of input queries', async () => {
      const { EvaluationService } = await import('../../../apps/api/src/retrieval/evaluation.service');
      const svc = new EvaluationService();
      const input = [
        { projectId: 'p', query: 'a', intent: 'answer', expectedDocIds: [] },
        { projectId: 'p', query: 'b', intent: 'answer', expectedDocIds: [] },
        { projectId: 'p', query: 'c', intent: 'answer', expectedDocIds: [] },
      ];
      const results = await svc.runQueries(input);
      expect(results.summary.totalQueries).toBe(input.length);
    });

    it('precisionAt5_p50 is between 0 and 1', async () => {
      const { EvaluationService } = await import('../../../apps/api/src/retrieval/evaluation.service');
      const svc = new EvaluationService();
      const results = await svc.runQueries([
        { projectId: 'p', query: 'test', intent: 'answer', expectedDocIds: ['x'] },
      ]);
      expect(results.summary.precisionAt5_p50).toBeGreaterThanOrEqual(0);
      expect(results.summary.precisionAt5_p50).toBeLessThanOrEqual(1);
    });
  });

  describe('AC-3: eval-queries.json exists, is a JSON array of 50 entries, each with projectId, query, intent, expectedDocIds', () => {
    it('the fixture file exists at apps/api/src/retrieval/fixtures/eval-queries.json', () => {
      const fixturePath = join(API_ROOT, 'apps/api/src/retrieval/fixtures/eval-queries.json');
      expect(existsSync(fixturePath)).toBe(true);
    });

    it('fixture file is valid JSON and is an array', () => {
      const fixturePath = join(API_ROOT, 'apps/api/src/retrieval/fixtures/eval-queries.json');
      const content = readFileSync(fixturePath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(Array.isArray(parsed)).toBe(true);
    });

    it('fixture array has length 50', () => {
      const fixturePath = join(API_ROOT, 'apps/api/src/retrieval/fixtures/eval-queries.json');
      const content = readFileSync(fixturePath, 'utf-8');
      const parsed = JSON.parse(content) as unknown[];
      expect(parsed.length).toBe(50);
    });

    it('each entry has required fields: projectId (string), query (string), intent (string), expectedDocIds (string[])', () => {
      const fixturePath = join(API_ROOT, 'apps/api/src/retrieval/fixtures/eval-queries.json');
      const content = readFileSync(fixturePath, 'utf-8');
      const parsed = JSON.parse(content) as Array<Record<string, unknown>>;
      for (const entry of parsed) {
        expect(typeof entry.projectId).toBe('string');
        expect(typeof entry.query).toBe('string');
        expect(typeof entry.intent).toBe('string');
        expect(Array.isArray(entry.expectedDocIds)).toBe(true);
        expect(entry.expectedDocIds.every((id) => typeof id === 'string')).toBe(true);
      }
    });
  });

  describe('AC-4: bun run evaluate:retrieval outputs string containing pipe character (|) or formatted table with at least 3 columns', () => {
    it('CLI command runs and produces pipe-separated or table-formatted output', () => {
      const output = execSync('bun run evaluate:retrieval', {
        cwd: API_ROOT,
        encoding: 'utf-8',
      });
      const hasPipe = output.includes('|');
      const lines = output.trim().split('\n');
      const tableLine = lines.find((l) => l.split(/\s{2,}/).length >= 3);
      expect(hasPipe || tableLine).toBeTruthy();
    });

    it('output contains at least one line with query identifier or precision metric', () => {
      const output = execSync('bun run evaluate:retrieval', {
        cwd: API_ROOT,
        encoding: 'utf-8',
      });
      const lower = output.toLowerCase();
      const hasPrecision = lower.includes('precision') || lower.includes('p50') || lower.includes('p95');
      expect(hasPrecision).toBe(true);
    });
  });

  describe('AC-5: package.json scripts contains evaluate:retrieval and running it exits with code 0', () => {
    it('evaluate:retrieval script is defined in package.json', () => {
      const pkgPath = join(API_ROOT, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const scripts: Record<string, string> = pkg.scripts;
      expect('evaluate:retrieval' in scripts).toBe(true);
    });

    it('running bun run evaluate:retrieval exits with code 0', () => {
      expect(() => {
        execSync('bun run evaluate:retrieval', {
          cwd: API_ROOT,
          encoding: 'utf-8',
          stdio: 'pipe',
        });
      }).not.toThrow();
    });
  });

  describe('AC-6: when runQueries() returns precisionAt5_avg < 0.70, CI job exits with non-zero code', () => {
    it('CLI exits with non-zero code when average precision is below 0.70 threshold', () => {
      expect(() => {
        execSync('bun run evaluate:retrieval --threshold 0.70', {
          cwd: API_ROOT,
          encoding: 'utf-8',
          stdio: 'pipe',
        });
      }).toThrow();
    });

    it('runQueries() produces summary.precisionAt5_avg that can be compared against 0.70', async () => {
      const { EvaluationService } = await import('../../../apps/api/src/retrieval/evaluation.service');
      const svc = new EvaluationService();
      const results = await svc.runQueries([
        { projectId: 'p', query: 'auth', intent: 'answer', expectedDocIds: [] },
      ]);
      expect(typeof results.summary.precisionAt5_avg).toBe('number');
      expect(results.summary.precisionAt5_avg).toBeLessThanOrEqual(1);
      expect(results.summary.precisionAt5_avg).toBeGreaterThanOrEqual(0);
    });
  });
});