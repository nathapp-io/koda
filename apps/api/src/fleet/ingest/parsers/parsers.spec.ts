import { parseCostLedger } from './cost-ledger.parser';
import { parseMetrics } from './metrics.parser';
import { parseReviews } from './review-audit.parser';
import { parseFinish, parseStatus } from './finish.parser';
import { money, nonNegInt, str } from './fields';

const costLine = (over: Record<string, unknown> = {}) => JSON.stringify({
  ts: 1791117579984, runId: 'ead36098', projectKey: 'k', schemaVersion: 8, agentName: 'native', model: 'minimax/MiniMax-M2.7',
  modelTier: 'fast', profile: 'koda-job-x', stage: 'acceptance', sessionRole: 'auto', featureName: 'multiply', storyId: 'US-001',
  callId: 'c1', scopeId: 's', tokens: { input: 0, output: 1007, cacheRead: 0, cacheWrite: 989 }, estimatedCostUsd: 0.001579275,
  exactCostUsd: 0.001579275, costUsd: 0.001579275000000002, confidence: 'exact', pricingSource: 'catalog', durationMs: 1200, ...over,
});
const file = (name: string, text: string) => ({ name, text });

describe('fields', () => {
  it('validates untrusted values', () => {
    expect(str('  ', 5)).toBeNull();
    expect(str('abcdef', 3)).toBe('abc');
    expect(nonNegInt(-1)).toBeNull();
    expect(nonNegInt(2.7)).toBe(2);
    expect(money(Number.NaN)).toBeNull();
    expect(money(Infinity)).toBeNull();
    expect(money(-0.1)).toBeNull();
    expect(money(0.001579275000000002)).toBe('0.00157928');
    expect(money(0.00000003)).toBe('0.00000003');
  });
});

describe('parseCostLedger', () => {
  it('maps v8 rows, rounding cost to 8 places', () => {
    const r = parseCostLedger([file('nax-out/cost/a.jsonl', `${costLine()}\n${costLine({ callId: 'c2', storyId: undefined })}\n`)]);
    expect(r.outcome).toBe('done');
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({
      at: new Date(1791117579984), agentName: 'native', model: 'minimax/MiniMax-M2.7', stage: 'acceptance', sessionRole: 'auto',
      featureName: 'multiply', storyId: 'US-001', callId: 'c1', inputTokens: 0, outputTokens: 1007, cacheReadTokens: 0, cacheWriteTokens: 989,
      costUsd: '0.00157928', confidence: 'exact', pricingSource: 'catalog', durationMs: 1200,
    });
    expect(r.rows[1].storyId).toBeNull();
  });

  it('skips a file with an unknown schemaVersion', () => {
    const r = parseCostLedger([file('nax-out/cost/a.jsonl', costLine({ schemaVersion: 9 }))]);
    expect(r).toEqual({ rows: [], outcome: 'skipped:v9' });
  });

  it('drops invalid lines (bad JSON, NaN cost, missing callId) and keeps the rest', () => {
    const text = ['{nope', costLine({ costUsd: 'NaN' }), costLine({ callId: '' }), costLine({ callId: 'ok' })].join('\n');
    const r = parseCostLedger([file('nax-out/cost/a.jsonl', text)]);
    expect(r.rows.map((x) => x.callId)).toEqual(['ok']);
    expect(r.outcome).toBe('done');
  });

  it('keeps the first of a duplicated callId', () => {
    const r = parseCostLedger([file('a', costLine()), file('b', costLine({ costUsd: 9 }))]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].costUsd).toBe('0.00157928');
  });

  it('caps at 50,000 rows and reports capped', () => {
    const lines = Array.from({ length: 50_001 }, (_, i) => costLine({ callId: `c${i}` })).join('\n');
    const r = parseCostLedger([file('a', lines)]);
    expect(r.rows).toHaveLength(50_000);
    expect(r.outcome).toBe('capped');
  });

  it('is absent with no files', () => {
    expect(parseCostLedger([])).toEqual({ rows: [], outcome: 'absent' });
  });
});

describe('parseMetrics', () => {
  const metrics = JSON.stringify([
    { runId: 'run-other', feature: 'x', stories: [{ storyId: 'US-9', attempts: 1, success: true, firstPassSuccess: true, cost: 1 }] },
    {
      runId: 'run-053a', feature: 'multiply', stories: [{
        storyId: 'US-001', complexity: 'simple', initialComplexity: 'simple', modelTier: 'fast', finalTier: 'fast',
        modelUsed: 'minimax/MiniMax-M2.7', agentUsed: 'native', attempts: 1, success: true, firstPassSuccess: true,
        cost: 0.13950221999999995, durationMs: 0, startedAt: '2026-10-04T12:40:02.404Z', completedAt: '2026-10-04T12:45:36.178Z',
        tokens: { inputTokens: 64209, outputTokens: 5475, cacheReadInputTokens: 47690, cacheCreationInputTokens: 16633 },
      }],
    },
  ]);

  it('picks the run matching the nax run id', () => {
    const r = parseMetrics(file('nax-out/metrics.json', metrics), 'run-053a');
    expect(r.outcome).toBe('done');
    expect(r.rows).toEqual([expect.objectContaining({
      featureName: 'multiply', storyId: 'US-001', attempts: 1, success: true, firstPassSuccess: true, costUsd: '0.13950222',
      inputTokens: 64209, outputTokens: 5475, cacheReadTokens: 47690, cacheWriteTokens: 16633,
      completedAt: new Date('2026-10-04T12:45:36.178Z'),
    })]);
  });

  it('falls back to the only run when no id matches, and is invalid for non-arrays', () => {
    const single = JSON.stringify([JSON.parse(metrics)[1]]);
    expect(parseMetrics(file('m', single), 'run-zzz').rows).toHaveLength(1);
    expect(parseMetrics(file('m', '{"a":1}'), null)).toEqual({ rows: [], outcome: 'invalid' });
    expect(parseMetrics(null, null)).toEqual({ rows: [], outcome: 'absent' });
  });
});

describe('parseReviews', () => {
  it('counts findings by severity (D374)', () => {
    const rec = JSON.stringify({
      timestamp: '2026-10-04T12:45:36.045Z', runId: 'r', storyId: 'US-001', reviewer: 'semantic', recordId: 'rec1', passed: false, failOpen: false,
      result: { passed: false, findings: [{ severity: 'error' }, { severity: 'ERROR' }, { severity: 'warning' }, {}] }, advisoryFindings: [{}, {}],
    });
    const r = parseReviews([file('nax-out/review-audit/f/1.json', rec), file('bad', '{')]);
    expect(r.rows).toEqual([{
      storyId: 'US-001', reviewer: 'semantic', recordId: 'rec1', passed: false, failOpen: false, findingCount: 4,
      findingsBySeverity: { error: 2, warning: 1, unknown: 1 }, advisoryCount: 2, at: new Date('2026-10-04T12:45:36.045Z'),
    }]);
  });
});

describe('parseStatus / parseFinish', () => {
  const result = JSON.stringify({
    feature: 'substract', status: 'escalated', escalationReason: 'quality review never discharged its reading obligations',
    branch: 'feat/substract', headSha: 'd24d0a97', url: 'https://github.com/o/r/pull/1', rounds: [],
  });
  const last = (runId: string) => JSON.stringify({ branch: 'feat/b', headSha: 'abc', status: 'opened', prUrl: 'https://github.com/o/r/pull/2', runId });

  it('reads run id and status', () => {
    expect(parseStatus(file('s', JSON.stringify({ run: { id: 'run-1', status: 'completed' } })))).toEqual({ runId: 'run-1', runStatus: 'completed' });
    expect(parseStatus(null)).toEqual({ runId: null, runStatus: null });
  });

  it('prefers <runId>.result.json, falls back to a matching last.json, ignores a foreign one', () => {
    expect(parseFinish([file('nax-out/finish-audit/substract/run-1.result.json', result)], [], 'run-1')).toEqual({
      status: 'escalated', escalationReason: 'quality review never discharged its reading obligations',
      prUrl: 'https://github.com/o/r/pull/1', branch: 'feat/substract', headSha: 'd24d0a97',
    });
    expect(parseFinish([], [file('nax-out/finish-audit/f/last.json', last('run-1'))], 'run-1')).toMatchObject({ status: 'opened', prUrl: 'https://github.com/o/r/pull/2' });
    expect(parseFinish([], [file('nax-out/finish-audit/f/last.json', last('run-2'))], 'run-1')).toBeNull();
    expect(parseFinish([file('nax-out/finish-audit/f/run-2.result.json', result)], [], 'run-1')).toBeNull();
  });

  it('drops a non-https PR url (D375)', () => {
    const bad = JSON.stringify({ status: 'opened', url: 'javascript:alert(1)' });
    expect(parseFinish([file('nax-out/finish-audit/f/run-1.result.json', bad)], [], 'run-1')?.prUrl).toBeNull();
  });
});
