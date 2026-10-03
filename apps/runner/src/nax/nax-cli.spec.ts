import { describe, expect, test } from 'bun:test';
import { StartupError } from '../errors';
import { MIN_NAX_VERSION, NaxUnavailableError, parseNaxJson, parseNaxVersion, readNaxVersion, relaySupported, spawnFailure, versionAtLeast, type NaxCli, type NaxResult } from './nax-cli';

const result = (over: Partial<NaxResult> = {}): NaxResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...over });
const answering = (r: NaxResult): NaxCli => ({ run: async () => r });

describe('parseNaxJson (D96)', () => {
  test('one JSON object is the value, whatever the exit code (sandbox probe and trust check exit 1 with a document)', () => {
    expect(parseNaxJson(result({ code: 1, stdout: '{"available":false,"reason":"x"}' }))).toEqual({ ok: true, value: { available: false, reason: 'x' } });
  });
  test("nax's error document is its code", () => {
    expect(parseNaxJson(result({ code: 1, stdout: '{"error":{"code":"PROFILE_NOT_FOUND","message":"m"}}' }))).toEqual({ ok: false, code: 'PROFILE_NOT_FOUND' });
  });
  test('an error code outside the vocabulary is NAX_ERROR (codes reach stateReason and logs)', () => {
    expect(parseNaxJson(result({ code: 1, stdout: '{"error":{"code":"bad code; rm -rf"}}' }))).toEqual({ ok: false, code: 'NAX_ERROR' });
    expect(parseNaxJson(result({ code: 1, stdout: '{"error":{}}' }))).toEqual({ ok: false, code: 'NAX_ERROR' });
  });
  test.each([['text', 'Profile not found'], ['an array', '[1]'], ['null', 'null'], ['empty output', '']])('%s is NAX_OUTPUT_UNPARSEABLE', (_what, stdout) => {
    expect(parseNaxJson(result({ stdout }))).toEqual({ ok: false, code: 'NAX_OUTPUT_UNPARSEABLE' });
  });
  test('a timeout wins over any output; a missing binary is NAX_NOT_FOUND', () => {
    expect(parseNaxJson(result({ timedOut: true, stdout: '{}' }))).toEqual({ ok: false, code: 'NAX_TIMEOUT' });
    expect(parseNaxJson(result({ code: 127 }))).toEqual({ ok: false, code: 'NAX_NOT_FOUND' });
  });
  test('output over the read budget is NAX_OUTPUT_TOO_LARGE, never a half-read document', () => {
    expect(parseNaxJson(result({ tooLarge: true, stdout: '{"available":' }))).toEqual({ ok: false, code: 'NAX_OUTPUT_TOO_LARGE' });
    expect(parseNaxJson(result({ tooLarge: true, timedOut: true }))).toEqual({ ok: false, code: 'NAX_TIMEOUT' });
  });
  test('D96: only a missing executable is NAX_NOT_FOUND; EACCES, E2BIG and the rest are NAX_SPAWN_FAILED', () => {
    expect(spawnFailure('ENOENT', 'nax')).toEqual({ code: 127, stdout: '', stderr: 'nax: not found', timedOut: false });
    expect(parseNaxJson(spawnFailure('ENOENT', 'nax'))).toEqual({ ok: false, code: 'NAX_NOT_FOUND' });
    expect(parseNaxJson(spawnFailure(undefined, 'nax'))).toEqual({ ok: false, code: 'NAX_NOT_FOUND' });
    for (const errno of ['EACCES', 'E2BIG', 'ENOEXEC', 'ENOTDIR']) {
      const failure = spawnFailure(errno, 'nax');
      expect(failure.stderr).toBe(`nax: cannot start (${errno})`);
      expect(parseNaxJson(failure)).toEqual({ ok: false, code: 'NAX_SPAWN_FAILED' });
    }
  });
});

describe('nax version floor (D97)', () => {
  test.each([
    ['0.83.1', [0, 83, 1]], ['v1.2.3', [1, 2, 3]], ['0.84.0-canary.1', [0, 84, 0]], [' 0.83.1\n', [0, 83, 1]], ['nax 0.83.1', null], ['0.83', null],
  ])('parseNaxVersion(%j)', (text, expected) => {
    expect(parseNaxVersion(text as string)).toEqual(expected as [number, number, number] | null);
  });
  test('versionAtLeast compares part by part, numerically', () => {
    expect(versionAtLeast([0, 83, 1], MIN_NAX_VERSION)).toBe(true);
    expect(versionAtLeast([0, 84, 0], MIN_NAX_VERSION)).toBe(true);
    expect(versionAtLeast([1, 0, 0], MIN_NAX_VERSION)).toBe(true);
    expect(versionAtLeast([0, 83, 0], MIN_NAX_VERSION)).toBe(false);
    expect(versionAtLeast([0, 9, 99], MIN_NAX_VERSION)).toBe(false);
  });
  test('readNaxVersion returns the first line nax printed', async () => {
    expect(await readNaxVersion(answering(result({ stdout: '0.84.0-canary.1\nextra\n' })), '/')).toBe('0.84.0-canary.1');
  });
  test('an older, a missing and a hanging nax are NaxUnavailableError (a StartupError) naming the floor', async () => {
    await expect(readNaxVersion(answering(result({ stdout: '0.83.0\n' })), '/')).rejects.toThrow(/needs nax 0\.83\.1 or newer \(found 0\.83\.0\)/);
    await expect(readNaxVersion(answering(result({ code: 127 })), '/')).rejects.toBeInstanceOf(NaxUnavailableError);
    await expect(readNaxVersion(answering(result({ code: 127 })), '/')).rejects.toBeInstanceOf(StartupError);
    await expect(readNaxVersion(answering(result({ timedOut: true, stdout: '0.90.0' })), '/')).rejects.toThrow(/timed out/);
  });
});

describe('relaySupported (plan D258)', () => {
  test.each([['0.83.0', true], ['0.83.2', true], ['0.84.0', true], ['1.0.0', true], ['0.83.1-fake', true], ['0.82.2', false], ['garbage', false]])(
    '%s -> %p', (version, expected) => {
      expect(relaySupported(version)).toBe(expected);
    });
});
