import type { Mock } from 'vitest';
import { GitLabAccessChecker } from './gitlab-access-checker';
import type { GitLabAccess } from './gitlab-repo-credentials';
import { RepoCheckException } from './repo-check.exception';

/**
 * US-002 (GitLab parity F1): the access-based GitLab client.
 *
 * The transport is stubbed and the resolver is stubbed, so the test targets are production-like
 * https hosts while the host checks stay strict: a blocked address still refuses the call.
 */
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));

vi.mock('node:dns', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:dns')>();
  return { ...original, promises: { ...original.promises, lookup: lookupMock } };
});

const API_BASE = 'https://gitlab.example.com/api/v4';
const PROJECT_ID = 42;
const access: GitLabAccess = { token: 'glpat', target: { apiBase: API_BASE, projectId: PROJECT_ID } };

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

describe('GitLabAccessChecker', () => {
  let sent: Sent[];
  let respond: (request: Sent) => { status: number; body?: unknown };
  let http: { request: Mock };
  let checker: GitLabAccessChecker;

  beforeEach(() => {
    sent = [];
    respond = () => ({ status: 200, body: {} });
    http = {
      request: vi.fn(async (method: string, url: string, headers: Record<string, string>, body?: unknown) => {
        const request = { method, url, headers, body };
        sent.push(request);
        return respond(request);
      }),
    };
    checker = new GitLabAccessChecker(http as never);
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: '192.168.1.20', family: 4 }]);
  });

  const lastRequest = (): Sent => sent[sent.length - 1];

  describe('getMergeRequest (C9 §3.4)', () => {
    it('AC-7: asks the project by its numeric id and sends the access token', async () => {
      respond = () => ({
        status: 200,
        body: {
          state: 'merged', draft: false, merged_at: '2026-10-06T01:00:00Z', merged_by: { username: 'dev' },
          merge_commit_sha: null, squash_commit_sha: 'sq1', web_url: 'https://gitlab.example.com/grp/sub/app/-/merge_requests/7', title: 'Fix',
        },
      });

      await expect(checker.getMergeRequest(access, 7)).resolves.toEqual({
        number: 7, state: 'closed', draft: false, merged: true, mergedAt: new Date('2026-10-06T01:00:00Z'), mergedBy: 'dev',
        mergeSha: 'sq1', url: 'https://gitlab.example.com/grp/sub/app/-/merge_requests/7', title: 'Fix',
      });
      expect(lastRequest().url).toBe(`${API_BASE}/projects/${PROJECT_ID}/merge_requests/7`);
      expect(lastRequest().headers['private-token']).toBe('glpat');
    });

    it('AC-1: maps sha to headSha only when it is a string', async () => {
      respond = () => ({ status: 200, body: { state: 'opened', web_url: 'u', sha: 'abc123' } });
      await expect(checker.getMergeRequest(access, 7)).resolves.toEqual(expect.objectContaining({ headSha: 'abc123' }));
      respond = () => ({ status: 200, body: { state: 'opened', web_url: 'u' } });
      const result = await checker.getMergeRequest(access, 7);
      expect(result).not.toHaveProperty('headSha');
    });

    it.each([
      [{ state: 'opened', draft: true }, { state: 'open', draft: true, merged: false }],
      [{ state: 'opened', work_in_progress: true }, { state: 'open', draft: true, merged: false }],
      [{ state: 'closed' }, { state: 'closed', draft: false, merged: false }],
      [{ state: 'locked' }, { state: 'open', draft: false, merged: false }],
    ])('maps %j', async (body, expected) => {
      respond = () => ({ status: 200, body: { web_url: 'u', title: 't', ...body } });
      await expect(checker.getMergeRequest(access, 4)).resolves.toEqual(expect.objectContaining(expected));
    });

    it('returns null for 404 and throws provider_error for 502', async () => {
      respond = () => ({ status: 404, body: { message: '404 Not Found' } });
      await expect(checker.getMergeRequest(access, 4)).resolves.toBeNull();
      respond = () => ({ status: 502, body: {} });
      await expect(checker.getMergeRequest(access, 4)).rejects.toMatchObject({ reason: 'provider_error' });
    });
  });

  describe('listOpenMergeRequests', () => {
    it('MR-1: requests and maps opened merge requests', async () => {
      respond = () => ({ status: 200, body: [{ iid: 7, sha: 'abc', draft: false, updated_at: '2026-11-17T00:00:00Z', source_project_id: PROJECT_ID }] });
      await expect(checker.listOpenMergeRequests(access, 'grp/app')).resolves.toEqual([{ number: 7, headSha: 'abc', draft: false, headRepoFullName: 'grp/app', updatedAt: new Date('2026-11-17T00:00:00Z') }]);
      expect(lastRequest()).toEqual({ method: 'GET', url: `${API_BASE}/projects/${PROJECT_ID}/merge_requests?state=opened&per_page=100`, headers: { 'private-token': 'glpat' } });
    });

    it('MR-2: marks draft and work-in-progress requests and excludes forks and missing heads', async () => {
      respond = () => ({ status: 200, body: [
        { iid: 1, sha: 'a', draft: true, updated_at: '2026-11-17', source_project_id: PROJECT_ID },
        { iid: 2, sha: 'b', work_in_progress: true, updated_at: '2026-11-17', source_project_id: 9 },
        { iid: 3, sha: null, updated_at: '2026-11-17', source_project_id: PROJECT_ID },
      ] });
      await expect(checker.listOpenMergeRequests(access, 'grp/app')).resolves.toEqual([
        { number: 1, headSha: 'a', draft: true, headRepoFullName: 'grp/app', updatedAt: new Date('2026-11-17') },
        { number: 2, headSha: 'b', draft: true, headRepoFullName: null, updatedAt: new Date('2026-11-17') },
      ]);
    });

    it('MR-3: rejects malformed items', async () => {
      respond = () => ({ status: 200, body: [{ iid: 1, sha: 5, updated_at: '2026-11-17' }] });
      await expect(checker.listOpenMergeRequests(access, 'grp/app')).rejects.toMatchObject({ reason: 'provider_error' });
    });

    it('MR-5: rejects an invalid updated_at date', async () => {
      respond = () => ({ status: 200, body: [{ iid: 1, sha: 'abc', updated_at: 'not-a-date' }] });
      await expect(checker.listOpenMergeRequests(access, 'grp/app')).rejects.toMatchObject({ reason: 'provider_error' });
    });

    it.each([[401, 'gitlab_token_invalid'], [404, 'repo_not_found']] as const)('MR-4: maps status %i', async (status, reason) => {
      respond = () => ({ status, body: {} });
      await expect(checker.listOpenMergeRequests(access, 'grp/app')).rejects.toMatchObject({ reason });
    });
  });

  describe('GitLab reads', () => {
    it('AC-2: pages and maps recursive trees, stopping at a short page', async () => {
      const page = (start: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: `sha-${start + i}`, path: `p${start + i}`, type: i % 2 ? 'tree' : 'blob' }));
      let n = 0;
      respond = () => ({ status: 200, body: ++n === 1 ? page(0, 100) : page(100, 2) });
      const result = await checker.getTree(access, 'h1');
      expect(sent.map((r) => r.url)).toEqual([
        `${API_BASE}/projects/${PROJECT_ID}/repository/tree?ref=h1&recursive=true&per_page=100&page=1`,
        `${API_BASE}/projects/${PROJECT_ID}/repository/tree?ref=h1&recursive=true&per_page=100&page=2`,
      ]);
      expect(result).toEqual({ entries: [{ path: 'p0', type: 'blob', sha: 'sha-0', size: null }, { path: 'p1', type: 'tree', sha: 'sha-1', size: null }, ...Array.from({ length: 100 }, (_, i) => ({ path: `p${i + 2}`, type: i % 2 ? 'tree' : 'blob', sha: `sha-${i + 2}`, size: null }))], truncated: false });
    });

    it('AC-3: caps tree reads at 100 full pages and reports truncation', async () => {
      respond = () => ({ status: 200, body: Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, path: `p${i}`, type: 'blob' })) });
      const result = await checker.getTree(access, 'h1');
      expect(sent).toHaveLength(100);
      expect(result.entries).toHaveLength(10000);
      expect(result.truncated).toBe(true);
    });

    it('AC-4: reports a missing tree page', async () => {
      respond = () => ({ status: 404, body: [] });
      await expect(checker.getTree(access, 'h1')).rejects.toMatchObject({ reason: 'repo_not_found' });
      let page = 0;
      respond = () => ({ status: ++page === 1 ? 200 : 404, body: Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, path: `p${i}`, type: 'blob' })) });
      await expect(checker.getTree(access, 'h1')).rejects.toMatchObject({ reason: 'repo_not_found' });
    });

    it('AC-5: reads note bodies in order and uses the requested URL', async () => {
      respond = () => ({ status: 200, body: [{ body: 'first' }, { body: 2 }, { body: 'second' }] });
      await expect(checker.listMergeRequestNotes(access, 4)).resolves.toEqual(['first', 'second']);
      expect(lastRequest().url).toBe(`${API_BASE}/projects/${PROJECT_ID}/merge_requests/4/notes?per_page=100`);
    });

    it('AC-6: rejects a non-array notes response', async () => {
      respond = () => ({ status: 200, body: {} });
      await expect(checker.listMergeRequestNotes(access, 4)).rejects.toMatchObject({ reason: 'provider_error' });
    });

    it('AC-7: extracts discussion authors and encodes the discussion id', async () => {
      respond = () => ({ status: 200, body: { notes: [{ author: { username: 'alice' } }, { author: { username: 'bob' } }, {}] } });
      await expect(checker.getMergeRequestDiscussion(access, 4, 'd/1')).resolves.toEqual({ authors: ['alice', 'bob'] });
      expect(lastRequest().url).toBe(`${API_BASE}/projects/${PROJECT_ID}/merge_requests/4/discussions/d%2F1`);
    });

    it('AC-8: returns null for a missing discussion', async () => {
      respond = () => ({ status: 404, body: {} });
      await expect(checker.getMergeRequestDiscussion(access, 4, 'd')).resolves.toBeNull();
    });

    it('AC-9: queries members and confirms an exact case-insensitive username match', async () => {
      respond = () => ({ status: 200, body: [{ username: 'alice.b', access_level: 30 }, { username: 'alice.bx', access_level: 50 }] });
      await expect(checker.getMemberAccessLevel(access, 'Alice.B')).resolves.toBe(30);
      expect(lastRequest().url).toBe(`${API_BASE}/projects/${PROJECT_ID}/members/all?query=Alice.B&per_page=100`);
    });

    it('AC-10: returns zero without an exact username match', async () => {
      respond = () => ({ status: 200, body: [{ username: 'alice.bx', access_level: 50 }] });
      await expect(checker.getMemberAccessLevel(access, 'Alice.B')).resolves.toBe(0);
    });

    it.each([
      ['getTree', () => checker.getTree(access, 'h1')],
      ['listMergeRequestNotes', () => checker.listMergeRequestNotes(access, 4)],
      ['getMergeRequestDiscussion', () => checker.getMergeRequestDiscussion(access, 4, 'd')],
      ['getMemberAccessLevel', () => checker.getMemberAccessLevel(access, 'alice')],
      ['listOpenMergeRequests', () => checker.listOpenMergeRequests(access, 'grp/app')],
    ])('AC-11: %s maps HTTP failures', async (_name, invoke) => {
      for (const [status, reason] of [[401, 'gitlab_token_invalid'], [403, 'app_permissions_insufficient'], [500, 'provider_error']] as const) {
        respond = () => ({ status, body: {} });
        await expect(invoke()).rejects.toMatchObject({ reason });
      }
    });

    it.each([
      ['getTree', () => checker.getTree(access, 'h1')],
      ['listMergeRequestNotes', () => checker.listMergeRequestNotes(access, 4)],
      ['getMergeRequestDiscussion', () => checker.getMergeRequestDiscussion(access, 4, 'd')],
      ['getMemberAccessLevel', () => checker.getMemberAccessLevel(access, 'alice')],
      ['listOpenMergeRequests', () => checker.listOpenMergeRequests(access, 'grp/app')],
    ])('AC-12: %s blocks loopback hosts before requesting', async (_name, invoke) => {
      lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
      await expect(invoke()).rejects.toMatchObject({ reason: 'gitlab_host_blocked' });
      expect(sent).toEqual([]);
    });

    it('AC-13: rejects malformed shapes and maps missing resources', async () => {
      for (const invoke of [() => checker.getTree(access, 'h1'), () => checker.listMergeRequestNotes(access, 4), () => checker.getMemberAccessLevel(access, 'a')]) {
        respond = () => ({ status: 200, body: {} });
        await expect(invoke()).rejects.toMatchObject({ reason: 'provider_error' });
      }
      respond = () => ({ status: 200, body: {} });
      await expect(checker.getMergeRequestDiscussion(access, 4, 'd')).rejects.toMatchObject({ reason: 'provider_error' });
      for (const invoke of [() => checker.listMergeRequestNotes(access, 4), () => checker.getMemberAccessLevel(access, 'a')]) {
        respond = () => ({ status: 404, body: {} });
        await expect(invoke()).rejects.toMatchObject({ reason: 'repo_not_found' });
      }
    });
  });

  describe('the shared status mapping', () => {
    it('AC-9: a 401 is an invalid token', async () => {
      respond = () => ({ status: 401, body: { message: '401 Unauthorized' } });
      await expect(checker.getMergeRequest(access, 4)).rejects.toMatchObject({ reason: 'gitlab_token_invalid' });
    });

    it('AC-9: a 403 is not enough permission', async () => {
      respond = () => ({ status: 403, body: { message: '403 Forbidden' } });
      await expect(checker.getMergeRequest(access, 4)).rejects.toMatchObject({ reason: 'app_permissions_insufficient' });
    });

    it('AC-15: a 500 with a body is a provider_error and carries no GitLab body', async () => {
      respond = () => ({ status: 500, body: { message: 'gitlab-internal-detail', trace: 'x' } });

      const error = await checker.getMergeRequest(access, 4).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RepoCheckException);
      const failure = error as RepoCheckException;
      expect(failure.reason).toBe('provider_error');
      expect(failure.args).toEqual({ reason: 'provider_error' });
      expect(JSON.stringify(failure.getResponse())).not.toContain('gitlab-internal-detail');
    });
  });

  describe('the host check', () => {
    it('AC-8: a blocked host sends no request at all', async () => {
      lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

      const calls: Array<Promise<unknown>> = [
        checker.getMergeRequest(access, 4),
        checker.commentOnMergeRequest(access, 4, 'body'),
        checker.getBranchHead(access, 'main'),
        checker.listTree(access, '.nax', 'c1'),
        checker.getFile(access, '.nax/context.md', 'c1'),
        checker.getTokenSelf(API_BASE, 'glpat'),
        checker.getCurrentUser(API_BASE, 'glpat'),
        checker.findProject(API_BASE, 'glpat', 'grp/sub/app'),
      ];

      for (const call of calls) await expect(call).rejects.toMatchObject({ reason: 'gitlab_host_blocked' });
      expect(sent).toEqual([]);
    });

    it('AC-8: checks the host again before the next page of a tree', async () => {
      const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, path: `.nax/r${i}.md`, type: 'blob' }));
      respond = () => ({ status: 200, body: fullPage });
      // The host resolves to a blocked address after the first page was answered.
      http.request.mockImplementationOnce(async (method: string, url: string, headers: Record<string, string>, body?: unknown) => {
        const request = { method, url, headers, body };
        sent.push(request);
        lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
        return { status: 200, body: fullPage };
      });

      await expect(checker.listTree(access, '.nax', 'c1')).rejects.toMatchObject({ reason: 'gitlab_host_blocked' });
      expect(sent).toHaveLength(1);
    });
  });

  describe('getBranchPushState (US-001)', () => {
    it('AC-1: reads protected and can_push for the branch with the access token', async () => {
      respond = () => ({ status: 200, body: { protected: true, can_push: false } });
      await expect(checker.getBranchPushState(access, 'main')).resolves.toEqual({ protected: true, canPush: false });
      expect(lastRequest()).toEqual(expect.objectContaining({
        method: 'GET', url: `${API_BASE}/projects/${PROJECT_ID}/repository/branches/main`,
        headers: { 'private-token': 'glpat' },
      }));
    });

    it('AC-2: URL-encodes branch names', async () => {
      respond = () => ({ status: 200, body: { protected: false, can_push: true } });
      await checker.getBranchPushState(access, 'release/1.0');
      expect(lastRequest().url).toBe(`${API_BASE}/projects/${PROJECT_ID}/repository/branches/release%2F1.0`);
    });

    it.each([
      [404, 'repo_not_found'],
      [401, 'gitlab_token_invalid'],
      [403, 'app_permissions_insufficient'],
      [500, 'provider_error'],
    ] as const)('AC-3 through AC-6: maps status %i', async (status, reason) => {
      respond = () => ({ status, body: {} });
      await expect(checker.getBranchPushState(access, 'main')).rejects.toMatchObject({ reason });
    });

    it.each([
      [{ protected: true }, 'missing can_push'],
      [{ protected: 'true', can_push: false }, 'non-boolean protected'],
    ])('AC-7: rejects malformed response (%s)', async (body) => {
      respond = () => ({ status: 200, body });
      await expect(checker.getBranchPushState(access, 'main')).rejects.toMatchObject({ reason: 'provider_error' });
    });

    it('AC-8: rejects a blocked host before sending a request', async () => {
      lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
      await expect(checker.getBranchPushState(access, 'main')).rejects.toMatchObject({ reason: 'gitlab_host_blocked' });
      expect(sent).toEqual([]);
    });
  });

  describe('.nax reads (fleet S3 §4.1)', () => {
    it('reads the branch head', async () => {
      respond = () => ({ status: 200, body: { commit: { id: 'c1' } } });
      await expect(checker.getBranchHead(access, 'main')).resolves.toBe('c1');
      expect(lastRequest().url).toBe(`${API_BASE}/projects/${PROJECT_ID}/repository/branches/main`);
      expect(lastRequest().headers['private-token']).toBe('glpat');
    });

    it('refuses a missing branch as repo_not_found', async () => {
      respond = () => ({ status: 404, body: {} });
      await expect(checker.getBranchHead(access, 'main')).rejects.toMatchObject({ reason: 'repo_not_found' });
    });

    it('pages the recursive tree until a short page, and returns [] when the path is missing', async () => {
      const page = (n: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: `s${n}-${i}`, path: `.nax/rules/r${n}-${i}.md`, type: 'blob' }));
      let calls = 0;
      respond = () => {
        calls += 1;
        return { status: 200, body: page(calls, calls === 1 ? 100 : 3) };
      };
      const entries = await checker.listTree(access, '.nax', 'c1');
      expect(entries).toHaveLength(103);
      expect(entries[0]).toEqual({ path: '.nax/rules/r1-0.md', type: 'blob', sha: 's1-0', size: null });
      expect(sent).toHaveLength(2);
      expect(sent[0].url).toContain(`${API_BASE}/projects/${PROJECT_ID}/repository/tree?`);
      respond = () => ({ status: 404, body: { message: '404 Tree Not Found' } });
      await expect(checker.listTree(access, '.nax', 'c1')).resolves.toEqual([]);
    });

    it('stops after 10 full pages', async () => {
      respond = () => ({ status: 200, body: Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, path: `.nax/r${i}.md`, type: 'blob' })) });
      await expect(checker.listTree(access, '.nax', 'c1')).rejects.toMatchObject({ reason: 'provider_error' });
      expect(sent).toHaveLength(10);
    });

    it('reads a file with its blob id; null on 404', async () => {
      respond = () => ({ status: 200, body: { blob_id: 'b9', size: 2, encoding: 'base64', content: Buffer.from('hi').toString('base64') } });
      await expect(checker.getFile(access, '.nax/context.md', 'c1')).resolves.toEqual({ sha: 'b9', size: 2, content: Buffer.from('hi') });
      expect(lastRequest().url).toBe(`${API_BASE}/projects/${PROJECT_ID}/repository/files/${encodeURIComponent('.nax/context.md')}?ref=c1`);
      respond = () => ({ status: 404, body: {} });
      await expect(checker.getFile(access, '.nax/context.md', 'c1')).resolves.toBeNull();
    });
  });

  describe('the token and the project', () => {
    it('AC-10: reads the scopes and the expiry of a token', async () => {
      respond = () => ({ status: 200, body: { scopes: ['read_api', 'write_repository'], expires_at: '2027-01-02T03:04:05Z' } });

      await expect(checker.getTokenSelf(API_BASE, 'glpat')).resolves.toEqual({
        scopes: ['read_api', 'write_repository'],
        expiresAt: new Date('2027-01-02T03:04:05Z'),
      });
      expect(lastRequest().url).toBe(`${API_BASE}/personal_access_tokens/self`);
      expect(lastRequest().headers['private-token']).toBe('glpat');
    });

    it('AC-10: a token without an expiry has none', async () => {
      respond = () => ({ status: 200, body: { scopes: ['read_api'], expires_at: null } });
      await expect(checker.getTokenSelf(API_BASE, 'glpat')).resolves.toEqual({ scopes: ['read_api'], expiresAt: null });
    });

    it('AC-10: a 404 on the token is an invalid token', async () => {
      respond = () => ({ status: 404, body: {} });
      await expect(checker.getTokenSelf(API_BASE, 'glpat')).rejects.toMatchObject({ reason: 'gitlab_token_invalid' });
    });

    it('AC-11: reads the user behind a token', async () => {
      respond = () => ({ status: 200, body: { id: 7, username: 'koda-bot', bot: true } });
      await expect(checker.getCurrentUser(API_BASE, 'glpat')).resolves.toEqual({ id: 7, username: 'koda-bot', bot: true });
      expect(lastRequest().url).toBe(`${API_BASE}/user`);
    });

    it('AC-11: a user without a bot flag is not a bot', async () => {
      respond = () => ({ status: 200, body: { id: 8, username: 'dev' } });
      await expect(checker.getCurrentUser(API_BASE, 'glpat')).resolves.toEqual({ id: 8, username: 'dev', bot: false });
    });

    it('reads a project by its path and by its id', async () => {
      respond = () => ({
        status: 200,
        body: {
          id: 42, path_with_namespace: 'group/sub/app', default_branch: 'main',
          permissions: { project_access: { access_level: 30 }, group_access: null },
        },
      });

      await expect(checker.findProject(API_BASE, 'glpat', 'group/sub/app')).resolves.toEqual({
        id: 42, owner: 'group/sub', name: 'app', defaultBranch: 'main', accessLevel: 30,
      });
      expect(lastRequest().url).toBe(`${API_BASE}/projects/${encodeURIComponent('group/sub/app')}`);
    });

    it('uses the higher of the project and the group access', async () => {
      respond = () => ({
        status: 200,
        body: {
          id: 42, path_with_namespace: 'group/sub/app', default_branch: 'main',
          permissions: { project_access: { access_level: 10 }, group_access: { access_level: 40 } },
        },
      });
      await expect(checker.findProject(API_BASE, 'glpat', 42)).resolves.toEqual(expect.objectContaining({ accessLevel: 40 }));
      expect(lastRequest().url).toBe(`${API_BASE}/projects/42`);
    });

    it('refuses a missing project as repo_not_found', async () => {
      respond = () => ({ status: 404, body: {} });
      await expect(checker.findProject(API_BASE, 'glpat', 'group/sub/app')).rejects.toMatchObject({ reason: 'repo_not_found' });
    });
  });

  describe('commentOnMergeRequest', () => {
    it('posts the note on the merge request of the project', async () => {
      respond = () => ({ status: 201, body: { id: 1 } });
      await expect(checker.commentOnMergeRequest(access, 7, 'hello')).resolves.toBe(true);
      expect(lastRequest().method).toBe('POST');
      expect(lastRequest().url).toBe(`${API_BASE}/projects/${PROJECT_ID}/merge_requests/7/notes`);
      expect(lastRequest().headers['private-token']).toBe('glpat');
      expect(lastRequest().body).toEqual({ body: 'hello' });
    });

    it('answers false when the merge request is gone', async () => {
      respond = () => ({ status: 404, body: {} });
      await expect(checker.commentOnMergeRequest(access, 7, 'hello')).resolves.toBe(false);
    });
  });
});
