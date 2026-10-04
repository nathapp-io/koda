import { parseBundle } from './parse-bundle';
import type { BundleFiles } from './bundle-reader';

const empty: BundleFiles = { cost: [], metrics: null, reviews: [], finishResults: [], finishLast: [], status: null, oversized: [] };
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
    expect(p.files).toEqual({ cost: 'done', metrics: 'absent', review: 'absent', finish: 'absent' });
    expect(p.partial).toBe(false);
  });

  it('is partial when a file is skipped, capped or oversized, and keeps the others', () => {
    const p = parseBundle({ ...empty, cost: [{ name: 'a', text: line('a', 1, 9) }], oversized: ['nax-out/metrics.json'] }, 'run-x');
    expect(p.naxRunId).toBe('run-x');
    expect(p.files).toMatchObject({ cost: 'skipped:v9', metrics: 'oversized' });
    expect(p.partial).toBe(true);
    expect(p.ledgerCostUsd).toBe('0');
  });
});
