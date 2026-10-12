import { parseThreadLine } from './thread-line';

const endLine = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  type: 'turn_end', turnId: 't1', status: 'completed', output: '',
  usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0, ...overrides,
});

const usageLine = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  type: 'usage', turnId: 't1', round: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, ...overrides,
});

describe('thread cost line validation (US-005 review)', () => {
  it('parses a bounded line with deeply nested extra data without stalling the stream', () => {
    const nested = '['.repeat(12000) + '"a\\u0000b"' + ']'.repeat(12000);
    expect(parseThreadLine(`{"type":"turn_start","turnId":"t1","extra":${nested}}`))
      .toEqual({ type: 'turn_start', turnId: 't1' });
  });

  it('replaces NULs in nested tool input objects and arrays', () => {
    expect(parseThreadLine(JSON.stringify({
      type: 'tool_call', turnId: 't1', callId: 'c1', name: 'search', input: { values: ['a\u0000b', { text: '\u0000' }] },
    }))).toMatchObject({ input: { values: ['a\uFFFDb', { text: '\uFFFD' }] } });
  });

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
