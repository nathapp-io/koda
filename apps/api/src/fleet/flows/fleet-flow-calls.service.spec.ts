import type { GitHubAppClient, PutFileResult } from '../git-broker/github-app-client';
import type { ForgeFile } from '../git-broker/forge-tree';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import type { FleetReposService } from '../repos/fleet-repos.service';
import type { FleetFlowFeatureRecord, FleetFlowRecord } from './domain/fleet-flow.domain';
import { buildFlowCalls } from './flow-calls';
import type { ApplyCallsAction } from './flow-step-decision';
import { FleetFlowCallsService } from './fleet-flow-calls.service';

const NOW = new Date('2026-11-07T12:30:00.000Z');
const SPEC_PATH = '.nax/features/f/spec.md';
const BRANCH = 'feat/f';
/** The head the review saw; the tests move it to model a push between the review and the calls. */
const EXPECTED_HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const COMMIT_SHA = 'c'.repeat(40);
const TOKEN = 'test-only-token';
const SPEC = '# Spec\n\nSome text\n';
const APPLIED_SPEC = '# Spec\n\n### SPEC_REVIEW job j1\n';
const BLOB_SHA = 'blob-1';
const MOVED_BLOB_SHA = 'blob-2';

const feature = (over: Partial<FleetFlowFeatureRecord> = {}): FleetFlowFeatureRecord => ({
  id: 'feature-1', flowId: 'flow-1', position: 0, feature: 'f', specPath: SPEC_PATH,
  dependsOn: [], state: 'RUNNING', currentStep: 'SPEC_REVIEW', prNumber: null, ...over,
});

const flow = (over: Partial<FleetFlowRecord> = {}): FleetFlowRecord => ({
  id: 'flow-1', projectId: 'p1', repoId: 'repo-1', threadId: null, entry: 'THREAD',
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

const file = (text: string = SPEC, sha: string = BLOB_SHA): ForgeFile => ({
  sha, size: Buffer.byteLength(text), content: Buffer.from(text, 'utf8'),
});

const reviewRepo = (over: { githubInstallationId?: bigint | null } = {}) => ({
  id: 'repo-1', projectId: 'p1', owner: 'o', name: 'r',
  githubInstallationId: 'githubInstallationId' in over ? over.githubInstallationId ?? null : 1n,
});

interface HarnessOptions {
  /** The row `findReviewRepo` answers; null models a repo that is gone. */
  repo?: ReturnType<typeof reviewRepo> | null;
  /** What each successive `getFile` answers (the last entry repeats once the queue is empty). */
  files?: (ForgeFile | null)[];
  head?: string;
  /** What `putFile` answers, or the error it throws. */
  put?: PutFileResult;
  putError?: Error;
  mintError?: Error;
}

function build(opts: HarnessOptions = {}) {
  const queue = [...(opts.files ?? [file()])];
  const nextFile = (): ForgeFile | null => (queue.length > 1 ? queue.shift() ?? null : queue[0] ?? null);
  const repos = {
    findReviewRepo: vi.fn<FleetReposService['findReviewRepo']>(async () =>
      opts.repo === undefined ? reviewRepo() : opts.repo),
  };
  const github = {
    mintInstallationToken: vi.fn<GitHubAppClient['mintInstallationToken']>(async () => {
      if (opts.mintError) throw opts.mintError;
      return { token: TOKEN, expiresAt: NOW };
    }),
    getFile: vi.fn<GitHubAppClient['getFile']>(async () => nextFile()),
    getBranchHead: vi.fn<GitHubAppClient['getBranchHead']>(async () => opts.head ?? EXPECTED_HEAD),
    putFile: vi.fn<GitHubAppClient['putFile']>(async () => {
      if (opts.putError) throw opts.putError;
      return opts.put ?? { kind: 'committed', commitSha: COMMIT_SHA };
    }),
  };
  const service = new FleetFlowCallsService(repos as never, github as never);
  /** The arguments of the single `putFile` call, or a failure that names the missing call. */
  const putArgs = (): Parameters<GitHubAppClient['putFile']> => {
    expect(github.putFile).toHaveBeenCalledTimes(1);
    return github.putFile.mock.calls[0] as Parameters<GitHubAppClient['putFile']>;
  };
  const reads = (): number => github.getFile.mock.calls.length;
  return { service, repos, github, putArgs, reads };
}

describe('FleetFlowCallsService.apply', () => {
  it('AC-1: reads the spec at the feature specPath on the flow branch with an installation token', async () => {
    const h = build();

    await h.service.apply(flow(), action(), EXPECTED_HEAD);

    expect(h.repos.findReviewRepo).toHaveBeenCalledWith('repo-1');
    expect(h.github.mintInstallationToken).toHaveBeenCalledWith(1n, 'r');
    expect(h.github.getFile).toHaveBeenCalledWith(TOKEN, 'o', 'r', SPEC_PATH, BRANCH);
  });

  it('AC-2: writes the spec path, the flow branch and the read blob sha', async () => {
    const h = build();

    await h.service.apply(flow(), action(), EXPECTED_HEAD);

    const [token, owner, name, path, input] = h.putArgs();
    expect([token, owner, name, path]).toEqual([TOKEN, 'o', 'r', SPEC_PATH]);
    expect(input.branch).toBe(BRANCH);
    expect(input.blobSha).toBe(BLOB_SHA);
  });

  it('AC-3: writes exactly the text buildFlowCalls returns for the read file and the action', async () => {
    const h = build();
    const built = buildFlowCalls(SPEC, action());
    expect(built.alreadyApplied).toBe(false);

    await h.service.apply(flow(), action(), EXPECTED_HEAD);

    const content = h.putArgs()[4].content;
    expect(Buffer.isBuffer(content)).toBe(true);
    expect(content.equals(Buffer.from(built.text, 'utf8'))).toBe(true);
    expect(content.toString('utf8')).toContain("## Flow's calls");
  });

  it('AC-3b: preserves multi-byte spec text through the read and the write', async () => {
    const spec = '# Spec — naïve\n';
    const h = build({ files: [file(spec)] });

    await h.service.apply(flow(), action(), EXPECTED_HEAD);

    expect(h.putArgs()[4].content.toString('utf8')).toBe(buildFlowCalls(spec, action()).text);
  });

  it('AC-4: names the feature, the step and the job in the commit message', async () => {
    const h = build();

    await h.service.apply(flow(), action({ step: 'PRD_REVIEW', jobId: 'j7' }), EXPECTED_HEAD);

    expect(h.putArgs()[4].message).toBe('docs(f): flow calls from PRD_REVIEW job j7');
  });

  it('AC-5: returns the commit sha the contents write produced', async () => {
    const h = build({ put: { kind: 'committed', commitSha: COMMIT_SHA } });

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD)).resolves.toEqual({ kind: 'committed', specSha: COMMIT_SHA });
  });

  it('AC-6: a block already on the branch commits the current head without writing', async () => {
    const h = build({ files: [file(APPLIED_SPEC)], head: OTHER_HEAD });

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD)).resolves.toEqual({ kind: 'committed', specSha: OTHER_HEAD });
    expect(h.github.getBranchHead).toHaveBeenCalledWith(TOKEN, 'o', 'r', BRANCH);
    expect(h.github.putFile).not.toHaveBeenCalled();
  });

  it('AC-7: a repo that is gone fails as not connected', async () => {
    const h = build({ repo: null });

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD)).resolves.toEqual({ kind: 'failed', detail: 'repo not connected' });
    expect(h.github.mintInstallationToken).not.toHaveBeenCalled();
  });

  it('AC-8: a repo without an installation fails as not connected', async () => {
    const h = build({ repo: reviewRepo({ githubInstallationId: null }) });

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD)).resolves.toEqual({ kind: 'failed', detail: 'repo not connected' });
    expect(h.github.mintInstallationToken).not.toHaveBeenCalled();
  });

  it('AC-9: a spec missing on the branch fails with the branch name', async () => {
    const h = build({ files: [null] });

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD)).resolves.toEqual({ kind: 'failed', detail: `spec missing on ${BRANCH}` });
    expect(h.github.putFile).not.toHaveBeenCalled();
  });

  it('AC-10: a conflict whose re-read finds the same blob sha is a refusal', async () => {
    const h = build({ files: [file(SPEC, BLOB_SHA), file(SPEC, BLOB_SHA)], put: { kind: 'conflict' } });

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD)).resolves.toEqual({ kind: 'failed', detail: 'spec write refused' });
    expect(h.reads()).toBe(2);
  });

  it('AC-11: a conflict whose re-read finds a moved blob sha retries', async () => {
    const h = build({ files: [file(SPEC, BLOB_SHA), file(`${SPEC}more\n`, MOVED_BLOB_SHA)], put: { kind: 'conflict' } });

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD)).resolves.toEqual({ kind: 'retry' });
    expect(h.reads()).toBe(2);
  });

  it('AC-11b: a conflict whose re-read finds no file retries', async () => {
    const h = build({ files: [file(SPEC, BLOB_SHA), null], put: { kind: 'conflict' } });

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD)).resolves.toEqual({ kind: 'retry' });
  });

  it('AC-12: an installation the app cannot use fails with that reason', async () => {
    const h = build({ mintError: new RepoCheckException('app_not_installed') });

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD)).resolves.toEqual({ kind: 'failed', detail: 'app_not_installed' });
    expect(h.github.getFile).not.toHaveBeenCalled();
  });

  it('AC-13: an unreachable provider retries', async () => {
    const h = build({ putError: new RepoCheckException('provider_unreachable') });

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD)).resolves.toEqual({ kind: 'retry' });
  });

  it('AC-14: a refused contents write fails the calls step', async () => {
    const h = build({ put: { kind: 'refused' } });

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD)).resolves.toEqual({ kind: 'failed', detail: 'spec write refused' });
  });

  it('AC-15: a head that moved since the review is stale and writes nothing', async () => {
    const h = build({ head: OTHER_HEAD });

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD)).resolves.toEqual({ kind: 'stale', head: OTHER_HEAD });
    expect(h.github.getBranchHead).toHaveBeenCalledWith(TOKEN, 'o', 'r', BRANCH);
    expect(h.github.putFile).not.toHaveBeenCalled();
  });

  it('writes when the head still matches the head the review saw', async () => {
    const h = build({ head: EXPECTED_HEAD });

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD)).resolves.toEqual({ kind: 'committed', specSha: COMMIT_SHA });
    expect(h.github.putFile).toHaveBeenCalledTimes(1);
  });

  it('a non-forge error from the write propagates', async () => {
    const h = build({ putError: new Error('bug') });

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD)).rejects.toThrow('bug');
  });

  it('a flow without a feature fails without touching the forge', async () => {
    const h = build();

    await expect(h.service.apply(flow({ features: [] }), action(), EXPECTED_HEAD)).resolves.toEqual({ kind: 'failed', detail: 'feature missing' });
    expect(h.github.mintInstallationToken).not.toHaveBeenCalled();
  });
});
