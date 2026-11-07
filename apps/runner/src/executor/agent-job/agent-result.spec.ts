import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AGENT_RESULT_LIMITS } from '@nathapp/fleet-protocol';
import { AGENT_STDOUT_MAX_BYTES, fitAgentResult, readAgentResult } from './agent-result';

/**
 * The server's `stripNul` (apps/api/src/fleet/sync/sync-request.parser.ts): Postgres refuses U+0000, so
 * every payload string and key is written with U+FFFD instead before the result is validated. It is
 * reproduced here because the runner package cannot import the API, and pinned on the API side by
 * `sync-request.parser.spec.ts` and by `agent-result.spec.ts` there.
 */
function replaceNul(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('\u0000', '\uFFFD');
  if (Array.isArray(value)) return value.map(replaceNul);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.replaceAll('\u0000', '\uFFFD'), replaceNul(v)]));
  }
  return value;
}

const sample = {
  agent: 'spec-reviewer', model: 'acp:claude', status: 'completed' as const, output: 'ok',
  deniedAsks: [] as Array<{ kind: 'question'; text: string }>, costUsd: 0.0123,
};

function isWellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

describe('AGENT result', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'koda-agent-result-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function putStdout(text: string): Promise<void> { await writeFile(join(dir, 'nax.stdout'), text); }

  test('AC-1 reads and validates the nax JSON result', async () => {
    await putStdout(JSON.stringify(sample));
    const result = await readAgentResult(dir);
    expect(result).toEqual({ ok: true, result: sample });
  });

  test('AC-2 returns the first non-empty stderr line on empty stdout', async () => {
    await putStdout('');
    await writeFile(join(dir, 'nax.stderr'), '\nerror: unknown agent x\nmore');
    expect(await readAgentResult(dir)).toEqual({ ok: false, stderrLine: 'error: unknown agent x' });
  });

  test('AC-3 rejects malformed JSON, unsupported status and stdout over the bound', async () => {
    for (const text of ['not json', '{"status":"weird"}', JSON.stringify(sample) + ' '.repeat(AGENT_STDOUT_MAX_BYTES)]) {
      await putStdout(text);
      expect((await readAgentResult(dir)).ok).toBe(false);
    }
  });

  test('AC-4 truncates the first stderr line at 300 characters', async () => {
    await putStdout('');
    await writeFile(join(dir, 'nax.stderr'), `${'x'.repeat(500)}\n`);
    expect(await readAgentResult(dir)).toEqual({ ok: false, stderrLine: 'x'.repeat(300) });
  });

  test('AC-5 retains only the UTF-8 output tail at the output bound', () => {
    const output = 'a'.repeat(20_000);
    const fitted = fitAgentResult({ ...sample, output });
    expect(fitted.output).toBe(output.slice(-8192));
    expect(Buffer.byteLength(fitted.output)).toBeLessThanOrEqual(8192);
    expect(fitted.truncated).toBe(true);
  });

  test('AC-6 leaves short output whole and untruncated', () => {
    const fitted = fitAgentResult({ ...sample, output: '1234567890' });
    expect(fitted.output).toBe('1234567890');
    expect(fitted.truncated).toBe(false);
  });

  test('AC-7 caps denied asks at ten and marks the cut', () => {
    const deniedAsks = Array.from({ length: 25 }, (_, i) => ({ kind: 'question' as const, text: String(i) }));
    const fitted = fitAgentResult({ ...sample, deniedAsks });
    expect(fitted.deniedAsks).toHaveLength(10);
    expect(fitted.deniedAsks[0]).toEqual({ kind: 'question', text: '0' });
    expect(fitted.deniedAsksTruncated).toBe(true);
  });

  test('AC-8 clips question text and approval tool', () => {
    const fitted = fitAgentResult({ ...sample, deniedAsks: [
      { kind: 'question', text: 'q'.repeat(1500) },
      { kind: 'approval', tool: 't'.repeat(200), summary: 'summary' },
    ] });
    expect(fitted.deniedAsks).toEqual([
      { kind: 'question', text: 'q'.repeat(500) },
      { kind: 'approval', tool: 't'.repeat(128), summary: 'summary' },
    ]);
  });

  test('AC-9 clips model to 200 characters', () => {
    expect(fitAgentResult({ ...sample, model: 'm'.repeat(300) }).model).toBe('m'.repeat(200));
  });

  test('F1 clips at character limits without splitting astral characters', async () => {
    const emoji = '😀';
    const fitted = fitAgentResult({ ...sample,
      model: `${'m'.repeat(199)}${emoji}`,
      deniedAsks: [
        { kind: 'question', text: `${'q'.repeat(499)}${emoji}` },
        { kind: 'approval', tool: `${'t'.repeat(127)}${emoji}`, summary: `${'s'.repeat(499)}${emoji}` },
      ],
    });
    const question = fitted.deniedAsks[0];
    const approval = fitted.deniedAsks[1];
    const values = [fitted.model ?? '', question?.kind === 'question' ? question.text : '',
      approval?.kind === 'approval' ? approval.tool : '', approval?.kind === 'approval' ? approval.summary : ''];
    expect(values).toEqual(['m'.repeat(199), 'q'.repeat(499), 't'.repeat(127), 's'.repeat(499)]);
    for (const value of values) expect(isWellFormed(value)).toBe(true);

    await putStdout('');
    await writeFile(join(dir, 'nax.stderr'), `${'e'.repeat(299)}${emoji}\n`);
    const failure = await readAgentResult(dir);
    expect(failure).toEqual({ ok: false, stderrLine: 'e'.repeat(299) });
    if (!failure.ok && failure.stderrLine) expect(isWellFormed(failure.stderrLine)).toBe(true);
  });

  test('F2 reads a short stderr diagnostic without loading a large trailing file', async () => {
    await putStdout('');
    await writeFile(join(dir, 'nax.stderr'), `error: short diagnostic\n${'x'.repeat(8 * 1024 * 1024)}`);
    expect(await readAgentResult(dir)).toEqual({ ok: false, stderrLine: 'error: short diagnostic' });
  });

  test('AC-10 measures escaped UTF-8 JSON and preserves an output tail', () => {
    const output = '"'.repeat(20_000);
    const deniedAsks = Array.from({ length: 10 }, () => ({ kind: 'question' as const, text: 'x'.repeat(500) }));
    const fitted = fitAgentResult({ ...sample, output, deniedAsks });
    expect(Buffer.byteLength(JSON.stringify(fitted), 'utf8')).toBeLessThanOrEqual(12_288);
    expect(output.endsWith(fitted.output)).toBe(true);
    expect(Buffer.byteLength(fitted.output)).toBeLessThanOrEqual(8192);
  });

  test('AC-11 formats optional numeric cost as a decimal string', () => {
    expect(fitAgentResult(sample).costUsd).toBe('0.0123');
  });

  test('AC-12 omits cost when nax did not price the run', () => {
    expect('costUsd' in fitAgentResult({ ...sample, costUsd: undefined })).toBe(false);
  });

  test('F3 (B1): a NUL-bearing result survives the sync replacement inside both API limits', () => {
    // The API replaces U+0000 with U+FFFD in every payload string before it validates the result
    // (`stripNul` in apps/api/src/fleet/sync/sync-request.parser.ts, pinned by sync-request.parser.spec.ts).
    // A NUL is one byte here and three there, so a result fitted before that replacement grows past
    // `maxOutputBytes` or `budgetBytes` on the server and is dropped whole.
    const output = `${'a'.repeat(8191)}\u0000`;
    const deniedAsks = [
      { kind: 'question' as const, text: `q${'\u0000'.repeat(20)}` },
      { kind: 'approval' as const, tool: `t${'\u0000'}`, summary: `s${'\u0000'.repeat(5)}` },
    ];
    const fitted = fitAgentResult({ ...sample, model: `m${'\u0000'}`, output, deniedAsks });
    // The sync body as JSON, then the API's replacement: exactly what the server validates and stores.
    const stored = replaceNul(JSON.parse(JSON.stringify(fitted))) as typeof fitted;
    expect(JSON.stringify(stored)).not.toContain('\\u0000');
    expect(Buffer.byteLength(stored.output, 'utf8')).toBeLessThanOrEqual(AGENT_RESULT_LIMITS.maxOutputBytes);
    expect(Buffer.byteLength(JSON.stringify(stored), 'utf8')).toBeLessThanOrEqual(AGENT_RESULT_LIMITS.budgetBytes);
    // The replacement is not a cut: a whole output inside the bound stays whole and untruncated.
    const whole = fitAgentResult({ ...sample, output: 'done\u0000' });
    expect(whole.truncated).toBe(false);
    expect(whole.output).toBe('done\uFFFD');
  });
});
