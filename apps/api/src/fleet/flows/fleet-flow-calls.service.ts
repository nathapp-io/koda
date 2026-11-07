import { Injectable } from '@nestjs/common';
import { GitHubAppClient } from '../git-broker/github-app-client';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { FleetReposService } from '../repos/fleet-repos.service';
import type { FleetFlowRecord } from './domain/fleet-flow.domain';
import { buildFlowCalls, callsOutcomeForForgeError } from './flow-calls';
import type { ApplyCallsAction } from './flow-step-decision';

/**
 * What one attempt at appending the review's calls to the spec did. `retry` hands the step back to the
 * next tick without touching flow state; a `stale` head goes to the caller, which re-asks the new spec.
 */
export type CallsOutcome =
  | { kind: 'committed'; specSha: string }
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

  async apply(flow: FleetFlowRecord, action: ApplyCallsAction, expectedHead: string): Promise<CallsOutcome> {
    // A flow's calls step runs for exactly one feature; anything else has no spec to write.
    const feature = flow.features[0];
    if (!feature) return { kind: 'failed', detail: 'feature missing' };

    const repo = await this.repos.findReviewRepo(flow.repoId);
    if (!repo || repo.githubInstallationId === null) return { kind: 'failed', detail: 'repo not connected' };

    try {
      const { token } = await this.github.mintInstallationToken(repo.githubInstallationId, repo.name);
      const file = await this.github.getFile(token, repo.owner, repo.name, feature.specPath, flow.branch);
      if (!file) return { kind: 'failed', detail: `spec missing on ${flow.branch}` };

      const built = buildFlowCalls(file.content.toString('utf8'), action);
      // The block is already on the branch: this is the crash-recovery path, so the head is whatever the
      // calls commit left it at and the expected head no longer applies.
      if (built.alreadyApplied) {
        return { kind: 'committed', specSha: await this.github.getBranchHead(token, repo.owner, repo.name, flow.branch) };
      }

      const head = await this.github.getBranchHead(token, repo.owner, repo.name, flow.branch);
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
