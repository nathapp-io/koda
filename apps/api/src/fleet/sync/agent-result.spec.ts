import { AGENT_RESULT_LIMITS } from '../common/agent-jobs';
import { interpretEvent } from './event-payloads';
import { parseAgentResult } from './agent-result';

const valid = {
  status: 'completed',
  model: 'acp:claude',
  output: 'ok',
  truncated: false,
  deniedAsks: [{ kind: 'question', text: 'Which?' }],
  deniedAsksTruncated: false,
  costUsd: '0.0100',
};

describe('parseAgentResult', () => {
  it('parses a valid result cleanly', () => {
    expect(parseAgentResult(valid)).toEqual(valid);
  });

  it('preserves omission of costUsd', () => {
    const { costUsd: _costUsd, ...withoutCost } = valid;
    const parsed = parseAgentResult(withoutCost);
    expect(parsed).toEqual(withoutCost);
    expect(parsed && Object.hasOwn(parsed, 'costUsd')).toBe(false);
  });

  it.each(['other', null, 1])('rejects unsupported status %p', (status) => {
    expect(parseAgentResult({ ...valid, status })).toBeNull();
  });

  it('rejects UTF-8 output over the byte limit', () => {
    expect(parseAgentResult({ ...valid, output: 'é'.repeat(AGENT_RESULT_LIMITS.maxOutputBytes / 2 + 1) })).toBeNull();
  });

  it('rejects serialized data over the budget while individual fields fit', () => {
    expect(parseAgentResult({ ...valid, output: 'x'.repeat(8_000), deniedAsks: Array.from({ length: 10 }, () => ({ kind: 'question', text: 'y'.repeat(500) })) })).toBeNull();
  });

  it.each([
    Array.from({ length: 11 }, () => ({ kind: 'question', text: 'x' })),
    [{ kind: 'other', text: 'x' }],
  ])('rejects invalid denied ask lists', (deniedAsks) => {
    expect(parseAgentResult({ ...valid, deniedAsks })).toBeNull();
  });

  it.each([
    [{ kind: 'approval', tool: 'x', summary: 'x'.repeat(501) }],
    [{ kind: 'approval', tool: 'x'.repeat(129), summary: 'x' }],
  ])('rejects oversized ask fields', (deniedAsks) => {
    expect(parseAgentResult({ ...valid, deniedAsks })).toBeNull();
  });

  it.each(['1.23456', '-1'])('rejects invalid costs %s', (costUsd) => {
    expect(parseAgentResult({ ...valid, costUsd })).toBeNull();
  });
});

describe('agent result snapshot mirror', () => {
  it('mirrors a valid parsed result', () => {
    expect(interpretEvent('snapshot', { agentResult: valid })).toEqual({ kind: 'mirror', patch: { agentResult: valid } });
  });

  it('drops an invalid result but keeps unrelated snapshot fields', () => {
    const effect = interpretEvent('snapshot', { agentResult: { status: 'weird' }, costSpentUsd: '0.5000' });
    expect(effect).toEqual({ kind: 'mirror', patch: { costSpentUsd: '0.5000' } });
    if (effect.kind === 'mirror') expect(Object.hasOwn(effect.patch, 'agentResult')).toBe(false);
  });
});
