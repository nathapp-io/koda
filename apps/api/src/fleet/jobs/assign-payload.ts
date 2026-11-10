import type { IFleetConfig } from '../../config/fleet.config';
import type { AssignPayload, GitIdentity, RuleOverrideAssign } from '../common/protocol';
import type { FleetJobRecord, FleetRepoRef } from './domain/fleet-job.domain';
import type { ThreadAssign } from '../common/thread-jobs';
import { prNumberOfReviewFeature } from '../common/review-jobs';
import type { FleetJobKind } from '../../common/enums';

/**
 * US-008 (#370): the nax commands a repo's rule override travels with. A THREAD turn and a config job
 * never carry one (the designer's call, 2026-11-10): a thread turn is not a nax run of its own, and a
 * config job edits configuration instead of running nax.
 */
const RULE_OVERRIDE_COMMANDS: readonly FleetJobKind[] = ['RUN', 'PLAN', 'REVIEW', 'FIX', 'AGENT'];

/** The commands a repo's rule override travels with; placement reads the override for these only. */
export function carriesRuleOverride(command: FleetJobKind): boolean {
  return RULE_OVERRIDE_COMMANDS.includes(command);
}

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

export function buildAssignPayload(
  job: FleetJobRecord,
  repo: FleetRepoRef,
  cloneUrl: string,
  gitIdentity: GitIdentity,
  thread?: ThreadAssign,
  ruleOverride?: RuleOverrideAssign | null,
): AssignPayload {
  const hasReview = job.command === 'REVIEW' || job.command === 'FIX';
  const reviewPrNumber = hasReview ? prNumberOfReviewFeature(job.feature) : null;
  if (hasReview && reviewPrNumber === null) throw new Error('invalid review feature');
  // US-005: an AGENT job runs the dispatch input's agent, not a PR review, so it carries an `agent` block and
  // never a `review` one. A row without its input would send an ASSIGN the runner cannot run, so refuse it the
  // way a malformed REVIEW feature is refused: placement rolls back and the job waits instead.
  const isAgent = job.command === 'AGENT';
  if (isAgent && !job.agentInput) throw new Error('invalid agent input');
  const agentInput = job.agentInput;
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
    ...(reviewPrNumber !== null ? {
      review: {
        prNumber: reviewPrNumber, botLogin: gitIdentity.name,
        ...(Array.isArray(job.reviewDecisions) && job.reviewDecisions.length > 0 ? { decisions: job.reviewDecisions } : {}),
        ...(job.command === 'FIX' && repo.fixTrustDetectedChecks === true ? { trustDetectedChecks: true as const } : {}),
        ...(job.command === 'FIX' && job.prRulings && 'rulings' in job.prRulings && job.prRulings.rulings.length > 0 ? {
          rulings: {
            headSha: job.prRulings.headSha,
            rulings: job.prRulings.rulings.map(({ item, ruling, by, at }) => ({ item, ruling, by, at })),
          },
        } : {}),
      },
    } : {}),
    ...(thread ? { thread } : {}),
    ...(isAgent ? { agent: { ...agentInput } } : {}),
    // US-008 (#370): the repo's rule override, read when the job was assigned. Only a nax job carries
    // one, and only when the repo has an override at all.
    ...(ruleOverride !== null && ruleOverride !== undefined && carriesRuleOverride(job.command)
      ? { ruleOverride }
      : {}),
    // US-004: a flow PLAN job has no thread but does know the branch it must write, so it gets the same
    // expectation a thread PLAN sends; every other command never does.
    ...(job.command === 'PLAN' && (job.threadId || job.flowId) ? { expectBranch: job.ref } : {}),
  };
}
