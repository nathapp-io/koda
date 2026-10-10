import type { IFleetConfig } from '../../config/fleet.config';
import type { AssignPayload, GitIdentity } from '../common/protocol';
import type { FleetJobRecord, FleetRepoRef } from './domain/fleet-job.domain';
import type { ThreadAssign } from '../common/thread-jobs';

/**
 * Plan D17: the App bot for GitHub, the configured bot for GitLab.
 *
 * When `githubAppSlug` is undefined (an unconfigured GitHub App, or a self-hosted GitHub
 * Enterprise fleet without App credentials), the GitHub bot identity falls back to
 * `koda-fleet[bot]` — the **same string** the GitLab branch uses for its default
 * (`FLEET_GITLAB_BOT_NAME` default `koda-fleet`). That is safe only because an unconfigured
 * GitHub App cannot dispatch to a GitHub repo in the first place; a single koda instance
 * cannot serve both forges with the same bot identity. Documented here so a future
 * maintainer who introduces a cross-provider repo flow doesn't end up with one author
 * identity for two distinct forges.
 */
export function gitIdentityFor(
  provider: 'github' | 'gitlab',
  cfg: Pick<IFleetConfig, 'githubAppSlug' | 'gitlabBotName' | 'gitlabBotEmail'>,
): GitIdentity {
  if (provider === 'gitlab') return { name: cfg.gitlabBotName, email: cfg.gitlabBotEmail };
  const bot = `${cfg.githubAppSlug ?? 'koda-fleet'}[bot]`;
  return { name: bot, email: `${bot}@users.noreply.github.com` };
}

export function buildAssignPayload(job: FleetJobRecord, repo: FleetRepoRef, cloneUrl: string, gitIdentity: GitIdentity, thread?: ThreadAssign): AssignPayload {
  return {
    jobId: job.id,
    command: job.command,
    repo: { provider: repo.provider, owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch, cloneUrl },
    ref: job.ref,
    feature: job.feature,
    planFrom: job.planFrom,
    profiles: [...job.profiles],
    maxCostUsd: job.maxCostUsd,
    bashMode: job.bashMode,
    approvalTimeoutSec: job.approvalTimeoutSec,
    gitIdentity,
    ...(thread ? { thread } : {}),
  };
}
