import { parseThreadLine } from './thread-line';

const endLine = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  type: 'turn_end', turnId: 't1', status: 'completed', output: '',
  usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0, ...overrides,
});

const usageLine = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  type: 'usage', turnId: 't1', round: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, ...overrides,
});

describe('thread cost line validation (US-005 review)', () => {
  it('rejects unsupported or unbounded turn_end cost sources', () => {
    expect(parseThreadLine(endLine({ costSource: 'bogus' }))).toEqual({ bad: true });
    expect(parseThreadLine(endLine({ costSource: 'x'.repeat(2048) }))).toEqual({ bad: true });
  });

  it('rejects usage values that cannot fit their FleetCostEvent columns', () => {
    expect(parseThreadLine(usageLine({ inputTokens: 2_147_483_648 }))).toEqual({ bad: true });
    expect(parseThreadLine(usageLine({ costUsd: 1_000_000 }))).toEqual({ bad: true });
  });

  it('rejects oversized turn_end token counts and costs before folding', () => {
    expect(parseThreadLine(endLine({ usage: { inputTokens: 2_147_483_648, outputTokens: 0 } }))).toEqual({ bad: true });
    expect(parseThreadLine(endLine({ costUsd: 1_000_000 }))).toEqual({ bad: true });
  });
});
