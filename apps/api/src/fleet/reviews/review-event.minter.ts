import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { REVIEW_EVENTS_INGESTED, type ReviewEventsIngestedEvent } from '../common/review-events';
import { bookkeeping } from '../../action-context/audit-coverage';
import { runAsSystemWriter, runWithApproval } from '../../action-context/action-context';
import { ReviewDecisionWriter, type ReviewDecisionInput, type ReviewDecisionResult } from '../../memory/review-decision.writer';
import { SystemWriter } from '../../permissions/system-writer.decorator';
import { GitHubAppClient } from '../git-broker/github-app-client';
import { FleetReposService } from '../repos/fleet-repos.service';
import type { FleetReviewEventRecord } from './domain/fleet-review-event.domain';
import { FleetReviewEventsService } from './fleet-review-events.service';

@Injectable()
@SystemWriter('system.review.decision')
export class ReviewEventMinter {
  private readonly logger = new Logger(ReviewEventMinter.name);
  private running = false;

  constructor(
    private readonly events: FleetReviewEventsService,
    private readonly repos: FleetReposService,
    private readonly github: GitHubAppClient,
    private readonly writer: ReviewDecisionWriter,
  ) {}

  @OnEvent(REVIEW_EVENTS_INGESTED)
  onEventsIngested(_event: ReviewEventsIngestedEvent): Promise<void> {
    return this.run();
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await runAsSystemWriter(this, async () => {
        const rows = await this.events.claimPending(20);
        for (const row of rows) await this.mintOne(row);
      });
    } catch (error) {
      this.logger.error(`Review event mint pass failed (${error instanceof Error ? error.name : 'unknown'})`);
    } finally {
      this.running = false;
    }
  }

  private async mintOne(row: FleetReviewEventRecord): Promise<void> {
    const logins = row.disagreedBy.filter(login => !login.endsWith('[bot]'));
    if (logins.length === 0) return this.skip(row.id, 'no-writer');
    const input: ReviewDecisionInput = {
      projectId: row.projectId, repoId: row.repoId, prNumber: row.prNumber, jobId: row.jobId,
      threadId: row.threadId, findingKey: row.findingKey, finding: row.finding, reason: row.reason,
      file: row.file ?? undefined, line: row.line ?? undefined,
    };
    const skipped = await this.writer.guard(input);
    if (skipped) return this.skip(row.id, skipped.reason);
    const repo = await this.repos.findReviewRepo(row.repoId);
    if (!repo || repo.githubInstallationId === null) return this.skip(row.id, 'repo-unavailable');

    let token: string;
    try {
      ({ token } = await this.github.mintReadOnlyToken(repo.githubInstallationId, repo.name));
    } catch (error) {
      return this.retry(row.id, error);
    }
    let approver: string | undefined;
    try {
      for (const login of logins) {
        const role = await this.github.getRepoRole(token, repo.owner, repo.name, login);
        if (role === 'admin' || role === 'maintain' || role === 'write') {
          approver = login;
          break;
        }
      }
    } catch (error) {
      this.logFailure(row.id, error);
      return this.skip(row.id, 'permission-check-failed');
    }
    if (approver === undefined) return this.skip(row.id, 'no-writer');

    let result: ReviewDecisionResult;
    try {
      result = await runWithApproval({
        requiredMode: 'human', satisfiedBy: 'human', approverType: 'FORGE_USER', approverId: `github:${approver}`,
      }, () => this.writer.mint(input));
    } catch (error) {
      return this.retry(row.id, error);
    }
    // Bookkeeping failure is not a failed mint: the next pass discovers the durable decision as a duplicate.
    if (result.status === 'skipped') return this.skip(row.id, result.reason);
    await bookkeeping('fleet.review-event-bookkeeping', () =>
      this.events.markMinted(row.id, { memoryItemId: result.memoryItemId, approverLogin: approver }));
  }

  private async retry(id: string, error: unknown): Promise<void> {
    this.logFailure(id, error);
    if (await bookkeeping('fleet.review-event-bookkeeping', () => this.events.bumpAttempt(id)) >= 3) await this.skip(id, 'mint-failed');
  }

  private skip(id: string, reason: string): Promise<void> {
    return bookkeeping('fleet.review-event-bookkeeping', () => this.events.markSkipped(id, reason));
  }

  private logFailure(id: string, error: unknown): void {
    // Provider errors may carry credentials in their message or HTTP payload: log only the error class.
    this.logger.warn(`Review event ${id} failed (${error instanceof Error ? error.name : 'unknown'})`);
  }
}
