import type { Mock } from 'vitest';
import { GitLabAccessChecker } from './gitlab-access-checker';
import type { GitLabAccess } from './gitlab-repo-credentials';

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock('node:dns', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:dns')>();
  return { ...original, promises: { ...original.promises, lookup: lookupMock } };
});

const API = 'https://gitlab.example.com/api/v4';
const access: GitLabAccess = { token: 'glpat', target: { apiBase: API, projectId: 42 } };
interface Sent { method: string; url: string; headers: Record<string, string>; body?: unknown }
describe('GitLabAccessChecker flow writes', () => {
  let sent: Sent[];
  let answer: (request: Sent) => { status: number; body?: unknown };
  let http: { request: Mock };
  let checker: GitLabAccessChecker;
  beforeEach(() => {
    sent = [];
    answer = () => ({ status: 200, body: {} });
    http = { request: vi.fn(async (method: string, url: string, headers: Record<string, string>, body?: unknown) => {
      const request = { method, url, headers, body };
      sent.push(request);
      return answer(request);
    }) };
    checker = new GitLabAccessChecker(http as never);
    lookupMock.mockReset().mockResolvedValue([{ address: '192.168.1.20', family: 4 }]);
  });

  it('AC-1: createBranch posts encoded branch/ref with the private token', async () => {
    answer = () => ({ status: 201 });
    await checker.createBranch(access, 'feat/a', 'abc');
    expect(sent).toEqual([{ method: 'POST', url: `${API}/projects/42/repository/branches?branch=feat%2Fa&ref=abc`, headers: { 'private-token': 'glpat' }, body: undefined }]);
  });
  it('AC-2: returns created for 201', async () => {
    answer = () => ({ status: 201 });
    await expect(checker.createBranch(access, 'feat/a', 'abc')).resolves.toEqual({ kind: 'created' });
  });
  it('AC-3: detects an existing branch after 400', async () => {
    answer = (r) => r.method === 'POST' ? { status: 400 } : { status: 200, body: { commit: { id: 'def' } } };
    await expect(checker.createBranch(access, 'feat/a', 'abc')).resolves.toEqual({ kind: 'exists', sha: 'def' });
    expect(sent[1].url).toBe(`${API}/projects/42/repository/branches/feat%2Fa`);
  });
  it('AC-4: refuses when the follow-up branch is missing', async () => {
    answer = (r) => ({ status: r.method === 'POST' ? 400 : 404 });
    await expect(checker.createBranch(access, 'feat/a', 'abc')).resolves.toEqual({ kind: 'refused' });
  });
  it('AC-5: checks host again and sends no follow-up request when blocked', async () => {
    answer = () => ({ status: 400 });
    lookupMock.mockResolvedValueOnce([{ address: '192.168.1.20', family: 4 }]).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    await expect(checker.createBranch(access, 'feat/a', 'abc')).rejects.toMatchObject({ reason: 'gitlab_host_blocked' });
    expect(sent).toHaveLength(1);
  });
  it('AC-6: reads file content and its last commit id', async () => {
    answer = () => ({ status: 200, body: { blob_id: 'b9', size: 2, encoding: 'base64', content: 'aGk=', last_commit_id: 'lc1' } });
    await expect(checker.getFileForUpdate(access, 'docs/a.md', 'c1')).resolves.toEqual({ sha: 'b9', size: 2, content: Buffer.from('hi'), lastCommitId: 'lc1' });
  });
  it('AC-7: returns null for missing file', async () => {
    answer = () => ({ status: 404 });
    await expect(checker.getFileForUpdate(access, 'docs/a.md', 'c1')).resolves.toBeNull();
  });
  it('AC-8: rejects file without last_commit_id', async () => {
    answer = () => ({ status: 200, body: { blob_id: 'b9', size: 2, encoding: 'base64', content: 'aGk=' } });
    await expect(checker.getFileForUpdate(access, 'docs/a.md', 'c1')).rejects.toMatchObject({ reason: 'provider_error' });
  });
  it('AC-9: posts a commit action with base64 content and lock id', async () => {
    answer = () => ({ status: 201, body: { id: 'n1' } });
    await checker.commitFile(access, 'docs/a.md', { branch: 'feat/a', content: Buffer.from('hi'), lastCommitId: 'lc1', message: 'm' });
    expect(sent[0]).toEqual({ method: 'POST', url: `${API}/projects/42/repository/commits`, headers: { 'private-token': 'glpat' }, body: { branch: 'feat/a', commit_message: 'm', actions: [{ action: 'update', file_path: 'docs/a.md', content: 'aGk=', encoding: 'base64', last_commit_id: 'lc1' }] } });
  });
  it('AC-10: returns committed with the new commit id', async () => {
    answer = () => ({ status: 201, body: { id: 'n1' } });
    await expect(checker.commitFile(access, 'docs/a.md', { branch: 'feat/a', content: Buffer.from('hi'), lastCommitId: 'lc1', message: 'm' })).resolves.toEqual({ kind: 'committed', commitSha: 'n1' });
  });
  it.each([400, 409])('AC-11/12: treats HTTP %i as a conflict', async (status) => {
    answer = () => ({ status });
    await expect(checker.commitFile(access, 'docs/a.md', { branch: 'feat/a', content: Buffer.from('hi'), lastCommitId: 'lc1', message: 'm' })).resolves.toEqual({ kind: 'conflict' });
  });
  it('AC-13: maps 403 to app_permissions_insufficient', async () => {
    answer = () => ({ status: 403 });
    await expect(checker.commitFile(access, 'docs/a.md', { branch: 'feat/a', content: Buffer.from('hi'), lastCommitId: 'lc1', message: 'm' })).rejects.toMatchObject({ reason: 'app_permissions_insufficient' });
  });
  it('AC-14: rejects a malformed successful commit response', async () => {
    answer = () => ({ status: 201, body: { id: 7 } });
    await expect(checker.commitFile(access, 'docs/a.md', { branch: 'feat/a', content: Buffer.from('hi'), lastCommitId: 'lc1', message: 'm' })).rejects.toMatchObject({ reason: 'provider_error' });
  });
  it('maps 401, 403 and 500 for each call', async () => {
    const inputs = { branch: 'feat/a', content: Buffer.from('hi'), lastCommitId: 'lc1', message: 'm' };
    const calls = [() => checker.createBranch(access, 'feat/a', 'abc'), () => checker.getFileForUpdate(access, 'docs/a.md', 'c1'), () => checker.commitFile(access, 'docs/a.md', inputs)];
    for (const invoke of calls) for (const [status, reason] of [[401, 'gitlab_token_invalid'], [403, 'app_permissions_insufficient'], [500, 'provider_error']] as const) {
      answer = () => ({ status });
      await expect(invoke()).rejects.toMatchObject({ reason });
    }
  });
  it('blocks loopback hosts before each call', async () => {
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const calls = [() => checker.createBranch(access, 'feat/a', 'abc'), () => checker.getFileForUpdate(access, 'docs/a.md', 'c1'), () => checker.commitFile(access, 'docs/a.md', { branch: 'feat/a', content: Buffer.from('hi'), lastCommitId: 'lc1', message: 'm' })];
    for (const invoke of calls) await expect(invoke()).rejects.toMatchObject({ reason: 'gitlab_host_blocked' });
    expect(sent).toEqual([]);
  });
});
