import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { REVIEW_EVENTS_INGESTED, type ReviewEventsIngestedEvent } from '../common/review-events';
import { bookkeeping } from '../../action-context/audit-coverage';
import { runAsSystemWriter, runWithApproval } from '../../action-context/action-context';
import { ReviewDecisionWriter, type ReviewDecisionInput, type ReviewDecisionResult } from '../../memory/review-decision.writer';
import { SystemWriter } from '../../permissions/system-writer.decorator';
import { GitHubAppClient, type ReviewThreadInfo } from '../git-broker/github-app-client';
import { GITLAB_DEVELOPER_ACCESS, GitLabAccessChecker } from '../git-broker/gitlab-access-checker';
import { GitLabRepoCredentials } from '../git-broker/gitlab-repo-credentials';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { FleetReposService } from '../repos/fleet-repos.service';
import { GITHUB_LOGIN } from '../ingest/parsers/bot-review.parser';
import type { FleetReviewEventRecord } from './domain/fleet-review-event.domain';
import { FleetReviewEventsService } from './fleet-review-events.service';

/** A repository role that may author a review: the same set `getRepoRole` reports as write-capable. */
const WRITER_ROLES: ReadonlySet<string> = new Set(['admin', 'maintain', 'write']);

/** Forge logins are case-insensitive; two spellings of one login are one author. */
const normalizeLogin = (login: string): string => login.toLowerCase();

/** The repo projection the mint reads: its forge, its address and its GitHub App installation. */
type ReviewRepo = {
  id: string;
  /** Absent on a row (or fixture) written before the column; the store falls back to gitlab.com. */
  host?: string;
  owner: string;
  name: string;
  githubInstallationId: bigint | null;
};

/** US-006: the GitLab read seam, present together or not at all. */
type GitLabDeps = { credentials: GitLabRepoCredentials; checker: GitLabAccessChecker };

@Injectable()
@SystemWriter('system.review.decision')
export class ReviewEventMinter {
  private readonly logger = new Logger(ReviewEventMinter.name);
  private running = false;
  /** The GitLab dependencies, or null for a construction that predates US-006 (see the constructor). */
  private readonly gitlab: GitLabDeps | null;

  constructor(
    private readonly events: FleetReviewEventsService,
    private readonly repos: FleetReposService,
    private readonly github: GitHubAppClient,
    private readonly writer: ReviewDecisionWriter,
    /**
     * US-006: a GitLab row is read through the per-repo credential store — one `call` per forge
     * request — with the GitLab client. They are optional only so a positional construction that
     * predates this story still compiles; the module always injects both, and only a GitLab row
     * reads them.
     */
    gitlabCredentials?: GitLabRepoCredentials,
    gitlabChecker?: GitLabAccessChecker,
  ) {
    this.gitlab = gitlabCredentials === undefined || gitlabChecker === undefined
      ? null
      : { credentials: gitlabCredentials, checker: gitlabChecker };
  }

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
    if (!repo) return this.skip(row.id, 'repo-unavailable');

    // US-006: only now is the forge known — the repo row names it, and nothing before this point
    // could tell a GitLab merge request from a GitHub pull request.
    return repo.provider === 'gitlab'
      ? this.mintGitLab(row, repo, logins, input)
      : this.mintGitHub(row, repo, logins, input);
  }

  /**
   * The GitHub path, unchanged except for the logins it drops first: a GitLab username is not a
   * GitHub login, so it is no writer here (and a row that has only those is a `no-writer` row).
   */
  private async mintGitHub(row: FleetReviewEventRecord, repo: ReviewRepo, logins: readonly string[], input: ReviewDecisionInput): Promise<void> {
    const forgeLogins = logins.filter(login => GITHUB_LOGIN.test(login));
    if (forgeLogins.length === 0) return this.skip(row.id, 'no-writer');
    if (repo.githubInstallationId === null) return this.skip(row.id, 'repo-unavailable');

    let token: string;
    try {
      ({ token } = await this.github.mintThreadReadToken(repo.githubInstallationId, repo.name));
    } catch (error) {
      return this.retry(row.id, error);
    }
    let writers: string[];
    try {
      writers = await this.writers(forgeLogins, token, repo);
    } catch (error) {
      this.logFailure(row.id, error);
      return this.skip(row.id, 'permission-check-failed');
    }
    if (writers.length === 0) return this.skip(row.id, 'no-writer');

    // US-007 (ruling 14): the writer is the approver either way; only a confirmed thread author is a
    // *verified* forge-human approval. An unverified decision is still minted — downgraded, not dropped.
    const verified = await this.verifiedWriter(row, repo, token, writers);
    const approver = verified ?? writers[0];
    return this.mintDecision(row, input, 'github', approver, verified !== undefined);
  }

  /**
   * The GitLab path (US-006): the writers are the logins holding Developer access or above, and the
   * verified one is the first writer who authored the merge-request discussion `row.threadId` names.
   * Every forge read is its own `call`, so a 401 marks the read token invalid where it happens.
   */
  private async mintGitLab(row: FleetReviewEventRecord, repo: ReviewRepo, logins: readonly string[], input: ReviewDecisionInput): Promise<void> {
    const gitlab = this.gitlab;
    // A minter built without the GitLab dependencies cannot read a GitLab repo at all.
    if (gitlab === null) return this.skip(row.id, 'repo-unavailable');

    let writers: string[];
    try {
      writers = await this.gitlabWriters(gitlab, repo, logins);
    } catch (error) {
      // A disconnected repo does not heal on retry, a missing encryption key does, and every other
      // refusal — an invalid token included, whose `call` already marked it — is the check the row failed.
      if (error instanceof RepoCheckException && error.reason === 'gitlab_credentials_missing') {
        return this.skip(row.id, 'repo-unavailable');
      }
      if (error instanceof RepoCheckException && error.reason === 'vcs_encryption_key_missing') {
        return this.retry(row.id, error);
      }
      this.logFailure(row.id, error);
      return this.skip(row.id, 'permission-check-failed');
    }
    if (writers.length === 0) return this.skip(row.id, 'no-writer');

    const verified = await this.verifiedGitLabWriter(gitlab, row, repo, writers);
    const approver = verified ?? writers[0];
    return this.mintDecision(row, input, 'gitlab', approver, verified !== undefined);
  }

  /** The mint itself and its bookkeeping: the M1..M3 tail both forge paths share. */
  private async mintDecision(
    row: FleetReviewEventRecord,
    input: ReviewDecisionInput,
    provider: 'github' | 'gitlab',
    approver: string,
    verified: boolean,
  ): Promise<void> {
    let result: ReviewDecisionResult;
    try {
      result = await runWithApproval({
        requiredMode: 'human', satisfiedBy: verified ? 'human' : 'none',
        approverType: 'FORGE_USER', approverId: `${provider}:${approver}`,
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
   * US-006: one `call` per access-level read, in `disagreedBy` order, keeping every login whose level
   * is Developer (30) or above. It is a plain membership lookup, so a login past the store's first
   * page of matches answers level 0 and is not a writer.
   */
  private async gitlabWriters(gitlab: GitLabDeps, repo: ReviewRepo, logins: readonly string[]): Promise<string[]> {
    const target = { id: repo.id, host: repo.host };
    const levels = await Promise.all(logins.map(login =>
      gitlab.credentials.call(target, 'read', (access) => gitlab.checker.getMemberAccessLevel(access, login))));
    return logins.filter((_login, index) => levels[index] >= GITLAB_DEVELOPER_ACCESS);
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

  /**
   * US-006: the first writer, in `writers` order, who authored the merge-request discussion
   * `row.threadId` names. Its own `call`: a failed read (or one whose token was refused, which the
   * store marks on the way out) leaves the decision unverified rather than dropping it.
   */
  private async verifiedGitLabWriter(
    gitlab: GitLabDeps,
    row: FleetReviewEventRecord,
    repo: ReviewRepo,
    writers: readonly string[],
  ): Promise<string | undefined> {
    let discussion: { authors: string[] } | null;
    try {
      discussion = await gitlab.credentials.call({ id: repo.id, host: repo.host }, 'read',
        (access) => gitlab.checker.getMergeRequestDiscussion(access, row.prNumber, row.threadId));
    } catch (error) {
      this.logFailure(row.id, error);
      return undefined;
    }
    if (discussion === null) return undefined;
    const authors = new Set(discussion.authors.map(normalizeLogin));
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
