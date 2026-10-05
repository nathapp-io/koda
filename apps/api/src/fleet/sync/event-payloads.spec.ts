import { interpretEvent, postRunStages } from './event-payloads';

const VALID_ASK = {
  naxAskId: 'ask-1f2e3d4c', deadlineAt: '2026-10-04T10:10:00.000Z', command: 'bun run test', commandTruncated: false,
  maskedCount: 0, root: '/work/repo', stage: 'execution', storyId: 'US-001', featureName: 'demo', reason: 'matched ask rule',
  options: ['allow', 'allow-remember', 'deny'],
};

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

  it('mirrors a valid wipPush and drops an invalid one without rejecting the snapshot', () => {
    for (const value of ['pushed', 'none', 'failed:diverged', 'failed:git auth failed']) {
      expect(interpretEvent('snapshot', { wipPush: value })).toEqual({ kind: 'mirror', patch: { wipPush: value } });
    }
    for (const value of ['', 'yes', 'failed:', `failed:${'x'.repeat(201)}`, 'failed:line\nbreak', 42]) {
      expect(interpretEvent('snapshot', { wipPush: value, currentPhase: 'review' })).toEqual({ kind: 'mirror', patch: { currentPhase: 'review' } });
    }
  });

  const st = (over: Record<string, unknown> = {}) => ({ id: 'US-001', title: 'first', status: 'passed', attempts: 1, dependsOn: [], ...over });

  it('mirrors a valid story list with its truncation flag and strips unknown story keys', () => {
    expect(interpretEvent('snapshot', { stories: [st({ extra: 'x' }), st({ id: 'US-002', dependsOn: ['US-001'] })], storiesTruncated: true }))
      .toEqual({ kind: 'mirror', patch: { stories: [st(), st({ id: 'US-002', dependsOn: ['US-001'] })], storiesTruncated: true } });
    expect(interpretEvent('snapshot', { stories: [] })).toEqual({ kind: 'mirror', patch: { stories: [], storiesTruncated: false } });
  });

  it('accepts a full 8 KiB list of 100 stories (Review focus 1)', () => {
    const stories = Array.from({ length: 100 }, (_, i) => st({ id: `S${i}`, title: '' }));
    expect(Buffer.byteLength(JSON.stringify(stories), 'utf8')).toBeLessThanOrEqual(8_192);
    expect(interpretEvent('snapshot', { stories })).toEqual({ kind: 'mirror', patch: { stories, storiesTruncated: false } });
  });

  it('drops an invalid or over-cap list (and its flag) but keeps the rest of the snapshot (D150)', () => {
    const bad: unknown[] = [
      'nope', [st(), 'x'], Array.from({ length: 101 }, (_, i) => st({ id: `S${i}`, title: '' })),
      Array.from({ length: 60 }, (_, i) => st({ id: `S${i}`, title: 't'.repeat(80) })),
      [st({ id: '' })], [st({ id: 'x'.repeat(129) })], [st({ title: 'x'.repeat(81) })], [st({ title: 3 })],
      [st({ status: 'Passed' })], [st({ status: 'x'.repeat(33) })], [st({ attempts: -1 })], [st({ attempts: 1.5 })],
      [st({ attempts: 1_000_001 })], [st({ dependsOn: 'US-001' })], [st({ dependsOn: Array.from({ length: 11 }, (_, i) => `D${i}`) })],
      [st({ dependsOn: [''] })],
    ];
    for (const stories of bad) {
      expect(interpretEvent('snapshot', { stories, storiesTruncated: true, currentPhase: 'review' })).toEqual({ kind: 'mirror', patch: { currentPhase: 'review' } });
    }
  });

  it('an absent list leaves the stored one alone (Review focus 4)', () => {
    expect(interpretEvent('snapshot', { currentPhase: 'review', storiesTruncated: true })).toEqual({ kind: 'mirror', patch: { currentPhase: 'review' } });
  });

  it('stores lifecycle and log events without effect, and flags an oversized log', () => {
    expect(interpretEvent('lifecycle', { level: 'warn', message: 'watcher error' })).toEqual({ kind: 'none' });
    expect(interpretEvent('log', { stream: 'run', text: 'ok' })).toEqual({ kind: 'none' });
    expect(interpretEvent('log', { stream: 'run', text: 'x'.repeat(8_193) })).toEqual(expect.objectContaining({ kind: 'invalid' }));
  });

  it('interprets approval_request as an approval effect, or invalid', () => {
    expect(interpretEvent('approval_request', VALID_ASK)).toEqual(expect.objectContaining({ kind: 'approval' }));
    expect(interpretEvent('approval_request', { ...VALID_ASK, options: [] })).toEqual({ kind: 'invalid', reason: 'approval_request.options' });
  });
});

describe('postRunStages (S2b (j) §1.3, D429)', () => {
  it.each([
    ['all three stages', { acceptance: 'passed', regression: 'running', finish: 'not-run' }, { acceptance: 'passed', regression: 'running', finish: 'not-run' }],
    ['unknown keys dropped', { acceptance: 'passed', gates: 'x', __proto__x: 'y' }, { acceptance: 'passed' }],
    ['a 33-char value drops only that key', { acceptance: 'x'.repeat(33), regression: 'passed' }, { regression: 'passed' }],
    ['32 chars kept', { finish: 'y'.repeat(32) }, { finish: 'y'.repeat(32) }],
    ['control character dropped', { acceptance: 'pass\ned', finish: 'passed' }, { finish: 'passed' }],
    ['non-ASCII dropped', { acceptance: 'pass\u00e9' }, undefined],
    ['empty string dropped', { acceptance: '' }, undefined],
    ['non-string dropped', { acceptance: 7, regression: null, finish: { status: 'x' } }, undefined],
    ['empty object', {}, undefined],
  ])('%s', (_name, input, expected) => {
    expect(postRunStages(input)).toEqual(expected);
  });
  it.each([[null], [undefined], ['passed'], [['passed']], [42]])('%p is not a stage object', (input) => {
    expect(postRunStages(input)).toBeUndefined();
  });
});

describe('snapshot postRun mirror', () => {
  it('mirrors valid stages next to the other fields', () => {
    expect(interpretEvent('snapshot', { currentPhase: 'review', postRun: { acceptance: 'running' } }))
      .toEqual({ kind: 'mirror', patch: { currentPhase: 'review', postRun: { acceptance: 'running' } } });
  });
  it('an all-invalid postRun is absent, and the rest of the snapshot still applies', () => {
    expect(interpretEvent('snapshot', { costSpentUsd: '0.5', postRun: { acceptance: 'x'.repeat(40) } }))
      .toEqual({ kind: 'mirror', patch: { costSpentUsd: '0.5' } });
    expect(interpretEvent('snapshot', { costSpentUsd: '0.5', postRun: null }))
      .toEqual({ kind: 'mirror', patch: { costSpentUsd: '0.5' } });
  });
});
