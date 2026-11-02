import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { REVIEW_EVENTS_INGESTED, type ReviewEventsIngestedEvent } from '../common/review-events';
import { bookkeeping } from '../../action-context/audit-coverage';
import { runAsSystemWriter, runWithApproval } from '../../action-context/action-context';
import { ReviewDecisionWriter, type ReviewDecisionInput, type ReviewDecisionResult } from '../../memory/review-decision.writer';
import { SystemWriter } from '../../permissions/system-writer.decorator';
import { GitHubAppClient, type ReviewThreadInfo } from '../git-broker/github-app-client';
import { FleetReposService } from '../repos/fleet-repos.service';
import type { FleetReviewEventRecord } from './domain/fleet-review-event.domain';
import { FleetReviewEventsService } from './fleet-review-events.service';

/** A repository role that may author a review: the same set `getRepoRole` reports as write-capable. */
const WRITER_ROLES: ReadonlySet<string> = new Set(['admin', 'maintain', 'write']);

/** Forge logins are case-insensitive; two spellings of one login are one author. */
const normalizeLogin = (login: string): string => login.toLowerCase();

type ReviewRepo = { owner: string; name: string };

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
      ({ token } = await this.github.mintThreadReadToken(repo.githubInstallationId, repo.name));
    } catch (error) {
      return this.retry(row.id, error);
    }
    let writers: string[];
    try {
      writers = await this.writers(logins, token, repo);
    } catch (error) {
      this.logFailure(row.id, error);
      return this.skip(row.id, 'permission-check-failed');
    }
    if (writers.length === 0) return this.skip(row.id, 'no-writer');

    // US-007 (ruling 14): the writer is the approver either way; only a confirmed thread author is a
    // *verified* forge-human approval. An unverified decision is still minted — downgraded, not dropped.
    const verified = await this.verifiedWriter(row, repo, token, writers);
    const approver = verified ?? writers[0];

    let result: ReviewDecisionResult;
    try {
      result = await runWithApproval({
        requiredMode: 'human', satisfiedBy: verified === undefined ? 'none' : 'human',
        approverType: 'FORGE_USER', approverId: `github:${approver}`,
      }, () => this.writer.mint(input));
    } catch (error) {
      return this.retry(row.id, error);
    }
    // Bookkeeping failure is not a failed mint: the next pass discovers the durable decision as a duplicate.
    if (result.status === 'skipped') return this.skip(row.id, result.reason);
    await bookkeeping('fleet.review-event-bookkeeping', () =>
      this.events.markMinted(row.id, { memoryItemId: result.memoryItemId, approverLogin: approver }));
  }

  /** One role lookup per non-bot login, in `disagreedBy` order; every writer is kept, not just the first. */
  private async writers(logins: readonly string[], token: string, repo: ReviewRepo): Promise<string[]> {
    const roles = await Promise.all(logins.map((login) => this.github.getRepoRole(token, repo.owner, repo.name, login)));
    return logins.filter((_login, index) => WRITER_ROLES.has(roles[index]));
  }

  /**
   * The first writer who commented in the review thread `row.threadId` names, when that thread belongs to the
   * same PR and repository. A failed lookup, a foreign thread or no match all answer undefined: unverified.
   */
  private async verifiedWriter(row: FleetReviewEventRecord, repo: ReviewRepo, token: string, writers: readonly string[]): Promise<string | undefined> {
    let thread: ReviewThreadInfo | null;
    try {
      thread = await this.github.getReviewThread(token, row.threadId);
    } catch (error) {
      this.logFailure(row.id, error);
      return undefined;
    }
    if (thread === null || thread.prNumber !== row.prNumber) return undefined;
    if (normalizeLogin(thread.repoOwner) !== normalizeLogin(repo.owner)) return undefined;
    if (normalizeLogin(thread.repoName) !== normalizeLogin(repo.name)) return undefined;

    const authors = new Set(thread.authors.map(normalizeLogin));
    return writers.find((login) => authors.has(normalizeLogin(login)));
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
