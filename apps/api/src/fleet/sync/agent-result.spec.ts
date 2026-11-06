import { AGENT_RESULT_LIMITS } from '../common/agent-jobs';
import { interpretEvent } from './event-payloads';
import { parseSyncRequest } from './sync-request.parser';
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

/**
 * The runner/API boundary (branch fix B1). `fitAgentResult` in
 * apps/runner/src/executor/agent-job/agent-result.ts replaces U+0000 with U+FFFD before it measures the
 * output tail and the serialized budget, because `stripNul` does that replacement here before
 * `parseAgentResult` runs. These two cases pin both sides of that contract: a result fitted at the
 * output bound after the replacement is mirrored, and the pre-replacement shape is dropped whole.
 */
describe('agent result NUL boundary (branch fix B1)', () => {
  const body = (agentResult: unknown) => ({
    protocolVersion: 1, bootId: 'boot-1', daemonVersion: '0.1.0', freeSlots: 1,
    jobs: [{ jobId: 'j1', leaseEpoch: 2, events: [{ seq: 1, type: 'snapshot', payload: { agentResult, costSpentUsd: '0.0100' } }] }],
    commandAcks: [], tokenRequests: [],
  });
  const mirrorOf = (agentResult: unknown) => interpretEvent('snapshot', parseSyncRequest(body(agentResult)).jobs[0].events[0].payload);

  it('mirrors a result whose output reaches the bound after the replacement', () => {
    // 8,189 ASCII bytes plus U+FFFD (three bytes) is exactly maxOutputBytes: the runner's fitted tail.
    const fitted = { ...valid, output: `${'a'.repeat(AGENT_RESULT_LIMITS.maxOutputBytes - 3)}\uFFFD`, truncated: true, deniedAsks: [] };
    expect(mirrorOf(fitted)).toEqual({ kind: 'mirror', patch: { agentResult: fitted, costSpentUsd: '0.0100' } });
  });

  it('drops a result that reaches the bound only before the replacement', () => {
    // The pre-B1 shape: 8,191 ASCII bytes and a NUL fit here, but the stored replacement is 8,194 bytes.
    const preReplacement = { ...valid, output: `${'a'.repeat(AGENT_RESULT_LIMITS.maxOutputBytes - 1)}\u0000`, truncated: true, deniedAsks: [] };
    const effect = mirrorOf(preReplacement);
    expect(effect).toEqual({ kind: 'mirror', patch: { costSpentUsd: '0.0100' } });
    if (effect.kind === 'mirror') expect(Object.hasOwn(effect.patch, 'agentResult')).toBe(false);
  });
});
