import { Logger } from '@nestjs/common';
import type { OpenPullRequest } from '../git-broker/github-app-client';
import type { FleetRepoRecord } from '../repos/domain/fleet-repo.domain';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { FleetPrReviewPass } from './fleet-pr-review.pass';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const repo = (id: string, over: Partial<FleetRepoRecord> = {}): FleetRepoRecord => ({
  id, projectId: 'p1', provider: 'gitlab', owner: 'grp', name: 'app', host: 'https://gitlab.example.com', defaultBranch: 'main',
  githubInstallationId: null, createdById: 'creator', createdAt: NOW, autoReview: true, autoReviewProfiles: [], autoReviewMaxCostUsd: '1.0000',
  autoReviewEnabledById: 'u1', autoReviewEnabledByType: 'USER', autoReviewEnabledAt: NOW, ...over,
});
const MRS: OpenPullRequest[] = [{ number: 7, headSha: 'abc', draft: false, headRepoFullName: 'grp/app', updatedAt: NOW }];

function build(rows: FleetRepoRecord[], callBehavior?: (row: FleetRepoRecord, fn: (access: unknown) => Promise<OpenPullRequest[]>) => Promise<OpenPullRequest[]>) {
  const access = { token: 'read-token', target: { apiBase: 'https://gitlab.example.com/api/v4', projectId: 42 } };
  const credentials = { call: vi.fn(async (row: FleetRepoRecord, _kind: 'read', fn: (a: unknown) => Promise<OpenPullRequest[]>) => callBehavior ? callBehavior(row, fn) : fn(access)) };
  const gitlab = { listOpenMergeRequests: vi.fn(async () => MRS) };
  const github = { mintInstallationToken: vi.fn(), listOpenPullRequests: vi.fn() };
  const dispatcher = { dispatchRepo: vi.fn(async () => 1) };
  const pass = new FleetPrReviewPass({ listAutoReviewRepos: vi.fn(async () => rows) } as never, { check: vi.fn(async () => ({ type: 'USER', id: 'u1' })) } as never, github as never, dispatcher as never, testFleetConfig({ prReviewMaxDispatch: 10 }), credentials as never, gitlab as never);
  return { pass, credentials, gitlab, github, dispatcher, access };
}

describe('FleetPrReviewPass GitLab polling', () => {
  it('AC-12: calls read credentials and dispatches the listed merge requests', async () => {
    const row = repo('gitlab-row');
    const h = build([row]);
    await h.pass.run(NOW);
    expect(h.credentials.call).toHaveBeenCalledWith(row, 'read', expect.any(Function));
    expect(h.gitlab.listOpenMergeRequests).toHaveBeenCalledWith(h.access, 'grp/app');
    expect(h.dispatcher.dispatchRepo).toHaveBeenCalledWith(row, MRS, expect.objectContaining({ now: NOW }));
  });

  it('AC-13: selects GitLab even when the row has a GitHub installation', async () => {
    const h = build([repo('gitlab-row', { githubInstallationId: 9n })]);
    await h.pass.run(NOW);
    expect(h.github.mintInstallationToken).not.toHaveBeenCalled();
    expect(h.github.listOpenPullRequests).not.toHaveBeenCalled();
  });

  it.each(['gitlab_token_invalid', 'gitlab_credentials_missing'] as const)('AC-14/15: warns and continues after %s', async (reason) => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockClear();
    const h = build([repo('first'), repo('second')], async (row, fn) => row.id === 'first' ? Promise.reject(new RepoCheckException(reason)) : fn(h.access));
    await h.pass.run(NOW);
    expect(String(warn.mock.calls[0][0])).toContain(`first: ${reason}`);
    expect(h.dispatcher.dispatchRepo).toHaveBeenCalledTimes(1);
    expect(h.dispatcher.dispatchRepo.mock.calls[0][0]).toMatchObject({ id: 'second' });
  });
});
