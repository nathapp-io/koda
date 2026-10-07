import { describe, expect, test } from 'bun:test';
import { lastUrl, openPullRequest, type OpenPrInput } from './open-pr';
import { StoppedError, type ProcResult } from './types';

const res = (code: number, stdout = '', stderr = '', over: Partial<ProcResult> = {}): ProcResult => ({ code, stdout, stderr, timedOut: false, stopped: false, ...over });
const input = (answers: ProcResult[], over: Partial<OpenPrInput> = {}) => {
  const calls: string[][] = [];
  const run = async (argv: readonly string[]) => { calls.push([...argv]); return answers.shift() ?? res(1); };
  return { calls, input: { run, provider: 'github', repoSlug: 'acme/app', base: 'main', head: 'nax-config/cj1', title: 'T', body: null, ...over } as OpenPrInput };
};

describe('lastUrl', () => {
  test('takes the last http(s) URL in the output', () => {
    expect(lastUrl('Creating pull request\nhttps://github.com/acme/app/pull/12\n')).toBe('https://github.com/acme/app/pull/12');
    expect(lastUrl('!3 T (nax-config/cj1)\n https://gitlab.com/acme/app/-/merge_requests/3\n')).toBe('https://gitlab.com/acme/app/-/merge_requests/3');
    expect(lastUrl('no url here')).toBeNull();
  });
});

describe('openPullRequest (spec §5 step 8, D472)', () => {
  test('GitHub: gh pr create with repo, base, head, title and body', async () => {
    const t = input([res(0, 'https://github.com/acme/app/pull/12\n')], { body: 'Why' });
    expect(await openPullRequest(t.input)).toEqual({ ok: true, url: 'https://github.com/acme/app/pull/12' });
    expect(t.calls).toEqual([['gh', 'pr', 'create', '--repo', 'acme/app', '--base', 'main', '--head', 'nax-config/cj1', '--title', 'T', '--body', 'Why']]);
  });
  test('GitHub: a failed create falls back to the PR that already exists for the branch', async () => {
    const t = input([res(1, '', 'a pull request for branch "nax-config/cj1" already exists'), res(0, 'https://github.com/acme/app/pull/9\n')]);
    expect(await openPullRequest(t.input)).toEqual({ ok: true, url: 'https://github.com/acme/app/pull/9' });
    expect(t.calls[1]).toEqual(['gh', 'pr', 'view', 'nax-config/cj1', '--repo', 'acme/app', '--json', 'url', '--jq', '.url']);
  });
  test('GitLab: glab mr create, fallback reads web_url from mr view json', async () => {
    const t = input([res(1, '', 'already exists'), res(0, JSON.stringify({ web_url: 'https://gitlab.com/acme/app/-/merge_requests/4' }))], { provider: 'gitlab' });
    expect(await openPullRequest(t.input)).toEqual({ ok: true, url: 'https://gitlab.com/acme/app/-/merge_requests/4' });
    expect(t.calls).toEqual([
      ['glab', 'mr', 'create', '--repo', 'acme/app', '--source-branch', 'nax-config/cj1', '--target-branch', 'main', '--title', 'T', '--description', '', '--yes'],
      ['glab', 'mr', 'view', 'nax-config/cj1', '--repo', 'acme/app', '--output', 'json'],
    ]);
  });
  test('no PR and no existing one: a failure that says the branch is pushed', async () => {
    const t = input([res(1, '', 'HTTP 422'), res(1, '', 'no pull requests found')]);
    const result = await openPullRequest(t.input);
    expect(result).toMatchObject({ ok: false });
    expect((result as { output: string }).output).toContain('gh pr create failed (exit 1)');
    expect((result as { output: string }).output).toContain('the branch is pushed; open the PR by hand');
  });
  test('a create that exits 0 without a URL is not a success', async () => {
    const t = input([res(0, 'done'), res(1)]);
    expect((await openPullRequest(t.input)).ok).toBe(false);
  });
  test('a stop during the call surfaces as StoppedError', async () => {
    const t = input([res(143, '', '', { stopped: true })]);
    await expect(openPullRequest(t.input)).rejects.toBeInstanceOf(StoppedError);
  });
});
