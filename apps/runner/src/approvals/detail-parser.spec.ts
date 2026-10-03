import { describe, expect, test } from 'bun:test';
import fixtures from '../../test/fixtures/nax-asks/v0.83.2.json' with { type: 'json' };
import { parseDetail } from './detail-parser';

const FENCE = '```';
/** nax's own layout (ask-link-session.ts:181-188), for synthetic cases. */
const naxDetail = (command: string, opts: { masked?: number; root?: string; reason?: string; stage?: string } = {}): string => [
  FENCE, command, FENCE,
  ...(opts.masked ? [`${opts.masked} secret value(s) masked; the approved command contains them`] : []),
  `request: ${`Bash command=${command}`.slice(0, 200)}`,
  `runs in: ${opts.root ?? '/work/repo'}`,
  `reason:  ${opts.reason ?? 'matched ask rule'}`,
  `stage:   ${opts.stage ?? 'execution'}`,
].join('\n');

describe('parseDetail on captured nax v0.83.2 asks (plan D256, D259)', () => {
  test('a: simple command', () => {
    expect(parseDetail(fixtures.a_simple.detail)).toEqual({ command: 'bun run test', maskedCount: 0, root: '/work/repo', reason: 'matched ask rule', stage: 'execution' });
  });
  test('b: two masked secrets', () => {
    const parsed = parseDetail(fixtures.b_two_secrets.detail);
    expect(parsed?.maskedCount).toBe(2);
    expect(parsed?.command).toContain('[REDACTED:openai]');
  });
  test('c: a multi-line command containing a fence', () => {
    expect(parseDetail(fixtures.c_multiline_fence.detail)?.command).toBe("cat > notes.md <<'EOF'\n```ts\nconsole.log(1)\n```\nEOF\nbun run test");
  });
  test('d: long root and free-text reason', () => {
    const parsed = parseDetail(fixtures.d_longest_padding.detail);
    expect(parsed?.root).toBe('/Users/someone/very/long/path/to/repo/packages/pkg-a');
    expect(parsed?.reason).toStartWith("command 'rm -rf build/' is not covered");
  });
  test('e: a command-less ask is not parsed (bash asks always carry a command)', () => {
    expect(parseDetail(fixtures.e_no_command_write.detail)).toBeNull();
  });
});

describe('parseDetail edge cases', () => {
  test('a command longer than the 200-char request cap still parses', () => {
    const command = `echo ${'x'.repeat(400)}`;
    expect(parseDetail(naxDetail(command))?.command).toBe(command);
  });
  test('spoofed split: a command that fakes a closing fence and request line is not parsed (Review Focus 1)', () => {
    const command = `echo hi\n${FENCE}\nrequest: Bash command=echo hi`;
    expect(parseDetail(naxDetail(command))).toBeNull();
  });
  test('a summary nax did not cut must equal the command exactly (a diverging summary is not parsed)', () => {
    const detail = [FENCE, 'ls', FENCE, 'request: Bash command=rm', 'runs in: /w', 'reason:  r', 'stage:   execution'].join('\n');
    expect(parseDetail(detail)).toBeNull();
  });
  test('a real split that diverges plus one crafted consistent fake is still not parsed (two candidates)', () => {
    const fakeSummary = 'Bash command=DIFFERENT';
    const command = `ls\n${FENCE}\nrequest: ${fakeSummary}\n${FENCE}\nrequest: Bash command=ls`;
    const detail = [FENCE, command, FENCE, `request: ${fakeSummary}`, 'runs in: /w', 'reason:  r', 'stage:   execution'].join('\n');
    expect(parseDetail(detail)).toBeNull();
  });
  test('a 200-char summary is checked as a prefix (nax cut it)', () => {
    const command = 'x'.repeat(187);   // "Bash command=" + 187 = exactly 200
    expect(parseDetail(naxDetail(command))?.command).toBe(command);
  });
  test('stage comes from the detail line', () => {
    expect(parseDetail(naxDetail('ls', { stage: 'review' }))?.stage).toBe('review');
  });
  test('a missing tail line is not parsed', () => {
    expect(parseDetail(naxDetail('ls').split('\n').slice(0, -1).join('\n'))).toBeNull();
  });
  test('a reason with a newline is not parsed (tail lines are single-line)', () => {
    expect(parseDetail(naxDetail('ls', { reason: 'a\nb' }))).toBeNull();
  });
  test('a non-Bash summary that does not repeat the command is not parsed', () => {
    const detail = [FENCE, 'ls', FENCE, 'request: Exec argv=ls', 'runs in: /w', 'reason:  r', 'stage:   execution'].join('\n');
    expect(parseDetail(detail)).toBeNull();
  });
});
