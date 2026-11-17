import type { GitHubAppClient, PutFileResult } from '../git-broker/github-app-client';
import type { ForgeFile } from '../git-broker/forge-tree';
import type { GitLabAccess } from '../git-broker/gitlab-repo-credentials';
import type { GitLabTokenKind } from '../git-broker/prisma-gitlab-credential.repository';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import type { FleetReposService } from '../repos/fleet-repos.service';
import type { FleetFlowFeatureRecord, FleetFlowRecord } from './domain/fleet-flow.domain';
import { FleetFlowCallsService } from './fleet-flow-calls.service';
import type { ApplyPrdEditsAction } from './flow-step-decision';
import type { FlowPrdEdit } from './flow-prd-edits';
import { applyPrdEditsToText } from './flow-prd-edits';

const NOW = new Date('2026-11-17T12:30:00.000Z');
const PATH = '.nax/features/f/prd.json';
const BRANCH = 'feat/f';
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const COMMIT_SHA = 'c'.repeat(40);
const LAST_COMMIT_ID = 'lc1';
const MOVED_LAST_COMMIT_ID = 'lc2';
const ACCESS: GitLabAccess = { token: 'access-token', target: { apiBase: 'https://gitlab.com/api/v4', projectId: 7 } };
const TARGET = { feature: 'f', specPath: PATH, branch: BRANCH };
const PRD = JSON.stringify({ userStories: [{ id: 'US-001', acceptanceCriteria: ['old criterion'] }] });
const edit: FlowPrdEdit = { story: 'US-001', op: 'replace_ac', old: 'old criterion', new: 'new criterion' };
const action = (edits: FlowPrdEdit[] = [edit]): ApplyPrdEditsAction => ({ kind: 'apply_prd_edits', jobId: 'j-prd', edits, accepted: [] });
const feature = (): FleetFlowFeatureRecord => ({ id: 'feature-1', flowId: 'flow-1', position: 0, feature: 'f', specPath: PATH, dependsOn: [], state: 'RUNNING', currentStep: 'PRD_REVIEW', prNumber: null });
const flow = (): FleetFlowRecord => ({ id: 'flow-1', projectId: 'p1', repoId: 'repo-1', threadId: null, entry: 'NAX', createdByType: 'USER', createdById: 'u1', branch: BRANCH, specSha: BASE, pinnedRunnerId: null, reviewerRole: 'opus', supervisorRole: 'haiku', costCapUsd: '10.0000', spentUsd: '0.0000', state: 'RUNNING', approvalMode: 'PRE_APPROVED', approverId: 'u1', approvedAt: NOW, approvalRequestId: null, stopReason: null, stopDetail: null, endedAt: null, createdAt: NOW, updatedAt: NOW, features: [feature()] });
const forgeFile = (text: string, lastCommitId = LAST_COMMIT_ID): ForgeFile & { lastCommitId: string } => ({ sha: `blob-${lastCommitId}`, size: Buffer.byteLength(text), content: Buffer.from(text), lastCommitId });
interface Options {
  installationId?: bigint | null;
  head?: string;
  files?: ((ForgeFile & { lastCommitId: string }) | null)[];
  baseFile?: ForgeFile | null;
  singleFileCommit?: boolean;
  commit?: PutFileResult;
  credentialError?: string;
}
function build(options: Options = {}) {
  const repo = { id: 'repo-1', projectId: 'p1', owner: 'grp', name: 'app', host: 'https://gitlab.com', provider: 'gitlab', defaultBranch: 'main', githubInstallationId: options.installationId ?? null };
  const repos = { findReviewRepo: vi.fn<FleetReposService['findReviewRepo']>(async () => repo) };
  const files = [...(options.files ?? [forgeFile(PRD)])];
  const nextFile = () => files.length > 1 ? files.shift() ?? null : files[0] ?? null;
  const kinds: GitLabTokenKind[] = [];
  const credentials = { call: vi.fn(async (_repo: unknown, kind: GitLabTokenKind, fn: (access: GitLabAccess) => Promise<unknown>) => {
    kinds.push(kind);
    if (options.credentialError) throw new RepoCheckException(options.credentialError as never);
    return fn(ACCESS);
  }) };
  const gitlab = {
    getBranchHead: vi.fn(async () => options.head ?? BASE),
    getFileForUpdate: vi.fn(async () => nextFile()),
    getFile: vi.fn(async () => options.baseFile ?? forgeFile(PRD)),
    isSingleFileCommit: vi.fn(async () => options.singleFileCommit ?? false),
    commitFile: vi.fn(async () => options.commit ?? { kind: 'committed', commitSha: COMMIT_SHA }),
  };
  const github = { mintInstallationToken: vi.fn<GitHubAppClient['mintInstallationToken']>(async () => ({ token: 'github-token', expiresAt: NOW })) };
  const service = new FleetFlowCallsService(repos as never, github as never, credentials as never, gitlab as never);
  return { service, repo, repos, credentials, gitlab, github, kinds };
}

describe('FleetFlowCallsService.applyPrdEdits on GitLab', () => {
  it('AC-1: locks and commits the target PRD through write credentials', async () => {
    const h = build({ head: BASE });
    await expect(h.service.applyPrdEdits(flow(), action(), BASE, TARGET)).resolves.toEqual({ kind: 'committed', sha: COMMIT_SHA, applied: 1, refused: [] });
    const edited = applyPrdEditsToText(PRD, [edit]);
    expect(h.gitlab.getBranchHead).toHaveBeenCalledWith(ACCESS, BRANCH);
    expect(h.gitlab.getFileForUpdate).toHaveBeenCalledWith(ACCESS, PATH, BASE);
    expect(edited.kind).toBe('ok');
    if (edited.kind !== 'ok') return;
    expect(h.gitlab.commitFile).toHaveBeenCalledWith(ACCESS, PATH, { branch: BRANCH, content: Buffer.from(edited.text), lastCommitId: LAST_COMMIT_ID, message: 'chore(f): flow PRD edits from PRD_REVIEW job j-prd' });
    expect(h.kinds).toEqual(['read', 'read', 'write']);
  });

  it('AC-2: returns unchanged and does not commit when no edit applied', async () => {
    const h = build();
    await expect(h.service.applyPrdEdits(flow(), action([{ ...edit, old: 'absent' }]), BASE, TARGET)).resolves.toEqual({ kind: 'unchanged', refused: [{ index: 0, story: 'US-001', op: 'replace_ac', reason: 'text not found' }] });
    expect(h.gitlab.commitFile).not.toHaveBeenCalled();
  });

  it('AC-3: moved head is stale when single-file proof fails', async () => {
    const edited = applyPrdEditsToText(PRD, [edit]);
    if (edited.kind !== 'ok') throw new Error('fixture must be readable');
    const h = build({ head: HEAD, files: [forgeFile(edited.text)], singleFileCommit: false });
    await expect(h.service.applyPrdEdits(flow(), action(), BASE, TARGET)).resolves.toEqual({ kind: 'stale', head: HEAD });
    expect(h.gitlab.isSingleFileCommit).toHaveBeenCalledWith(ACCESS, BASE, HEAD, PATH);
  });

  it('AC-4: recovers an exact proven edit at the moved head', async () => {
    const edited = applyPrdEditsToText(PRD, [edit]);
    if (edited.kind !== 'ok') throw new Error('fixture must be readable');
    const h = build({ head: HEAD, files: [forgeFile(edited.text)], baseFile: forgeFile(PRD), singleFileCommit: true });
    await expect(h.service.applyPrdEdits(flow(), action(), BASE, TARGET)).resolves.toEqual({ kind: 'committed', sha: HEAD, applied: 1, refused: [] });
    expect(h.gitlab.getFile).toHaveBeenCalledWith(ACCESS, PATH, BASE);
    expect(h.gitlab.isSingleFileCommit).toHaveBeenCalledWith(ACCESS, BASE, HEAD, PATH);
    expect(h.kinds).toEqual(['read', 'read', 'read', 'read']);
    expect(h.gitlab.commitFile).not.toHaveBeenCalled();
  });

  it('AC-5: a proven commit with bytes unlike the base edit is stale', async () => {
    const h = build({ head: HEAD, files: [forgeFile(JSON.stringify({ userStories: [] }))], baseFile: forgeFile(PRD), singleFileCommit: true });
    await expect(h.service.applyPrdEdits(flow(), action(), BASE, TARGET)).resolves.toEqual({ kind: 'stale', head: HEAD });
  });

  it('AC-6: conflict with the same lastCommitId is a refusal', async () => {
    const h = build({ files: [forgeFile(PRD), forgeFile(PRD)], commit: { kind: 'conflict' } });
    await expect(h.service.applyPrdEdits(flow(), action(), BASE, TARGET)).resolves.toEqual({ kind: 'failed', detail: 'prd.json write refused' });
    expect(h.gitlab.getFileForUpdate).toHaveBeenLastCalledWith(ACCESS, PATH, BRANCH);
  });

  it('AC-7: conflict with a moved lastCommitId retries', async () => {
    const h = build({ files: [forgeFile(PRD), forgeFile(PRD, MOVED_LAST_COMMIT_ID)], commit: { kind: 'conflict' } });
    await expect(h.service.applyPrdEdits(flow(), action(), BASE, TARGET)).resolves.toEqual({ kind: 'retry' });
  });

  it('AC-8: missing credentials fail with their reason', async () => {
    const h = build({ credentialError: 'gitlab_credentials_missing' });
    await expect(h.service.applyPrdEdits(flow(), action(), BASE, TARGET)).resolves.toEqual({ kind: 'failed', detail: 'gitlab_credentials_missing' });
  });

  it('AC-9: a GitLab row never invokes GitHub token minting', async () => {
    const h = build({ installationId: 9n });
    await h.service.applyPrdEdits(flow(), action(), BASE, TARGET);
    expect(h.github.mintInstallationToken).not.toHaveBeenCalled();
  });

  it('AC-10: invalid credentials fail with their reason', async () => {
    const h = build({ credentialError: 'gitlab_token_invalid' });
    await expect(h.service.applyPrdEdits(flow(), action(), BASE, TARGET)).resolves.toEqual({ kind: 'failed', detail: 'gitlab_token_invalid' });
  });

  it.each(['gitlab_host_blocked', 'gitlab_host_invalid', 'gitlab_host_unclassified', 'vcs_encryption_key_missing', 'provider_error'] as const)('AC-11: %s retries', async (reason) => {
    const h = build();
    h.gitlab.getBranchHead.mockRejectedValue(new RepoCheckException(reason));
    await expect(h.service.applyPrdEdits(flow(), action(), BASE, TARGET)).resolves.toEqual({ kind: 'retry' });
  });

  it('AC-12: conflict with a deleted PRD retries', async () => {
    const h = build({ files: [forgeFile(PRD), null], commit: { kind: 'conflict' } });
    await expect(h.service.applyPrdEdits(flow(), action(), BASE, TARGET)).resolves.toEqual({ kind: 'retry' });
  });

  it('AC-13: a retry-class conflict re-read error retries', async () => {
    const h = build({ commit: { kind: 'conflict' } });
    h.gitlab.getFileForUpdate.mockResolvedValueOnce(forgeFile(PRD)).mockRejectedValueOnce(new RepoCheckException('provider_error'));
    await expect(h.service.applyPrdEdits(flow(), action(), BASE, TARGET)).resolves.toEqual({ kind: 'retry' });
  });
});
