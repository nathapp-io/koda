import { describe, expect, test } from 'bun:test';
import fixtures from '../../test/fixtures/nax-asks/v0.83.2.json' with { type: 'json' };
import { buildAskPayload, capUtf8 } from './ask-payload';

const a = fixtures.a_simple;

describe('buildAskPayload (spec §1.2, §4.2, plan D283)', () => {
  test('a parsed ask: top-level stage/story/feature, detail-derived command/root/reason, deadline = createdAt + timeout', () => {
    expect(buildAskPayload(a)).toEqual({
      naxAskId: 'ask-1f2e3d4c', deadlineAt: new Date(a.createdAt + a.timeout).toISOString(),
      command: 'bun run test', commandTruncated: false, maskedCount: 0, root: '/work/repo', stage: 'execution',
      storyId: 'US-001', featureName: 'demo-feature', reason: 'matched ask rule', options: ['allow', 'allow-remember', 'deny'],
    });
  });
  test('options without allow-remember are kept as offered', () => {
    expect(buildAskPayload(fixtures.d_longest_padding)?.options).toEqual(['allow', 'deny']);
    expect(buildAskPayload(fixtures.d_longest_padding)?.storyId).toBeNull();
  });
  test('an unparsed detail is relayed raw with an empty command (D255: the request line stays, it is masked)', () => {
    const payload = buildAskPayload({ ...a, detail: 'something nax changed\nruns in: /w' });
    expect(payload).toEqual(expect.objectContaining({ command: '', rawDetail: 'something nax changed\nruns in: /w', commandTruncated: false }));
  });
  test('a command over 12 KiB is cut on a UTF-8 boundary and flagged', () => {
    const command = `echo ${'é'.repeat(7000)}`;
    const detail = ['```', command, '```', `request: ${`Bash command=${command}`.slice(0, 200)}`, 'runs in: /w', 'reason:  r', 'stage:   execution'].join('\n');
    const payload = buildAskPayload({ ...a, detail });
    if (payload === null) throw new Error('expected a payload');   // lint: no non-null assertions
    expect(payload.commandTruncated).toBe(true);
    expect(Buffer.byteLength(payload.command, 'utf8')).toBeLessThanOrEqual(12_288);
    expect(payload.command).not.toContain('\uFFFD');
  });
  const naxDetail = (command: string, over: { root?: string; reason?: string } = {}) =>
    ['```', command, '```', `request: ${`Bash command=${command}`.slice(0, 200)}`, `runs in: ${over.root ?? '/w'}`, `reason:  ${over.reason ?? 'r'}`, 'stage:   execution'].join('\n');
  const json = (p: unknown) => Buffer.byteLength(JSON.stringify(p), 'utf8');

  test.each([
    ['a 12 KiB command of quotes (JSON doubles them)', { detail: naxDetail('"'.repeat(12_288)) }],
    ['control characters (JSON escapes them to 6 bytes)', { detail: naxDetail('\u0001'.repeat(4_000)) }],
    ['500-char 3-byte short fields', { detail: naxDetail('x'.repeat(12_000), { root: `/${'中'.repeat(500)}`, reason: '中'.repeat(500) }), featureName: '中'.repeat(500), storyId: '中'.repeat(500) }],
  ])('%s still fits the 16 KiB sync event limit, flagged', (_name, over) => {
    const payload = buildAskPayload({ ...a, ...over });
    if (payload === null) throw new Error('expected a payload');   // lint: no non-null assertions
    expect(json(payload)).toBeLessThanOrEqual(16_384);
    expect(payload.commandTruncated).toBe(true);
    expect(payload.command.length).toBeGreaterThan(0);
  });
  test('a command-less ask whose summary nax cut at 200 chars is deny-only (D256)', () => {
    const detail = `request: Write path=${'p'.repeat(191)}\nruns in: /w\nreason:  r\nstage:   execution`;
    expect(buildAskPayload({ ...a, detail })?.commandTruncated).toBe(true);
    expect(buildAskPayload({ ...a, detail: 'request: Write path=/a\nruns in: /w\nreason:  r\nstage:   execution' })?.commandTruncated).toBe(false);
  });
  test.each([
    ['a non-approval ask', { metadata: {} }],
    ['an ask without deny', { options: [{ key: 'allow', label: 'Allow once' }] }],
    ['a non-numeric createdAt', { createdAt: 'now' }],
    ['a missing timeout', { timeout: undefined }],
    ['a bad id', { id: 'trigger-cost-1' }],
  ])('%s is not relayable', (_name, over) => {
    expect(buildAskPayload({ ...a, ...over } as never)).toBeNull();
  });
});

describe('capUtf8', () => {
  test('keeps short text and cuts long text on a character boundary', () => {
    expect(capUtf8('abc', 10)).toEqual({ text: 'abc', cut: false });
    expect(capUtf8('ééé', 5)).toEqual({ text: 'éé', cut: true });
  });
});
