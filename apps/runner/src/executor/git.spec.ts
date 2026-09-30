import { describe, expect, test } from 'bun:test';
import { NO_CREDENTIALS_REASON, GitError, assertMinGitVersion, createGit, isAuthFailure, parseGitVersion, reasonFromError, type Git } from './git';

describe('createGit', () => {
  const git = createGit();
  test('runs git and returns code, stdout and stderr without throwing', async () => {
    const version = await git.run(['--version'], { cwd: process.cwd() });
    expect(version.code).toBe(0);
    expect(version.stdout).toMatch(/^git version/);
    const bad = await git.run(['rev-parse', '--verify', 'nope^{commit}'], { cwd: process.cwd() });
    expect(bad.code).not.toBe(0);
  });
  test('ok throws a GitError naming the command and the first stderr line', async () => {
    const error = await git.ok(['rev-parse', '--verify', 'definitely-not-a-ref'], { cwd: process.cwd() }).catch((e) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error.message).toMatch(/^git rev-parse failed: /);
  });
  test('never prompts (D69): no-prompt env is forced over a caller env, and the credential helper is emptied', async () => {
    const out = await git.ok(['-c', 'alias.probe=!echo "$GIT_TERMINAL_PROMPT|$GCM_INTERACTIVE|$GIT_ASKPASS|$LC_ALL"', 'probe'], {
      cwd: process.cwd(), env: { GIT_TERMINAL_PROMPT: '1', GCM_INTERACTIVE: 'always' },
    });
    expect(out.trim()).toBe('0|never|true|C');
    expect((await git.ok(['config', '--get', 'credential.helper'], { cwd: process.cwd() })).trim()).toBe('');
  });
});

describe('git version floor (D69)', () => {
  test('parseGitVersion reads the first three numbers, Apple and Windows suffixes included', () => {
    expect(parseGitVersion('git version 2.50.1 (Apple Git-155)\n')).toEqual([2, 50, 1]);
    expect(parseGitVersion('git version 2.30.0')).toEqual([2, 30, 0]);
    expect(parseGitVersion('git version 2.43.0.windows.1')).toEqual([2, 43, 0]);
    expect(parseGitVersion('not git')).toBeNull();
  });
  test('assertMinGitVersion accepts 2.30 and newer, refuses older or unparseable output', async () => {
    const fake = (stdout: string): Git => ({ run: async () => ({ code: 0, stdout, stderr: '' }), ok: async () => stdout });
    await expect(assertMinGitVersion(fake('git version 2.30.0\n'))).resolves.toBeUndefined();
    await expect(assertMinGitVersion(fake('git version 3.0.1\n'))).resolves.toBeUndefined();
    await expect(assertMinGitVersion(fake('git version 2.29.9\n'))).rejects.toThrow(/git 2\.30 or newer/);
    await expect(assertMinGitVersion(fake('garbage'))).rejects.toThrow(/git 2\.30 or newer/);
    await expect(assertMinGitVersion(createGit())).resolves.toBeUndefined();
  });
});

describe('isAuthFailure and reasonFromError (D32)', () => {
  test.each([
    'fatal: Authentication failed for \'https://github.com/a/b.git/\'',
    'fatal: could not read Username for \'https://github.com\': terminal prompts disabled',
    'fatal: could not read Password for \'https://x@github.com\'',
    'git@github.com: Permission denied (publickey).',
    'fatal: unable to access \'https://x/\': The requested URL returned error: 403',
    'remote: Invalid username or password.',
  ])('%s is an authentication failure', (stderr) => expect(isAuthFailure(stderr)).toBe(true));
  test.each(['fatal: repository not found', 'fatal: unable to access: Could not resolve host', ''])('%j is not', (stderr) => {
    expect(isAuthFailure(stderr)).toBe(false);
  });
  test('reasonFromError maps auth to the fixed reason, other git errors to workspace: <line>', () => {
    const auth = new GitError(['clone'], { code: 128, stdout: '', stderr: 'fatal: Authentication failed for x' });
    const other = new GitError(['fetch'], { code: 128, stdout: '', stderr: '\nfatal: repository not found\nmore' });
    expect(reasonFromError(auth)).toBe(NO_CREDENTIALS_REASON);
    expect(reasonFromError(other)).toBe('workspace: fatal: repository not found');
    expect(reasonFromError(new Error('disk full'))).toBe('workspace: disk full');
  });
});
