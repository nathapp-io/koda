import { Inject, Injectable, Logger } from '@nestjs/common';
import { runAsSystem, runAsSystemWriter } from '../../action-context/action-context';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import type { PrincipalRef } from '../../permissions/permissions.types';
import { SystemWriter } from '../../permissions/system-writer.decorator';
import { GitHubAppClient } from '../git-broker/github-app-client';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import type { FleetRepoRecord } from '../repos/domain/fleet-repo.domain';
import { FleetReposService } from '../repos/fleet-repos.service';
import { EnablerGate } from './enabler-gate';
import { ReviewHeadDispatcher } from './review-head-dispatcher';

/** The system component id: the second segment of `system.pr-review.dispatch` (action-context rule). */
const COMPONENT = 'pr-review';

const errorName = (error: unknown): string =>
  error instanceof RepoCheckException ? error.reason : error instanceof Error ? error.name : 'unknown';

/** The principal that enabled auto-review, off the repo row; null when the row names none. */
function storedEnabler(repo: FleetRepoRecord): PrincipalRef | null {
  const id = repo.autoReviewEnabledById;
  const type = repo.autoReviewEnabledByType;
  return id === null || type === null ? null : { type, id };
}

/**
 * Fleet auto-review (spec §"The pass and the poller"): one polling pass over the repos whose enabler
 * still holds `fleet.job.dispatch`. It reads through the koda-fleet App — GitHub cannot call koda — and
 * dispatches each review as the enabler, inside the `pr-review` component's context, so the turn-off
 * audit and the dispatch audit both name the principal the work is for.
 *
 * The pass is the system writer of `system.pr-review.dispatch`: the whole body runs in its scope.
 */
@Injectable()
@SystemWriter('system.pr-review.dispatch')
export class FleetPrReviewPass {
  /** Spec §"The pass and the poller" call 1: one page of at most 50 repos, in id order. */
  static readonly REPO_PAGE = 50;

  private readonly logger = new Logger(FleetPrReviewPass.name);

  constructor(
    private readonly repos: FleetReposService,
    private readonly gate: EnablerGate,
    private readonly github: GitHubAppClient,
    private readonly dispatcher: ReviewHeadDispatcher,
    @Inject(FLEET_CFG) private readonly config: Pick<IFleetConfig, 'prReviewMaxDispatch' | 'prReviewPollMs'>,
  ) {}

  /**
   * One pass at the given time. The poller owns the timer and single-flight (US-010); an error reading
   * the repo list escapes, so the poller logs it at error level.
   */
  run(now: Date): Promise<void> {
    return runAsSystemWriter(this, () => this.pass(now));
  }

  private async pass(now: Date): Promise<void> {
    const repos = await this.repos.listAutoReviewRepos(FleetPrReviewPass.REPO_PAGE);
    if (repos.length >= FleetPrReviewPass.REPO_PAGE) {
      this.logger.warn(
        `Auto-review pass read a full page of ${FleetPrReviewPass.REPO_PAGE} repos; repos past the first page by id wait for a later pass`,
      );
    }

    // Call 9: the cap is the pass's, not the repo's — calls earlier repos made leave the later ones less.
    let remaining = this.config.prReviewMaxDispatch;
    for (const repo of repos) {
      if (remaining <= 0) return;
      remaining -= await this.pollRepo(repo, now, remaining);
    }
  }

  /**
   * Call 2 for one repo: re-check the enabler, read its open PRs through the App, then dispatch within
   * what is left of the cap. One repo cannot fail the pass: every failure is a warning naming the repo
   * and the error, and the next repo is polled.
   */
  private async pollRepo(repo: FleetRepoRecord, now: Date, remaining: number): Promise<number> {
    const enabler = storedEnabler(repo);
    try {
      // The gate's turn-off audit runs inside this context too, so it carries the enabler as well.
      return await runAsSystem(
        COMPONENT,
        async () => {
          if ((await this.gate.check(repo)) === null) return 0;
          const { token } = await this.github.mintInstallationToken(this.installationId(repo), repo.name);
          const prs = await this.github.listOpenPullRequests(token, repo.owner, repo.name);
          return await this.dispatcher.dispatchRepo(repo, prs, { now, pollMs: this.config.prReviewPollMs, remaining });
        },
        enabler === null ? undefined : { onBehalfOf: enabler },
      );
    } catch (error) {
      this.logger.warn(`Auto-review pass skipped repo ${repo.id}: ${errorName(error)}`);
      return 0;
    }
  }

  /** The repo page only returns rows with an installation id; a row that lost one has nothing to mint with. */
  private installationId(repo: FleetRepoRecord): bigint {
    if (repo.githubInstallationId === null) throw new RepoCheckException('app_not_installed');
    return repo.githubInstallationId;
  }
}
