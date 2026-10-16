import { parseBundle } from './parse-bundle';
import type { BundleFiles } from './bundle-reader';

const empty: BundleFiles = { cost: [], metrics: null, reviews: [], finishResults: [], finishLast: [], status: null, workflowResult: null, oversized: [] };
const line = (callId: string, costUsd: number, schemaVersion = 8) => JSON.stringify({
  ts: 0, schemaVersion, agentName: 'native', model: 'm', stage: 'run', featureName: 'f', callId,
  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd,
});

describe('parseBundle', () => {
  it('sums the ledger unrounded and uses status.json run id', () => {
    const p = parseBundle({
      ...empty,
      cost: [{ name: 'nax-out/cost/a.jsonl', text: [line('a', 0.00000001), line('b', 0.00000002)].join('\n') }],
      status: { name: 'nax-out/status.json', text: JSON.stringify({ run: { id: 'run-1', status: 'completed' } }) },
    }, 'fallback');
    expect(p.naxRunId).toBe('run-1');
    expect(p.runStatus).toBe('completed');
    expect(p.ledgerCostUsd).toBe('0.00000003'); // plain notation, never '3e-8'
    expect(p.files).toEqual({ cost: 'done', metrics: 'absent', review: 'absent', finish: 'absent', workflow: 'absent' });
    expect(p.partial).toBe(false);
  });

  it('AC-1 parses a draft workflow result and status block', () => {
    const workflowResult = JSON.stringify({
      schemaVersion: 1,
      runId: 'fab5b9af-d3a3-41f2-91ed-62372a733c03',
      verdict: { workflowPassed: true, outcome: 'draft', reasons: ['CI failed: test'], openItems: [] },
    });
    const p = parseBundle({
      ...empty,
      status: { name: 'nax-out/status.json', text: JSON.stringify({ run: { id: 'run-1', status: 'completed' }, workflow: { step: 'done', outcome: 'draft', url: 'https://github.com/o/r/pull/5' } }) },
      workflowResult: { name: 'workflow/result.json', text: workflowResult },
    }, 'fallback');
    expect(p.workflow?.outcome).toBe('draft');
    expect(p.workflowOutcome).toBe('draft');
    expect(p.workflowUrl).toBe('https://github.com/o/r/pull/5');
    expect(p.files.workflow).toBe('done');
  });

  it('AC-2 returns null workflow and absent when no workflow result file', () => {
    const p = parseBundle({
      ...empty,
      status: { name: 'nax-out/status.json', text: JSON.stringify({ run: { id: 'run-1', status: 'completed' } }) },
    }, 'fallback');
    expect(p.workflow).toBeNull();
    expect(p.files.workflow).toBe('absent');
  });

  it('AC-3 marks an invalid workflow result invalid without making the ingest partial', () => {
    const p = parseBundle({
      ...empty,
      cost: [{ name: 'nax-out/cost/a.jsonl', text: [line('a', 0.00000001)].join('\n') }],
      status: { name: 'nax-out/status.json', text: JSON.stringify({ run: { id: 'run-1', status: 'completed' } }) },
      workflowResult: { name: 'workflow/result.json', text: 'not JSON' },
    }, 'fallback');
    expect(p.workflow).toBeNull();
    expect(p.files.workflow).toBe('invalid');
    expect(p.partial).toBe(false);
  });

  it('AC-4 collects a report row then a decisions row', () => {
    const decisions = '{"id":"D1","kind":"ruling","rationale":"why"}';
    const p = parseBundle({
      ...empty,
      featureReport: { name: 'workflow/feature-report.md', text: '# R' },
      decisions: { name: 'workflow/decisions.jsonl', text: decisions },
    }, 'fallback');
    expect(p.rows.outcomes).toEqual([{ kind: 'report', content: '# R' }, { kind: 'decisions', content: decisions }]);
  });

  it('AC-5 cuts an over-long report to the first 262144 characters', () => {
    const p = parseBundle({ ...empty, featureReport: { name: 'workflow/feature-report.md', text: `${'a'.repeat(262_199)}TAIL` } }, 'fallback');
    expect(p.rows.outcomes).toEqual([{ kind: 'report', content: 'a'.repeat(262_144) }]);
  });

  it('cuts an over-long decisions log to the same cap', () => {
    const p = parseBundle({ ...empty, decisions: { name: 'workflow/decisions.jsonl', text: `${'b'.repeat(262_199)}TAIL` } }, 'fallback');
    expect((p.rows.outcomes[0]?.content ?? '').length).toBe(262_144);
    expect(p.rows.outcomes).toEqual([{ kind: 'decisions', content: 'b'.repeat(262_144) }]);
  });

  it('AC-6 ignores an empty report and leaves files and partial as without it', () => {
    const status = { name: 'nax-out/status.json', text: JSON.stringify({ run: { id: 'run-1', status: 'completed' } }) };
    const without = parseBundle({ ...empty, status }, 'fallback');
    const withEmpty = parseBundle({ ...empty, status, featureReport: { name: 'workflow/feature-report.md', text: '' } }, 'fallback');
    expect(withEmpty.rows.outcomes).toEqual([]);
    expect(withEmpty.files).toEqual(without.files);
    expect(withEmpty.partial).toBe(without.partial);
  });

  it('is partial when a file is skipped, capped or oversized, and keeps the others', () => {
    const p = parseBundle({ ...empty, cost: [{ name: 'a', text: line('a', 1, 9) }], oversized: ['nax-out/metrics.json'] }, 'run-x');
    expect(p.naxRunId).toBe('run-x');
    expect(p.files).toMatchObject({ cost: 'skipped:v9', metrics: 'oversized' });
    expect(p.partial).toBe(true);
    expect(p.ledgerCostUsd).toBe('0');
  });
});
