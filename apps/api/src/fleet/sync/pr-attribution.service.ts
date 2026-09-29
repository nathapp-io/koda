import { Inject, Injectable, Logger } from '@nestjs/common';
import { GitHubAppClient } from '../git-broker/github-app-client';
import { GitLabAccessChecker } from '../git-broker/gitlab-access-checker';
import { GitLabTokenSource } from '../git-broker/gitlab-token.source';
import { isTerminal } from '../jobs/job-state';
import { FLEET_JOB_REPOSITORY, FleetRepoRef, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';

const GITHUB_PR = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;
const GITLAB_MR = /^\/(.+)\/([^/]+)\/-\/merge_requests\/(\d+)\/?$/;

/** The PR/MR number, only when the URL path names this job's own repo (plan D19). */
export function prNumberFor(repo: Pick<FleetRepoRef, 'provider' | 'owner' | 'name'>, url: string): number | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const match = (repo.provider === 'github' ? GITHUB_PR : GITLAB_MR).exec(path);
  if (!match) return null;
  const same = (a: string, b: string) => decodeURIComponent(a).toLowerCase() === b.toLowerCase();
  return same(match[1], repo.owner) && same(match[2], repo.name) ? Number(match[3]) : null;
}

/** Spec §7.1: "Dispatched by <user> via koda job <id>", once per job; failures are logged, never thrown. */
@Injectable()
export class PrAttributionService {
  private readonly logger = new Logger(PrAttributionService.name);

  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: IFleetJobRepository,
    private readonly github: GitHubAppClient,
    private readonly gitlab: GitLabAccessChecker,
    private readonly gitlabTokens: GitLabTokenSource,
  ) {}

  async attribute(jobId: string, now = new Date()): Promise<'posted' | 'skipped' | 'failed'> {
    try {
      const job = await this.repo.findById(jobId);
      if (!job || !isTerminal(job.state) || !job.resultPrUrl) return 'skipped';
      const repo = await this.repo.findRepo(job.repoId);
      if (!repo) return 'skipped';
      const number = prNumberFor(repo, job.resultPrUrl);
      if (number === null) {
        this.logger.warn(`Job ${job.id}: resultPrUrl does not name ${repo.owner}/${repo.name}; no attribution`);
        return 'skipped';
      }
      if (!(await this.repo.claimAttribution(job.id, now))) return 'skipped';
      const who = (await this.repo.findUserDisplayName(job.requestedById)) ?? 'a koda user';
      const body = `Dispatched by ${who} via koda job ${job.id}`;
      const posted = repo.provider === 'github'
        ? repo.githubInstallationId !== null && (await this.github.commentOnPullRequest(repo.githubInstallationId, repo.owner, repo.name, number, body))
        : await this.gitlab.commentOnMergeRequest(repo.owner, repo.name, number, body, await this.gitlabTokens.resolve(repo.projectId, repo.owner, repo.name));
      if (!posted) this.logger.warn(`Job ${job.id}: attribution comment was not accepted`);
      return posted ? 'posted' : 'failed';
    } catch (error) {
      this.logger.warn(`Job ${jobId}: attribution failed (${error instanceof Error ? error.name : 'unknown'})`);
      return 'failed';
    }
  }
}
