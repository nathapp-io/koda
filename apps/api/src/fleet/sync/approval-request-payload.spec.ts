import { parseApprovalRequest } from './approval-request-payload';

const valid = {
  naxAskId: 'ask-1f2e3d4c', deadlineAt: '2026-10-04T10:10:00.000Z', command: 'bun run test', commandTruncated: false,
  maskedCount: 0, root: '/work/repo', stage: 'execution', storyId: 'US-001', featureName: 'demo', reason: 'matched ask rule',
  options: ['allow', 'allow-remember', 'deny'],
};

describe('parseApprovalRequest (S1.5 §3)', () => {
  it('returns the ask and the stored payload', () => {
    const r = parseApprovalRequest(valid);
    expect(r).toEqual({ ok: true, ask: {
      naxAskId: 'ask-1f2e3d4c', deadlineAt: new Date('2026-10-04T10:10:00.000Z'),
      payload: { command: 'bun run test', commandTruncated: false, maskedCount: 0, root: '/work/repo', stage: 'execution',
        storyId: 'US-001', featureName: 'demo', reason: 'matched ask rule', options: ['allow', 'allow-remember', 'deny'] },
    } });
  });

  it('keeps rawDetail for an unparsed ask with an empty command', () => {
    const r = parseApprovalRequest({ ...valid, command: '', rawDetail: 'request: x\nruns in: /w\nreason:  r\nstage:   s' });
    expect('ask' in r && r.ask.payload['rawDetail']).toContain('runs in: /w');
  });

  it('accepts a null storyId', () => {
    expect('ask' in parseApprovalRequest({ ...valid, storyId: null })).toBe(true);
  });

  it.each([
    ['naxAskId', { naxAskId: 'nope' }],
    ['deadlineAt', { deadlineAt: 'yesterday' }],
    ['command', { command: 'x'.repeat(12_289) }],
    ['commandTruncated', { commandTruncated: 'no' }],
    ['maskedCount', { maskedCount: -1 }],
    ['options', { options: [] }],
    ['options', { options: ['allow'] }],
    ['options', { options: ['allow', 'deny', 'deny'] }],
    ['options', { options: ['allow', 'maybe', 'deny'] }],
    ['root', { root: 'x'.repeat(2001) }],
    ['rawDetail', { command: '', rawDetail: 'x'.repeat(12_289) }],
    ['command', { command: '' }],
  ])('refuses a bad %s', (field, over) => {
    expect(parseApprovalRequest({ ...valid, ...over })).toEqual({ ok: false, reason: `approval_request.${field}` });
  });
});
