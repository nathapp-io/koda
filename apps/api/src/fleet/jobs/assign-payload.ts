import type { IFleetConfig } from '../../config/fleet.config';
import type { AssignPayload, GitIdentity } from '../common/protocol';
import type { FleetJobRecord, FleetRepoRef } from './domain/fleet-job.domain';

/** Plan D17: the App bot for GitHub, the configured bot for GitLab. */
export function gitIdentityFor(
  provider: 'github' | 'gitlab',
  cfg: Pick<IFleetConfig, 'githubAppSlug' | 'gitlabBotName' | 'gitlabBotEmail'>,
): GitIdentity {
  if (provider === 'gitlab') return { name: cfg.gitlabBotName, email: cfg.gitlabBotEmail };
  const bot = `${cfg.githubAppSlug ?? 'koda-fleet'}[bot]`;
  return { name: bot, email: `${bot}@users.noreply.github.com` };
}

export function buildAssignPayload(job: FleetJobRecord, repo: FleetRepoRef, cloneUrl: string, gitIdentity: GitIdentity): AssignPayload {
  return {
    jobId: job.id,
    command: job.command,
    repo: { provider: repo.provider, owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch, cloneUrl },
    ref: job.ref,
    feature: job.feature,
    planFrom: job.planFrom,
    profiles: [...job.profiles],
    maxCostUsd: job.maxCostUsd,
    bashMode: 'raw',
    gitIdentity,
  };
}
