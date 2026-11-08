import { Injectable } from '@nestjs/common';
import { GitHubAppClient } from '../git-broker/github-app-client';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { FleetReposService } from '../repos/fleet-repos.service';
import type { FleetFlowRecord } from './domain/fleet-flow.domain';
import { buildFlowCalls, callsOutcomeForForgeError } from './flow-calls';
import { applyPrdEditsToText, type FlowPrdEditRefusal } from './flow-prd-edits';
import type { ApplyCallsAction, ApplyPrdEditsAction } from './flow-step-decision';

/**
 * What one attempt at appending the review's calls to the spec did. `retry` hands the step back to the
 * next tick without touching flow state; a `stale` head goes to the caller, which re-asks the new spec.
 */
export type CallsOutcome =
  | { kind: 'committed'; specSha: string }
  | { kind: 'stale'; head: string }
  | { kind: 'retry' }
  | { kind: 'failed'; detail: string };

export type PrdEditsOutcome =
  | { kind: 'committed'; sha: string; applied: number; refused: FlowPrdEditRefusal[] }
  | { kind: 'unchanged'; refused: FlowPrdEditRefusal[] }
  | { kind: 'stale'; head: string }
  | { kind: 'retry' }
  | { kind: 'failed'; detail: string };

/**
 * Appends a review's calls to the flow's spec on its branch (spec US-006).
 *
 * The write is one contents-API commit on top of the branch head, so the spec above the block is never
 * rewritten. Nothing here mutates flow state: the caller records a commit, re-asks a stale head, or stops
 * the flow. The minted token stays inside this method, and no transaction is held across a forge call.
 */
@Injectable()
export class FleetFlowCallsService {
  constructor(
    private readonly repos: FleetReposService,
    private readonly github: GitHubAppClient,
  ) {}

  async applyPrdEdits(flow: FleetFlowRecord, action: ApplyPrdEditsAction, expectedHead: string): Promise<PrdEditsOutcome> {
    if (action.edits.length === 0) return { kind: 'unchanged', refused: [] };

    const feature = flow.features[0];
    if (!feature) return { kind: 'failed', detail: 'feature missing' };

    const repo = await this.repos.findReviewRepo(flow.repoId);
    if (!repo || repo.githubInstallationId === null) return { kind: 'failed', detail: 'repo not connected' };

    const path = `.nax/features/${feature.feature}/prd.json`;
    try {
      const { token } = await this.github.mintInstallationToken(repo.githubInstallationId, repo.name);
      const head = await this.github.getBranchHead(token, repo.owner, repo.name, flow.branch);
      const file = await this.github.getFile(token, repo.owner, repo.name, path, head);
      if (!file) return { kind: 'failed', detail: `prd.json missing on ${flow.branch}` };
      if (head !== expectedHead) return { kind: 'stale', head };

      const result = applyPrdEditsToText(file.content.toString('utf8'), action.edits);
      if (result.kind === 'unreadable') return { kind: 'failed', detail: 'prd.json unreadable' };
      if (result.applied === 0) return { kind: 'unchanged', refused: result.refused };

      const written = await this.github.putFile(token, repo.owner, repo.name, path, {
        branch: flow.branch,
        content: Buffer.from(result.text, 'utf8'),
        blobSha: file.sha,
        message: `chore(${feature.feature}): flow PRD edits from PRD_REVIEW job ${action.jobId}`,
      });
      if (written.kind === 'committed') {
        return { kind: 'committed', sha: written.commitSha, applied: result.applied, refused: result.refused };
      }
      if (written.kind === 'refused') return { kind: 'failed', detail: 'prd.json write refused' };
      return { kind: 'retry' };
    } catch (error) {
      if (!(error instanceof RepoCheckException)) throw error;
      return callsOutcomeForForgeError(error.reason) === 'failed'
        ? { kind: 'failed', detail: error.reason }
        : { kind: 'retry' };
    }
  }

  async apply(flow: FleetFlowRecord, action: ApplyCallsAction, expectedHead: string): Promise<CallsOutcome> {
    // A flow's calls step runs for exactly one feature; anything else has no spec to write.
    const feature = flow.features[0];
    if (!feature) return { kind: 'failed', detail: 'feature missing' };

    const repo = await this.repos.findReviewRepo(flow.repoId);
    if (!repo || repo.githubInstallationId === null) return { kind: 'failed', detail: 'repo not connected' };

    try {
      const { token } = await this.github.mintInstallationToken(repo.githubInstallationId, repo.name);
      const head = await this.github.getBranchHead(token, repo.owner, repo.name, flow.branch);
      // Pin the read to the head we compare, not a moving branch name.
      const file = await this.github.getFile(token, repo.owner, repo.name, feature.specPath, head);
      if (!file) return { kind: 'failed', detail: `spec missing on ${flow.branch}` };

      const built = buildFlowCalls(file.content.toString('utf8'), action);
      if (built.alreadyApplied) {
        // A heading alone is not proof of our commit: an external edit may have retained it.
        // Recover only a single spec-only commit directly after the reviewed head, containing exactly
        // the expected append. Any later commit (even outside the spec) must re-ask approval.
        const base = await this.github.getFile(token, repo.owner, repo.name, feature.specPath, expectedHead);
        const expected = base && buildFlowCalls(base.content.toString('utf8'), action);
        if (!expected || expected.alreadyApplied || !file.content.equals(Buffer.from(expected.text, 'utf8'))
          || !(await this.github.isSingleFileCommit(token, repo.owner, repo.name, expectedHead, head, feature.specPath))) {
          return { kind: 'stale', head };
        }
        return { kind: 'committed', specSha: head };
      }

      if (head !== expectedHead) return { kind: 'stale', head };

      const written = await this.github.putFile(token, repo.owner, repo.name, feature.specPath, {
        branch: flow.branch,
        content: Buffer.from(built.text, 'utf8'),
        blobSha: file.sha,
        message: `docs(${feature.feature}): flow calls from ${action.step} job ${action.jobId}`,
      });
      if (written.kind === 'committed') return { kind: 'committed', specSha: written.commitSha };
      // A 422 is a branch rule or an invalid request, never a transient failure.
      if (written.kind === 'refused') return { kind: 'failed', detail: 'spec write refused' };

      // A 409 may still be a refusal: the same blob sha means nobody moved the file, so the branch refused
      // the commit. A moved (or deleted) file is worth another pass against the new one.
      const reread = await this.github.getFile(token, repo.owner, repo.name, feature.specPath, flow.branch);
      if (reread && reread.sha === file.sha) return { kind: 'failed', detail: 'spec write refused' };
      return { kind: 'retry' };
    } catch (error) {
      if (!(error instanceof RepoCheckException)) throw error;
      return callsOutcomeForForgeError(error.reason) === 'failed'
        ? { kind: 'failed', detail: error.reason }
        : { kind: 'retry' };
    }
  }
}
