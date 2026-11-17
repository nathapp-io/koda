import type { Mock } from 'vitest';
import { GitLabAccessChecker } from './gitlab-access-checker';
import type { GitLabAccess } from './gitlab-repo-credentials';

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock('node:dns', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:dns')>();
  return { ...original, promises: { ...original.promises, lookup: lookupMock } };
});

const API_BASE = 'https://gitlab.example.com/api/v4';
const access: GitLabAccess = { token: 'glpat', target: { apiBase: API_BASE, projectId: 42 } };
const PROJECT = `${API_BASE}/projects/42`;
const MARKER = 'flow calls from SPEC_REVIEW job j1';
const own = { paths: ['a.md', 'b.md'], marker: MARKER };
type Request = { method: string; url: string; headers: Record<string, string> };

describe('GitLabAccessChecker compare checks', () => {
  let sent: Request[];
  let reply: (request: Request) => { status: number; body?: unknown };
  let http: { request: Mock };
  let checker: GitLabAccessChecker;

  beforeEach(() => {
    sent = [];
    reply = () => ({ status: 200, body: {} });
    http = { request: vi.fn(async (method: string, url: string, headers: Record<string, string>) => {
      const request = { method, url, headers };
      sent.push(request);
      return reply(request);
    }) };
    checker = new GitLabAccessChecker(http as never);
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: '192.168.1.20', family: 4 }]);
  });

  const compare = (commits: unknown[], diffs: unknown[], extra: Record<string, unknown> = {}) => ({ commits, diffs, ...extra });
  const diff = (oldPath: string, newPath = oldPath, flags: Record<string, boolean> = {}) => ({
    old_path: oldPath, new_path: newPath, new_file: false, deleted_file: false, renamed_file: false, ...flags,
  });
  const commit = (id: string, parentIds: string[], message = MARKER) => ({
    id, parent_ids: parentIds, message,
  });
  const compareUrl = `${PROJECT}/repository/compare?from=b0&to=h1&straight=false`;
  const configureSingle = (diffs: unknown[] = [diff('docs/a.md')], parentIds = ['b0']) => {
    reply = (request) => request.url === compareUrl
      ? { status: 200, body: compare([{ id: 'h1' }], diffs) }
      : { status: 200, body: commit('h1', parentIds) };
  };
  const configureOwn = (options: { h2Message?: string; diffs?: unknown[]; h2Parents?: string[]; commits?: unknown[] } = {}) => {
    const compareUrlOwn = `${PROJECT}/repository/compare?from=b0&to=h2&straight=false`;
    reply = (request) => {
      if (request.url === compareUrlOwn) return { status: 200, body: compare(options.commits ?? [{ id: 'h1' }, { id: 'h2' }], options.diffs ?? [diff('a.md'), diff('b.md')]) };
      if (request.url.endsWith('/h1')) return { status: 200, body: commit('h1', ['b0']) };
      if (request.url.endsWith('/h2')) return { status: 200, body: commit('h2', options.h2Parents ?? ['h1'], options.h2Message ?? MARKER) };
      return { status: 200, body: {} };
    };
  };

  it('AC-1: reads compare and commit details with private-token and proves one direct single-file commit', async () => {
    configureSingle();
    await expect(checker.isSingleFileCommit(access, 'b0', 'h1', 'docs/a.md')).resolves.toBe(true);
    expect(sent.map(({ method, url }) => [method, url])).toEqual([
      ['GET', `${PROJECT}/repository/compare?from=b0&to=h1&straight=false`],
      ['GET', `${PROJECT}/repository/commits/h1`],
    ]);
    expect(sent.every((request) => request.headers['private-token'] === access.token)).toBe(true);
  });

  it('AC-2: rejects a commit whose parent is not the base', async () => {
    configureSingle([diff('docs/a.md')], ['x9']);
    await expect(checker.isSingleFileCommit(access, 'b0', 'h1', 'docs/a.md')).resolves.toBe(false);
  });

  it('AC-3: rejects a compare with an additional diff', async () => {
    configureSingle([diff('docs/a.md'), diff('other.md')]);
    await expect(checker.isSingleFileCommit(access, 'b0', 'h1', 'docs/a.md')).resolves.toBe(false);
  });

  it('AC-4: rejects a different new path', async () => {
    configureSingle([diff('docs/a.md', 'docs/b.md')]);
    await expect(checker.isSingleFileCommit(access, 'b0', 'h1', 'docs/a.md')).resolves.toBe(false);
  });

  it('AC-5: rejects renamed files', async () => {
    configureSingle([diff('docs/a.md', 'docs/a.md', { renamed_file: true })]);
    await expect(checker.isSingleFileCommit(access, 'b0', 'h1', 'docs/a.md')).resolves.toBe(false);
  });

  it('AC-6: returns false for compare_timeout without reading a commit', async () => {
    reply = () => ({ status: 200, body: compare([{ id: 'h1' }], [diff('docs/a.md')], { compare_timeout: true }) });
    await expect(checker.isSingleFileCommit(access, 'b0', 'h1', 'docs/a.md')).resolves.toBe(false);
    expect(sent).toHaveLength(1);
  });

  it('AC-7: proves all own commits form a marked linear run with allowed diffs', async () => {
    configureOwn();
    await expect(checker.isOwnCallsRun(access, 'b0', 'h2', own)).resolves.toBe(true);
  });

  it('AC-8: rejects a commit message without the marker', async () => {
    configureOwn({ h2Message: 'unrelated change' });
    await expect(checker.isOwnCallsRun(access, 'b0', 'h2', own)).resolves.toBe(false);
  });

  it('AC-9: rejects a diff outside own.paths', async () => {
    configureOwn({ diffs: [diff('a.md'), diff('c.md')] });
    await expect(checker.isOwnCallsRun(access, 'b0', 'h2', own)).resolves.toBe(false);
  });

  it('AC-10: rejects a newly created file', async () => {
    configureOwn({ diffs: [diff('a.md', 'a.md', { new_file: true }), diff('b.md')] });
    await expect(checker.isOwnCallsRun(access, 'b0', 'h2', own)).resolves.toBe(false);
  });

  it('AC-11: rejects a merge commit', async () => {
    configureOwn({ h2Parents: ['h1', 'x9'] });
    await expect(checker.isOwnCallsRun(access, 'b0', 'h2', own)).resolves.toBe(false);
  });

  it('AC-12: rejects listed commits not on the head-to-base chain', async () => {
    configureOwn({ commits: [{ id: 'h1' }, { id: 'h2' }, { id: 'h3' }] });
    await expect(checker.isOwnCallsRun(access, 'b0', 'h2', own)).resolves.toBe(false);
  });

  it('AC-13: caps commit reads at 50 and treats a missing commit as unproven', async () => {
    const commits = Array.from({ length: 51 }, (_, index) => ({ id: `h${index}` }));
    reply = () => ({ status: 200, body: compare(commits, [diff('a.md')]) });
    await expect(checker.isOwnCallsRun(access, 'b0', 'h50', own)).resolves.toBe(false);
    expect(sent).toHaveLength(1);

    configureOwn();
    reply = (request) => request.url.includes('/repository/compare?')
      ? { status: 200, body: compare([{ id: 'h1' }, { id: 'h2' }], [diff('a.md'), diff('b.md')]) }
      : request.url.endsWith('/h1') ? { status: 404, body: {} } : { status: 200, body: commit('h2', ['h1']) };
    sent = [];
    await expect(checker.isOwnCallsRun(access, 'b0', 'h2', own)).resolves.toBe(false);
    expect(sent.map((request) => request.url)).toEqual([
      `${PROJECT}/repository/compare?from=b0&to=h2&straight=false`, `${PROJECT}/repository/commits/h1`,
    ]);
  });

  it('AC-14: checks host before each commit read and sends no request after a refusal', async () => {
    configureOwn();
    lookupMock.mockResolvedValueOnce([{ address: '192.168.1.20', family: 4 }])
      .mockResolvedValueOnce([{ address: '192.168.1.20', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    await expect(checker.isOwnCallsRun(access, 'b0', 'h2', own)).rejects.toMatchObject({ reason: 'gitlab_host_blocked' });
    expect(sent).toHaveLength(2);
    expect(sent.map((request) => request.url)).toEqual([
      `${PROJECT}/repository/compare?from=b0&to=h2&straight=false`,
      `${PROJECT}/repository/commits/h1`,
    ]);
  });
});
