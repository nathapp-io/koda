import type { GitHubAppClient, PutFileResult } from '../git-broker/github-app-client';
import type { ForgeFile } from '../git-broker/forge-tree';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import type { FleetReposService } from '../repos/fleet-repos.service';
import type { FleetFlowFeatureRecord, FleetFlowRecord } from './domain/fleet-flow.domain';
import { buildFlowCalls } from './flow-calls';
import type { ApplyCallsAction } from './flow-step-decision';
import { FleetFlowCallsService } from './fleet-flow-calls.service';
import type { ApplyPrdEditsAction } from './flow-step-decision';
import type { FlowPrdEdit } from './flow-prd-edits';
import * as prdEdits from './flow-prd-edits';

const NOW = new Date('2026-11-07T12:30:00.000Z');
const SPEC_PATH = '.nax/features/f/spec.md';
const BRANCH = 'feat/f';
/** The head the review saw; the tests move it to model a push between the review and the calls. */
const EXPECTED_HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const COMMIT_SHA = 'c'.repeat(40);
const TOKEN = 'test-only-token';
const SPEC = '# Spec\n\nSome text\n';
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
  singleFileCommit?: boolean;
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
    isSingleFileCommit: vi.fn(async () => opts.singleFileCommit ?? true),
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

const PRD_PATH = '.nax/features/f/prd.json';
const PRD = JSON.stringify({ userStories: [{ id: 'US-001', acceptanceCriteria: ['old criterion'] }] });
const prdAction = (edits: FlowPrdEdit[]): ApplyPrdEditsAction => ({
  kind: 'apply_prd_edits', jobId: 'j-prd', edits, accepted: [],
});
const onePrdEdit: FlowPrdEdit = { story: 'US-001', op: 'replace_ac', old: 'old criterion', new: 'new criterion' };
const prdFile = (text = PRD, sha = BLOB_SHA): ForgeFile => ({ sha, size: Buffer.byteLength(text), content: Buffer.from(text, 'utf8') });

describe('FleetFlowCallsService.applyPrdEdits', () => {
  const prdFlow = () => flow({ features: [feature({ feature: 'f', specPath: PRD_PATH })] });

  it('AC-1: writes the PRD on the flow branch with the pinned blob sha', async () => {
    const h = build({ files: [prdFile()] });
    await h.service.applyPrdEdits(prdFlow(), prdAction([onePrdEdit]), EXPECTED_HEAD);
    const [token, owner, name, path, input] = h.putArgs();
    expect([token, owner, name, path]).toEqual([TOKEN, 'o', 'r', PRD_PATH]);
    expect(input.branch).toBe(BRANCH);
    expect(input.blobSha).toBe(BLOB_SHA);
  });

  it('AC-2: uses the PRD review job in the commit message', async () => {
    const h = build({ files: [prdFile()] });
    await h.service.applyPrdEdits(prdFlow(), prdAction([onePrdEdit]), EXPECTED_HEAD);
    expect(h.putArgs()[4].message).toBe('chore(f): flow PRD edits from PRD_REVIEW job j-prd');
  });

  it('AC-3: returns the committed sha, applied count and refusals', async () => {
    const h = build({ files: [prdFile()], put: { kind: 'committed', commitSha: COMMIT_SHA } });
    await expect(h.service.applyPrdEdits(prdFlow(), prdAction([onePrdEdit]), EXPECTED_HEAD)).resolves.toEqual({
      kind: 'committed', sha: COMMIT_SHA, applied: 1, refused: [],
    });
  });

  it('AC-4: writes the exact text returned by applyPrdEditsToText', async () => {
    const h = build({ files: [prdFile()] });
    const apply = vi.spyOn(prdEdits, 'applyPrdEditsToText').mockReturnValue({ kind: 'ok', text: 'T', applied: 1, refused: [] });
    await h.service.applyPrdEdits(prdFlow(), prdAction([onePrdEdit]), EXPECTED_HEAD);
    expect(apply).toHaveBeenCalledWith(PRD, [onePrdEdit]);
    expect(h.putArgs()[4].content).toEqual(Buffer.from('T', 'utf8'));
    apply.mockRestore();
  });

  it('AC-5: empty edits are unchanged without minting a token', async () => {
    const h = build();
    await expect(h.service.applyPrdEdits(prdFlow(), prdAction([]), EXPECTED_HEAD)).resolves.toEqual({ kind: 'unchanged', refused: [] });
    expect(h.github.mintInstallationToken).not.toHaveBeenCalled();
  });

  it('AC-6/7: all refused edits are unchanged and do not write', async () => {
    const h = build({ files: [prdFile()] });
    const refused = [{ index: 0, story: 'US-001', op: 'replace_ac', reason: 'text not found' }];
    vi.spyOn(prdEdits, 'applyPrdEditsToText').mockReturnValue({ kind: 'ok', text: PRD, applied: 0, refused });
    await expect(h.service.applyPrdEdits(prdFlow(), prdAction([onePrdEdit]), EXPECTED_HEAD)).resolves.toEqual({ kind: 'unchanged', refused });
    expect(h.github.putFile).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('AC-8: missing PRD fails with the branch name', async () => {
    const h = build({ files: [null] });
    await expect(h.service.applyPrdEdits(prdFlow(), prdAction([onePrdEdit]), EXPECTED_HEAD)).resolves.toEqual({ kind: 'failed', detail: `prd.json missing on ${BRANCH}` });
  });

  it('AC-9: unreadable PRD fails', async () => {
    const h = build({ files: [prdFile('not json')] });
    await expect(h.service.applyPrdEdits(prdFlow(), prdAction([onePrdEdit]), EXPECTED_HEAD)).resolves.toEqual({ kind: 'failed', detail: 'prd.json unreadable' });
  });

  it('AC-10/12: missing or disconnected repo fails before minting', async () => {
    for (const repo of [null, reviewRepo({ githubInstallationId: null })]) {
      const h = build({ repo });
      await expect(h.service.applyPrdEdits(prdFlow(), prdAction([onePrdEdit]), EXPECTED_HEAD)).resolves.toEqual({ kind: 'failed', detail: 'repo not connected' });
      expect(h.github.mintInstallationToken).not.toHaveBeenCalled();
    }
  });

  it('AC-11: missing feature fails before minting', async () => {
    const h = build();
    await expect(h.service.applyPrdEdits(flow({ features: [] }), prdAction([onePrdEdit]), EXPECTED_HEAD)).resolves.toEqual({ kind: 'failed', detail: 'feature missing' });
    expect(h.github.mintInstallationToken).not.toHaveBeenCalled();
  });

  it('AC-1/2: returns stale and never writes when the moved head is not our commit', async () => {
    const h = build({ files: [prdFile(), prdFile()], head: OTHER_HEAD, singleFileCommit: false });
    await expect(h.service.applyPrdEdits(prdFlow(), prdAction([onePrdEdit]), EXPECTED_HEAD)).resolves.toEqual({ kind: 'stale', head: OTHER_HEAD });
    expect(h.github.putFile).not.toHaveBeenCalled();
  });

  it('AC-1: returns stale when a moved head no longer contains the PRD file', async () => {
    const h = build({ files: [null], head: OTHER_HEAD });
    await expect(h.service.applyPrdEdits(prdFlow(), prdAction([onePrdEdit]), EXPECTED_HEAD)).resolves.toEqual({ kind: 'stale', head: OTHER_HEAD });
    expect(h.github.putFile).not.toHaveBeenCalled();
  });

  it('AC-3/4: recovers our exact single-file PRD commit without writing twice', async () => {
    const editedResult = prdEdits.applyPrdEditsToText(PRD, [onePrdEdit]);
    if (editedResult.kind !== 'ok') throw new Error('test fixture PRD must be readable');
    const edited = editedResult.text;
    const h = build({ files: [prdFile(edited), prdFile()], head: OTHER_HEAD, singleFileCommit: true });
    await expect(h.service.applyPrdEdits(prdFlow(), prdAction([onePrdEdit]), EXPECTED_HEAD)).resolves.toEqual({ kind: 'committed', sha: OTHER_HEAD, applied: 1, refused: [] });
    expect(h.github.isSingleFileCommit).toHaveBeenCalledWith(TOKEN, 'o', 'r', EXPECTED_HEAD, OTHER_HEAD, PRD_PATH);
    expect(h.github.putFile).not.toHaveBeenCalled();
  });

  it('AC-5: a proved commit with different bytes is stale', async () => {
    const h = build({ files: [prdFile(JSON.stringify({ userStories: [] })), prdFile()], head: OTHER_HEAD, singleFileCommit: true });
    await expect(h.service.applyPrdEdits(prdFlow(), prdAction([onePrdEdit]), EXPECTED_HEAD)).resolves.toEqual({ kind: 'stale', head: OTHER_HEAD });
    expect(h.github.putFile).not.toHaveBeenCalled();
  });

  it('AC-6: a refused PRD contents write is a permanent failure', async () => {
    const h = build({ files: [prdFile()], put: { kind: 'refused' } });
    await expect(h.service.applyPrdEdits(prdFlow(), prdAction([onePrdEdit]), EXPECTED_HEAD)).resolves.toEqual({ kind: 'failed', detail: 'prd.json write refused' });
  });

  it('AC-7: conflict with unchanged blob sha is a refusal', async () => {
    const h = build({ files: [prdFile(), prdFile()], put: { kind: 'conflict' } });
    await expect(h.service.applyPrdEdits(prdFlow(), prdAction([onePrdEdit]), EXPECTED_HEAD)).resolves.toEqual({ kind: 'failed', detail: 'prd.json write refused' });
  });

  it('AC-8: conflict with moved blob sha retries', async () => {
    const h = build({ files: [prdFile(), prdFile(PRD, MOVED_BLOB_SHA)], put: { kind: 'conflict' } });
    await expect(h.service.applyPrdEdits(prdFlow(), prdAction([onePrdEdit]), EXPECTED_HEAD)).resolves.toEqual({ kind: 'retry' });
  });

  it('AC-9/10: maps permanent and transient forge exceptions', async () => {
    const permanent = build({ mintError: new RepoCheckException('app_not_installed') });
    await expect(permanent.service.applyPrdEdits(prdFlow(), prdAction([onePrdEdit]), EXPECTED_HEAD)).resolves.toEqual({ kind: 'failed', detail: 'app_not_installed' });
    const transient = build({ mintError: new RepoCheckException('provider_error') });
    await expect(transient.service.applyPrdEdits(prdFlow(), prdAction([onePrdEdit]), EXPECTED_HEAD)).resolves.toEqual({ kind: 'retry' });
  });
});

describe('FleetFlowCallsService.apply', () => {
  it('AC-1: reads the spec at the immutable head of the flow branch with an installation token', async () => {
    const h = build();

    await h.service.apply(flow(), action(), EXPECTED_HEAD);

    expect(h.repos.findReviewRepo).toHaveBeenCalledWith('repo-1');
    expect(h.github.mintInstallationToken).toHaveBeenCalledWith(1n, 'r');
    expect(h.github.getFile).toHaveBeenCalledWith(TOKEN, 'o', 'r', SPEC_PATH, EXPECTED_HEAD);
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

  it('AC-6: recovers only the exact calls commit without writing twice', async () => {
    const h = build({ files: [file(buildFlowCalls(SPEC, action()).text), file(SPEC)], head: COMMIT_SHA });

    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD)).resolves.toEqual({ kind: 'committed', specSha: COMMIT_SHA });
    expect(h.github.isSingleFileCommit).toHaveBeenCalledWith(TOKEN, 'o', 'r', EXPECTED_HEAD, COMMIT_SHA, SPEC_PATH);
    expect(h.github.getFile).toHaveBeenCalledWith(TOKEN, 'o', 'r', SPEC_PATH, EXPECTED_HEAD);
    expect(h.github.putFile).not.toHaveBeenCalled();
  });

  it('B1: re-asks when an external rewrite retains the calls heading', async () => {
    const rewritten = buildFlowCalls('# External spec rewrite\n', action()).text;
    const h = build({ files: [file(rewritten), file(SPEC)], head: OTHER_HEAD });
    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD)).resolves.toEqual({ kind: 'stale', head: OTHER_HEAD });
    expect(h.github.putFile).not.toHaveBeenCalled();
  });

  it('B1: re-asks after any later commit, even when the spec is unchanged', async () => {
    const h = build({ files: [file(buildFlowCalls(SPEC, action()).text), file(SPEC)], head: OTHER_HEAD, singleFileCommit: false });
    await expect(h.service.apply(flow(), action(), EXPECTED_HEAD)).resolves.toEqual({ kind: 'stale', head: OTHER_HEAD });
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
