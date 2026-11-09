import { GitHubAppClient } from './github-app-client';
import type { FleetHttpClient } from './fleet-http-client';

const comparison = () => ({
  status: 'ahead', total_commits: 1, merge_base_commit: { sha: 'base' },
  commits: [{ sha: 'head', parents: [{ sha: 'base' }] }],
  files: [{ filename: '.nax/spec.md', status: 'modified' }],
});

function build(body: unknown = comparison(), status = 200) {
  const http = { request: vi.fn<FleetHttpClient['request']>(async () => ({ status, body })) };
  const client = new GitHubAppClient({} as never, { githubApiUrl: 'https://forge.test' }, http as never, {} as never);
  return { client, http };
}

describe('GitHubAppClient.isSingleFileCommit', () => {
  it('verifies a single direct-child commit changing only the spec, with encoded refs', async () => {
    const { client, http } = build();
    await expect(client.isSingleFileCommit('test-token', 'o', 'r', 'base', 'head', '.nax/spec.md')).resolves.toBe(true);
    expect(http.request).toHaveBeenCalledWith('GET', 'https://forge.test/repos/o/r/compare/base...head', expect.objectContaining({ authorization: 'Bearer test-token' }));
    await client.isSingleFileCommit('test-token', 'o', 'r', 'a/b', 'h?', '.nax/spec.md');
    expect(http.request.mock.calls.at(-1)?.[1]).toBe('https://forge.test/repos/o/r/compare/a%2Fb...h%3F');
  });

  it.each([
    { status: 'diverged' },
    { total_commits: 2 },
    { merge_base_commit: { sha: 'other' } },
    { commits: [{ sha: 'other', parents: [{ sha: 'base' }] }] },
    { commits: [{ sha: 'head', parents: [{ sha: 'base' }, { sha: 'other' }] }] },
    { commits: [{ sha: 'head', parents: [{ sha: 'other' }] }] },
    { files: [{ filename: 'other.md', status: 'modified' }] },
    { files: [{ filename: '.nax/spec.md', status: 'renamed' }] },
    { files: [{ filename: '.nax/spec.md', status: 'modified' }, { filename: 'other.md', status: 'added' }] },
    { files: [] },
    { files: undefined },
  ])('fails closed for an unproven calls-only commit: %j', async (patch) => {
    const { client } = build({ ...comparison(), ...patch });
    await expect(client.isSingleFileCommit('t', 'o', 'r', 'base', 'head', '.nax/spec.md')).resolves.toBe(false);
  });

  it.each([[403, 'app_permissions_insufficient'], [404, 'repo_not_found'], [500, 'provider_error']])(
    'maps HTTP %s to %s', async (status, reason) => {
      const { client } = build({}, Number(status));
      await expect(client.isSingleFileCommit('t', 'o', 'r', 'base', 'head', '.nax/spec.md')).rejects.toMatchObject({ reason });
    },
  );
});

describe('GitHubAppClient.isOwnCallsRun', () => {
  const own = { paths: ['a.md', 'b.md'], marker: 'flow calls from SPEC_REVIEW job j1' };
  const run = () => ({
    status: 'ahead', total_commits: 2, merge_base_commit: { sha: 'base' },
    commits: [
      { sha: 'c1', parents: [{ sha: 'base' }], commit: { message: 'docs(a): flow calls from SPEC_REVIEW job j1' } },
      { sha: 'head', parents: [{ sha: 'c1' }], commit: { message: 'docs(b): flow calls from SPEC_REVIEW job j1' } },
    ],
    files: [{ filename: 'a.md', status: 'modified' }, { filename: 'b.md', status: 'modified' }],
  });

  it('accepts a linear run of the job own commits on its spec paths', async () => {
    const { client } = build(run());
    await expect(client.isOwnCallsRun('t', 'o', 'r', 'base', 'head', own)).resolves.toBe(true);
  });

  it.each([
    { status: 'diverged' },
    { total_commits: 3 },
    { merge_base_commit: { sha: 'other' } },
    { commits: [] },
    { files: [{ filename: 'c.md', status: 'modified' }] },
    { files: [{ filename: 'a.md', status: 'added' }] },
    { files: [] },
    { commits: [{ sha: 'c1', parents: [{ sha: 'base' }], commit: { message: 'fix: outside edit' } }, { sha: 'head', parents: [{ sha: 'c1' }], commit: { message: 'flow calls from SPEC_REVIEW job j1' } }] },
    { commits: [{ sha: 'c1', parents: [{ sha: 'x' }], commit: { message: 'flow calls from SPEC_REVIEW job j1' } }, { sha: 'head', parents: [{ sha: 'c1' }], commit: { message: 'flow calls from SPEC_REVIEW job j1' } }] },
    { commits: [{ sha: 'c1', parents: [{ sha: 'base' }], commit: { message: 'flow calls from SPEC_REVIEW job j1' } }, { sha: 'other', parents: [{ sha: 'c1' }], commit: { message: 'flow calls from SPEC_REVIEW job j1' } }] },
  ])('fails closed for anything else: %j', async (patch) => {
    const { client } = build({ ...run(), ...patch });
    await expect(client.isOwnCallsRun('t', 'o', 'r', 'base', 'head', own)).resolves.toBe(false);
  });

  it('maps a forge error to a reason', async () => {
    const { client } = build({}, 500);
    await expect(client.isOwnCallsRun('t', 'o', 'r', 'base', 'head', own)).rejects.toMatchObject({ reason: 'provider_error' });
  });
});
