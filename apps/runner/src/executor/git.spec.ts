import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NO_CREDENTIALS_REASON, GitError, assertMinGitVersion, createGit, isAuthFailure, parseGitVersion, reasonFromError, type Git } from './git';

describe('createGit', () => {
  const git = createGit();
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  const initRepo = async (): Promise<string> => {
    const cwd = await mkdtemp(join(tmpdir(), 'koda-git-hardening-'));
    tempDirs.push(cwd);
    const init = Bun.spawn(['git', 'init', '-q', cwd], { stdout: 'ignore', stderr: 'pipe' });
    if (await init.exited !== 0) throw new Error(await new Response(init.stderr).text());
    for (const [key, value] of [['user.name', 'Test User'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false']] as const) {
      const config = Bun.spawn(['git', '-C', cwd, 'config', key, value], { stdout: 'ignore', stderr: 'pipe' });
      if (await config.exited !== 0) throw new Error(await new Response(config.stderr).text());
    }
    return cwd;
  };
  test('ignores local pre-commit hooks when committing', async () => {
    const cwd = await initRepo();
    const hooks = join(cwd, 'hooks');
    const marker = join(cwd, 'hook-ran');
    await mkdir(hooks);
    const hook = join(hooks, 'pre-commit');
    await writeFile(hook, `#!/bin/sh\nprintf ran > '${marker}'\n`);
    await chmod(hook, 0o755);
    const config = Bun.spawn(['git', '-C', cwd, 'config', 'core.hooksPath', hooks], { stdout: 'ignore', stderr: 'pipe' });
    if (await config.exited !== 0) throw new Error(await new Response(config.stderr).text());
    await expect(git.ok(['commit', '--allow-empty', '-m', 'x'], { cwd })).resolves.toContain('x');
    expect(await Bun.file(marker).exists()).toBe(false);
  });
  test('overrides local hooksPath', async () => {
    const cwd = await initRepo();
    const config = Bun.spawn(['git', '-C', cwd, 'config', 'core.hooksPath', '/tmp/elsewhere'], { stdout: 'ignore', stderr: 'pipe' });
    if (await config.exited !== 0) throw new Error(await new Response(config.stderr).text());
    expect((await git.ok(['config', '--get', 'core.hooksPath'], { cwd })).trim()).toBe('/dev/null');
  });
  test('overrides local fsmonitor', async () => {
    const cwd = await initRepo();
    const config = Bun.spawn(['git', '-C', cwd, 'config', 'core.fsmonitor', 'true'], { stdout: 'ignore', stderr: 'pipe' });
    if (await config.exited !== 0) throw new Error(await new Response(config.stderr).text());
    expect((await git.ok(['config', '--get', 'core.fsmonitor'], { cwd })).trim()).toBe('false');
  });
  test('overrides local submodule recursion', async () => {
    const cwd = await initRepo();
    const config = Bun.spawn(['git', '-C', cwd, 'config', 'submodule.recurse', 'true'], { stdout: 'ignore', stderr: 'pipe' });
    if (await config.exited !== 0) throw new Error(await new Response(config.stderr).text());
    expect((await git.ok(['config', '--get', 'submodule.recurse'], { cwd })).trim()).toBe('false');
  });
  test('keeps credential helper overrides after the hardening prefix', async () => {
    const cwd = await initRepo();
    const output = await git.ok(['config', '--get-all', 'credential.helper'], { cwd, credentialHelper: '!f() { echo x; }; f', env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    expect(output.split('\n')).toEqual(['', '!f() { echo x; }; f', '']);
  });
  test('runs git and returns code, stdout and stderr without throwing', async () => {
    const version = await git.run(['--version'], { cwd: process.cwd() });
    expect(version.code).toBe(0);
    expect(version.stdout).toMatch(/^git version/);
    const bad = await git.run(['rev-parse', '--verify', 'nope^{commit}'], { cwd: process.cwd() });
    expect(bad.code).not.toBe(0);
  });
  test('bounds stderr while draining it and preserves the actual exit code', async () => {
    const cwd = await initRepo();
    const result = await git.run(['-c', 'alias.noisy=!{ printf "diagnostic "; yes x | head -c 300000; } >&2; exit 23', 'noisy'], { cwd, onStdout: () => true });
    expect(result.code).toBe(23);
    expect(result.stderr).toStartWith('diagnostic ');
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(65_536);
  });

  test('stops a streaming child before it waits on stdout or stderr held by a descendant', async () => {
    const cwd = await initRepo();
    const result = await git.run(['-c', 'alias.waiter=!printf ready; sleep 30 & wait', 'waiter'], {
      cwd, onStdout: () => false, timeoutMs: 2_000,
    });
    expect(result.stdoutStopped).toBe(true);
    expect(result.timedOut).toBeUndefined();
    expect(result.code).toBe(0);
  });

  test('reports a streaming subprocess timeout even if a descendant holds its pipes open', async () => {
    const cwd = await initRepo();
    const result = await git.run(['-c', 'alias.waiter=!sleep 30 & wait', 'waiter'], {
      cwd, onStdout: () => true, timeoutMs: 100,
    });
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
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

describe('createGit file transport (review-1118 US-001)', () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  /** A local bare origin and a directory beside it: the clone the file transport is asked to refuse. */
  async function localOrigin(): Promise<{ base: string; url: string }> {
    const base = await mkdtemp(join(tmpdir(), 'koda-git-file-'));
    tempDirs.push(base);
    const origin = join(base, 'o.git');
    for (const args of [['init', '-q', '--bare', '-b', 'main', origin], ['-C', origin, 'config', 'user.name', 'T'], ['-C', origin, 'config', 'user.email', 't@x']]) {
      const proc = Bun.spawn(['git', ...args], { stdout: 'ignore', stderr: 'pipe' });
      if (await proc.exited !== 0) throw new Error(await new Response(proc.stderr).text());
    }
    return { base, url: `file://${origin}` };
  }
  test('AC-5: a file-URL clone with fileProtocol never fails', async () => {
    const { base, url } = await localOrigin();
    const result = await createGit().run(['clone', '--', url, join(base, 'clone')], { cwd: base, fileProtocol: 'never' });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('transport \'file\' not allowed');
  });
  test('the same clone with fileProtocol always succeeds', async () => {
    const { base, url } = await localOrigin();
    const result = await createGit().run(['clone', '--', url, join(base, 'clone')], { cwd: base, fileProtocol: 'always' });
    expect(result.code).toBe(0);
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
  test('D89: an authentication failure is `git auth failed`', () => {
    expect(NO_CREDENTIALS_REASON).toBe('git auth failed');
  });
});
