import type { GitHubAppClient, PutFileResult } from '../git-broker/github-app-client';
import type { GitLabAccess } from '../git-broker/gitlab-repo-credentials';
import type { GitLabTokenKind } from '../git-broker/prisma-gitlab-credential.repository';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import type { FleetReposService } from '../repos/fleet-repos.service';
import type { FleetFlowFeatureRecord, FleetFlowRecord } from './domain/fleet-flow.domain';
import { buildFlowCalls } from './flow-calls';
import type { ApplyCallsAction } from './flow-step-decision';
import { FleetFlowCallsService } from './fleet-flow-calls.service';

const NOW = new Date('2026-11-17T12:30:00.000Z');
const SPEC_PATH = '.nax/features/app/spec.md';
const BRANCH = 'feat/app';
/** The head the review saw; the tests move it to model a push between the review and the calls. */
const EXPECTED_HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const HEAD = 'h0'.repeat(20);
const COMMIT_SHA = 'c'.repeat(40);
const SPEC = '# Spec\n\nSome text\n';
/** GitLab's file lock: the commit that last touched the file. */
const LAST_COMMIT_ID = 'lc1';
const MOVED_LAST_COMMIT_ID = 'lc2';
const ACCESS: GitLabAccess = { token: 'access-token', target: { apiBase: 'https://gitlab.com/api/v4', projectId: 7 } };
/** The explicit target of a calls write: the feature, its spec path and the branch it lives on. */
const TARGET = { feature: 'app', specPath: SPEC_PATH, branch: BRANCH };

const feature = (over: Partial<FleetFlowFeatureRecord> = {}): FleetFlowFeatureRecord => ({
  id: 'feature-1', flowId: 'flow-1', position: 0, feature: 'app', specPath: SPEC_PATH,
  dependsOn: [], state: 'RUNNING', currentStep: 'SPEC_REVIEW', prNumber: null, ...over,
});

const flow = (over: Partial<FleetFlowRecord> = {}): FleetFlowRecord => ({
  id: 'flow-1', projectId: 'p1', repoId: 'repo-1', threadId: null, entry: 'NAX',
  createdByType: 'USER', createdById: 'u1', branch: BRANCH, specSha: EXPECTED_HEAD,
  pinnedRunnerId: null, reviewerRole: 'opus', supervisorRole: 'haiku', costCapUsd: '10.0000',
  spentUsd: '0.0000', state: 'RUNNING', approvalMode: 'PRE_APPROVED', approverId: 'u1',
  approvedAt: NOW, approvalRequestId: null, stopReason: null, stopDetail: null,
  endedAt: null, createdAt: NOW, updatedAt: NOW, features: [feature()], ...over,
});

const action = (over: Partial<ApplyCallsAction> = {}): ApplyCallsAction => ({
  kind: 'apply_calls', step: 'SPEC_REVIEW', jobId: 'j1',
  findings: [{ id: 'F1', class: 'minor', summary: 'Missing AC', fix: 'add it' }], ...over,
});

/** A GitLab file read: its bytes and the lock a commit needs. */
const file = (text: string = SPEC, lastCommitId: string = LAST_COMMIT_ID) => ({
  sha: `sha-${lastCommitId}`, size: Buffer.byteLength(text),
  content: Buffer.from(text, 'utf8'), lastCommitId,
});

interface HarnessOptions {
  /** The row `findReviewRepo` answers; null models a repo that is gone. */
  repoMissing?: boolean;
  /** The installation id the repo row carries; a GitLab row normally holds none. */
  installationId?: bigint | null;
  /** The branch head the forge answers. */
  head?: string;
  /** What each successive `getFileForUpdate` answers (the last entry repeats once the queue is empty). */
  files?: (ReturnType<typeof file> | null)[];
  /** What `getFile` answers (the base read of the already-applied path). */
  baseFiles?: (ReturnType<typeof file> | null)[];
  singleFileCommit?: boolean;
  ownRun?: boolean;
  /** What `commitFile` answers. */
  commit?: PutFileResult;
  /** The reason the credential call refuses with, before the request is made. */
  credentialsError?: string;
}

function build(options: HarnessOptions = {}) {
  const queue = [...(options.files ?? [file()])];
  const nextFile = () => (queue.length > 1 ? queue.shift() ?? null : queue[0] ?? null);
  const baseQueue = [...(options.baseFiles ?? [file()])];
  const nextBase = () => (baseQueue.length > 1 ? baseQueue.shift() ?? null : baseQueue[0] ?? null);

  const repo = {
    id: 'repo-1', projectId: 'p1', owner: 'grp', name: 'app', host: 'https://gitlab.com',
    provider: 'gitlab', defaultBranch: 'main',
    githubInstallationId: options.installationId === undefined ? null : options.installationId,
  };
  const repos = {
    findReviewRepo: vi.fn<FleetReposService['findReviewRepo']>(async () => (options.repoMissing ? null : repo)),
  };
  /** The token kind of every credential call, in order: one call per client method call. */
  const kinds: GitLabTokenKind[] = [];
  const gitlabCredentials = {
    call: vi.fn(async (_repo: unknown, kind: GitLabTokenKind, fn: (access: GitLabAccess) => Promise<unknown>) => {
      kinds.push(kind);
      if (options.credentialsError) throw new RepoCheckException(options.credentialsError as never);
      return fn(ACCESS);
    }),
  };
  const gitlab = {
    getBranchHead: vi.fn(async () => options.head ?? EXPECTED_HEAD),
    getFile: vi.fn(async () => nextBase()),
    getFileForUpdate: vi.fn(async () => nextFile()),
    isSingleFileCommit: vi.fn(async () => options.singleFileCommit ?? false),
    isOwnCallsRun: vi.fn(async () => options.ownRun ?? false),
    commitFile: vi.fn(async () => options.commit ?? { kind: 'committed', commitSha: COMMIT_SHA }),
  };
  const github = {
    mintInstallationToken: vi.fn<GitHubAppClient['mintInstallationToken']>(async () => ({ token: 'github-token', expiresAt: NOW })),
    getBranchHead: vi.fn(async () => EXPECTED_HEAD),
    getFile: vi.fn(async () => null),
    putFile: vi.fn(async () => ({ kind: 'committed', commitSha: COMMIT_SHA })),
  };
  const service = new FleetFlowCallsService(repos as never, github as never, gitlabCredentials as never, gitlab as never);
  return { service, repos, repo, gitlab, gitlabCredentials, github, kinds };
}

describe('FleetFlowCallsService.apply on a GitLab repo', () => {
  it('AC-1: reads the branch head and the spec at that head through read credentials', async () => {
    const h = build({ head: HEAD });

    await h.service.apply(flow(), action(), HEAD, TARGET);

    expect(h.gitlab.getBranchHead).toHaveBeenCalledWith(ACCESS, BRANCH);
    expect(h.gitlab.getFileForUpdate).toHaveBeenCalledWith(ACCESS, SPEC_PATH, HEAD);
    expect(h.gitlabCredentials.call).toHaveBeenCalledWith(h.repo, 'read', expect.any(Function));
    // The head read and the spec read are two separate read calls; the write that follows has its own.
    expect(h.kinds.slice(0, 2)).toEqual(['read', 'read']);
  });

  it('AC-2: commits the built calls with the file lock and the flow message', async () => {
    const h = build({ head: HEAD, commit: { kind: 'committed', commitSha: COMMIT_SHA } });

    await expect(h.service.apply(flow(), action(), HEAD, TARGET)).resolves.toEqual({
      kind: 'committed', specSha: COMMIT_SHA,
    });
    expect(h.gitlab.commitFile).toHaveBeenCalledWith(ACCESS, SPEC_PATH, {
      branch: BRANCH,
      content: Buffer.from(buildFlowCalls(SPEC, action()).text, 'utf8'),
      lastCommitId: LAST_COMMIT_ID,
      message: 'docs(app): flow calls from SPEC_REVIEW job j1',
    });
    expect(h.gitlabCredentials.call).toHaveBeenCalledWith(h.repo, 'write', expect.any(Function));
    expect(h.kinds).toEqual(['read', 'read', 'write']);
  });

  it('AC-3: a head that moved without the calls is stale and writes nothing', async () => {
    const h = build({ head: OTHER_HEAD });

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD, TARGET)).resolves.toEqual({
      kind: 'stale', head: OTHER_HEAD,
    });
    expect(h.gitlab.commitFile).not.toHaveBeenCalled();
  });

  it('AC-4: a conflict whose re-read finds the same lock is a refusal', async () => {
    const h = build({ files: [file(), file()], commit: { kind: 'conflict' } });

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD, TARGET)).resolves.toEqual({
      kind: 'failed', detail: 'spec write refused',
    });
    expect(h.gitlab.getFileForUpdate).toHaveBeenCalledWith(ACCESS, SPEC_PATH, BRANCH);
    expect(h.kinds).toEqual(['read', 'read', 'write', 'read']);
  });

  it('AC-5: a conflict whose re-read finds a moved lock retries', async () => {
    const h = build({ files: [file(), file(SPEC, MOVED_LAST_COMMIT_ID)], commit: { kind: 'conflict' } });

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD, TARGET)).resolves.toEqual({ kind: 'retry' });
  });

  it('AC-5: a conflict whose re-read finds no file retries', async () => {
    const h = build({ files: [file(), null], commit: { kind: 'conflict' } });

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD, TARGET)).resolves.toEqual({ kind: 'retry' });
  });

  it('AC-6: recovers the exact calls commit at the head without writing twice', async () => {
    const applied = buildFlowCalls(SPEC, action()).text;
    const h = build({ files: [file(applied)], baseFiles: [file(SPEC)], head: OTHER_HEAD, singleFileCommit: true });

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD, TARGET)).resolves.toEqual({
      kind: 'committed', specSha: OTHER_HEAD,
    });
    expect(h.gitlab.getFile).toHaveBeenCalledWith(ACCESS, SPEC_PATH, EXPECTED_HEAD);
    expect(h.gitlab.isSingleFileCommit).toHaveBeenCalledWith(ACCESS, EXPECTED_HEAD, OTHER_HEAD, SPEC_PATH);
    expect(h.gitlab.commitFile).not.toHaveBeenCalled();
    // Every read of the recovery path runs on the read token.
    expect(h.kinds).toEqual(['read', 'read', 'read', 'read']);
  });

  it('AC-7: a head whose bytes differ from the calls built on the base is stale', async () => {
    const rewritten = buildFlowCalls('# External rewrite\n', action()).text;
    const h = build({ files: [file(rewritten)], baseFiles: [file(SPEC)], head: OTHER_HEAD, singleFileCommit: true });

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD, TARGET)).resolves.toEqual({
      kind: 'stale', head: OTHER_HEAD,
    });
    expect(h.gitlab.commitFile).not.toHaveBeenCalled();
  });

  describe('replay of the set pass own earlier commits', () => {
    const replay = { reviewedHead: EXPECTED_HEAD, paths: [SPEC_PATH, '.nax/features/next/spec.md'] };
    const target = { ...TARGET, replay };
    const applied = () => file(buildFlowCalls(SPEC, action()).text);

    it('AC-8: accepts a run of this job own commits after the reviewed head', async () => {
      const h = build({ files: [applied()], baseFiles: [file(SPEC)], head: OTHER_HEAD, singleFileCommit: false, ownRun: true });

      await expect(h.service.apply(flow(), action(), OTHER_HEAD, target)).resolves.toEqual({
        kind: 'committed', specSha: OTHER_HEAD,
      });
      expect(h.gitlab.getFile).toHaveBeenCalledWith(ACCESS, SPEC_PATH, EXPECTED_HEAD);
      expect(h.gitlab.isOwnCallsRun).toHaveBeenCalledWith(ACCESS, EXPECTED_HEAD, OTHER_HEAD, {
        paths: replay.paths, marker: 'flow calls from SPEC_REVIEW job j1',
      });
      expect(h.gitlab.commitFile).not.toHaveBeenCalled();
      // The head read, the spec read, the base read and both proofs run on the read token.
      expect(h.kinds).toEqual(['read', 'read', 'read', 'read', 'read']);
    });

    it('AC-9: re-asks when the commits after the reviewed head are not this job own', async () => {
      const h = build({ files: [applied()], baseFiles: [file(SPEC)], head: OTHER_HEAD, singleFileCommit: false, ownRun: false });

      await expect(h.service.apply(flow(), action(), OTHER_HEAD, target)).resolves.toEqual({
        kind: 'stale', head: OTHER_HEAD,
      });
      expect(h.gitlab.commitFile).not.toHaveBeenCalled();
    });
  });

  it('AC-10: missing GitLab credentials fail with that reason', async () => {
    const h = build({ credentialsError: 'gitlab_credentials_missing' });

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD, TARGET)).resolves.toEqual({
      kind: 'failed', detail: 'gitlab_credentials_missing',
    });
    expect(h.gitlab.commitFile).not.toHaveBeenCalled();
  });

  it('AC-11: a blocked GitLab host retries', async () => {
    const h = build();
    h.gitlab.getBranchHead.mockRejectedValue(new RepoCheckException('gitlab_host_blocked'));

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD, TARGET)).resolves.toEqual({ kind: 'retry' });
  });

  it('AC-12: a GitLab row with an installation id never mints a GitHub token', async () => {
    const h = build({ installationId: 9n });

    await h.service.apply(flow(), action(), EXPECTED_HEAD, TARGET);

    expect(h.github.mintInstallationToken).not.toHaveBeenCalled();
    expect(h.github.getBranchHead).not.toHaveBeenCalled();
    expect(h.github.getFile).not.toHaveBeenCalled();
    expect(h.github.putFile).not.toHaveBeenCalled();
    expect(h.gitlab.getBranchHead).toHaveBeenCalledWith(ACCESS, BRANCH);
  });

  it('AC-13: an invalid GitLab token fails with that reason', async () => {
    const h = build({ credentialsError: 'gitlab_token_invalid' });

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD, TARGET)).resolves.toEqual({
      kind: 'failed', detail: 'gitlab_token_invalid',
    });
  });

  it.each(['gitlab_host_invalid', 'gitlab_host_unclassified', 'vcs_encryption_key_missing', 'provider_error'] as const)(
    'AC-14: %s retries',
    async (reason) => {
      const h = build();
      h.gitlab.getBranchHead.mockRejectedValue(new RepoCheckException(reason));

      await expect(h.service.apply(flow(), action(), EXPECTED_HEAD, TARGET)).resolves.toEqual({ kind: 'retry' });
    },
  );

  it('AC-14: a retry reason on the conflict re-read retries', async () => {
    const h = build({ commit: { kind: 'conflict' } });
    h.gitlab.getFileForUpdate
      .mockResolvedValueOnce(file())
      .mockRejectedValueOnce(new RepoCheckException('provider_error'));

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD, TARGET)).resolves.toEqual({ kind: 'retry' });
  });

  it('a refused GitLab commit (a push rule or a protected branch) fails the pass', async () => {
    const h = build();
    h.gitlab.commitFile.mockRejectedValue(new RepoCheckException('app_permissions_insufficient'));

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD, TARGET)).resolves.toEqual({
      kind: 'failed', detail: 'app_permissions_insufficient',
    });
  });

  it('a non-forge error from the write propagates', async () => {
    const h = build();
    h.gitlab.commitFile.mockRejectedValue(new Error('bug'));

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD, TARGET)).rejects.toThrow('bug');
  });

  it('a missing spec on the branch fails with the branch name', async () => {
    const h = build({ files: [null] });

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD, TARGET)).resolves.toEqual({
      kind: 'failed', detail: `spec missing on ${BRANCH}`,
    });
    expect(h.gitlab.commitFile).not.toHaveBeenCalled();
  });

  it('a flow without a feature fails without touching the forge', async () => {
    const h = build();

    await expect(h.service.apply(flow({ features: [] }), action(), EXPECTED_HEAD, TARGET)).resolves.toEqual({
      kind: 'failed', detail: 'feature missing',
    });
    expect(h.gitlabCredentials.call).not.toHaveBeenCalled();
  });

  it('a repo that is gone fails as not connected', async () => {
    const h = build({ repoMissing: true });

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD, TARGET)).resolves.toEqual({
      kind: 'failed', detail: 'repo not connected',
    });
    expect(h.gitlabCredentials.call).not.toHaveBeenCalled();
  });
});
