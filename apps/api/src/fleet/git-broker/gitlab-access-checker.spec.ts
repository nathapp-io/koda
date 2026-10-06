import { GitLabAccessChecker } from './gitlab-access-checker';
import { FleetHttpClient } from './fleet-http-client';
import { RepoCheckException } from './repo-check.exception';
import { FakeForge, startFakeForge } from '../../../test/helpers/fake-forge';

describe('GitLabAccessChecker', () => {
  let forge: FakeForge;
  let checker: GitLabAccessChecker;
  const project = (access: number | null, group: number | null = null) => ({
    status: 200,
    body: {
      path_with_namespace: 'group/sub/app', default_branch: 'main',
      permissions: { project_access: access === null ? null : { access_level: access }, group_access: group === null ? null : { access_level: group } },
    },
  });

  beforeAll(async () => {
    forge = await startFakeForge();
    checker = new GitLabAccessChecker({ gitlabApiUrl: `${forge.url}/api/v4` } as never, new FleetHttpClient({ httpTimeoutMs: 2000 } as never));
  });
  afterAll(() => forge.close());
  beforeEach(() => forge.routes.clear());

  const scopes = (s: string[]) => forge.routes.set('GET /api/v4/personal_access_tokens/self', () => ({ status: 200, body: { scopes: s } }));
  const PROJECT = `GET /api/v4/projects/${encodeURIComponent('Group/Sub/App')}`;

  it('accepts Developer access with write_repository and returns the canonical path', async () => {
    scopes(['read_api', 'write_repository']);
    forge.routes.set(PROJECT, () => project(30));
    await expect(checker.verifyRepo('Group/Sub', 'App', 'glpat')).resolves.toEqual({ owner: 'group/sub', name: 'app', defaultBranch: 'main' });
  });

  it('uses group access when it is the higher level', async () => {
    scopes(['write_repository']);
    forge.routes.set(PROJECT, () => project(10, 40));
    await expect(checker.verifyRepo('Group/Sub', 'App', 'glpat')).resolves.toEqual(expect.objectContaining({ name: 'app' }));
  });

  it.each([
    ['a token without write_repository', () => { scopes(['read_api']); forge.routes.set(PROJECT, () => project(40)); }, 'gitlab_scope_missing'],
    ['Reporter access', () => { scopes(['write_repository']); forge.routes.set(PROJECT, () => project(20)); }, 'gitlab_access_insufficient'],
    ['an invalid token', () => { forge.routes.set('GET /api/v4/personal_access_tokens/self', () => ({ status: 401, body: {} })); }, 'gitlab_token_invalid'],
    ['a missing project', () => { scopes(['write_repository']); }, 'repo_not_found'],
  ])('rejects %s', async (_label, arrange, reason) => {
    arrange();
    await expect(checker.verifyRepo('Group/Sub', 'App', 'glpat')).rejects.toMatchObject({ reason: reason });
  });

  describe('getMergeRequest (C9 §3.4)', () => {
    const MR = `GET /api/v4/projects/${encodeURIComponent('grp/sub/app')}/merge_requests/4`;

    it('maps a merged MR and sends the token', async () => {
      forge.routes.set(MR, () => ({
        status: 200,
        body: {
          state: 'merged', draft: false, merged_at: '2026-10-06T01:00:00Z', merged_by: { username: 'dev' },
          merge_commit_sha: null, squash_commit_sha: 'sq1', web_url: 'https://gitlab.com/grp/sub/app/-/merge_requests/4', title: 'Fix',
        },
      }));
      await expect(checker.getMergeRequest('glpat', 'grp/sub', 'app', 4)).resolves.toEqual({
        number: 4, state: 'closed', draft: false, merged: true, mergedAt: new Date('2026-10-06T01:00:00Z'), mergedBy: 'dev',
        mergeSha: 'sq1', url: 'https://gitlab.com/grp/sub/app/-/merge_requests/4', title: 'Fix',
      });
      expect(forge.requests.at(-1)?.headers['private-token']).toBe('glpat');
    });

    it.each([
      [{ state: 'opened', draft: true }, { state: 'open', draft: true, merged: false }],
      [{ state: 'opened', work_in_progress: true }, { state: 'open', draft: true, merged: false }],
      [{ state: 'closed' }, { state: 'closed', draft: false, merged: false }],
      [{ state: 'locked' }, { state: 'closed', draft: false, merged: false }],
    ])('maps %j', async (body, expected) => {
      forge.routes.set(MR, () => ({ status: 200, body: { web_url: 'u', title: 't', ...body } }));
      await expect(checker.getMergeRequest('t', 'grp/sub', 'app', 4)).resolves.toEqual(expect.objectContaining(expected));
    });

    it('returns null for 404 and throws provider_error for 502', async () => {
      await expect(checker.getMergeRequest('t', 'grp/sub', 'app', 4)).resolves.toBeNull();
      forge.routes.set(MR, () => ({ status: 502, body: {} }));
      await expect(checker.getMergeRequest('t', 'grp/sub', 'app', 4)).rejects.toMatchObject({ reason: 'provider_error' });
    });
  });
});
