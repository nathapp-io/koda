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
