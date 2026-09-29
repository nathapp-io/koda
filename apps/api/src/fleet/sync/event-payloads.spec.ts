import { interpretEvent } from './event-payloads';

describe('interpretEvent', () => {
  it('reads a state event', () => {
    expect(interpretEvent('state', { to: 'RUNNING' })).toEqual({ kind: 'transition', to: 'RUNNING', reason: null, exitCode: null });
    expect(interpretEvent('state', { to: 'FAILED', reason: 'x'.repeat(900), exitCode: 1 })).toEqual(
      expect.objectContaining({ kind: 'transition', to: 'FAILED', exitCode: 1, reason: 'x'.repeat(500) }),
    );
    expect(interpretEvent('state', { to: 'DONE' })).toEqual(expect.objectContaining({ kind: 'invalid' }));
  });

  it('mirrors a snapshot and drops hostile fields instead of failing (review focus 5)', () => {
    const effect = interpretEvent('snapshot', {
      naxRunId: 'run-1', costSpentUsd: '1.2345', currentStoryId: 'US-002', currentPhase: null,
      heartbeatAt: '2026-10-01T00:00:00.000Z', progress: { done: 2, total: 5 },
      resultPrUrl: 'https://github.com/acme/app/pull/7', resultSha: 'abc1234',
    });
    expect(effect).toEqual({
      kind: 'mirror',
      patch: {
        naxRunId: 'run-1', costSpentUsd: '1.2345', currentStoryId: 'US-002', currentPhase: null,
        lastHeartbeatAt: new Date('2026-10-01T00:00:00.000Z'), progress: { done: 2, total: 5 },
        resultPrUrl: 'https://github.com/acme/app/pull/7', resultSha: 'abc1234',
      },
    });
    const hostile = interpretEvent('snapshot', {
      costSpentUsd: 'abc', progress: { blob: 'x'.repeat(5_000) }, resultPrUrl: 'javascript:alert(1)',
      resultSha: 'not-a-sha', heartbeatAt: 'soon', naxRunId: 'r'.repeat(200),
    });
    expect(hostile).toEqual({ kind: 'mirror', patch: {} });
  });

  it('stores lifecycle and log events without effect, and flags an oversized log', () => {
    expect(interpretEvent('lifecycle', { level: 'warn', message: 'watcher error' })).toEqual({ kind: 'none' });
    expect(interpretEvent('log', { stream: 'run', text: 'ok' })).toEqual({ kind: 'none' });
    expect(interpretEvent('log', { stream: 'run', text: 'x'.repeat(8_193) })).toEqual(expect.objectContaining({ kind: 'invalid' }));
  });
});
