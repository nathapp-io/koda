import type { ITransactionManager } from '@nathapp/nestjs-data';
import type { AuditRecorder } from '../../audit/audit-recorder.service';
import type { FleetActivityService } from '../activity/fleet-activity.service';
import type { GitHubAppClient } from '../git-broker/github-app-client';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import type { FleetReposService } from '../repos/fleet-repos.service';
import type { FleetFlowFeatureRecord, FleetFlowRecord } from './domain/fleet-flow.domain';
import type { IFleetFlowStepRepository } from './domain/fleet-flow-step.domain';
import { callsOutcomeForForgeError } from './flow-calls';
import type { FlowStopReason } from './flow-step-decision';

/**
 * The collaborators the feature passes work with. They are the advance service's own
 * dependencies: the passes live here, so the service stays their caller and not their host.
 */
export interface FeaturePassDeps {
  steps: IFleetFlowStepRepository;
  repos: FleetReposService;
  github: GitHubAppClient;
  activity: FleetActivityService;
  audit: AuditRecorder;
  txManager: ITransactionManager;
  /**
   * The parent and flow locks, with the approval generation rechecked: null when the flow
   * stopped, was approved again or is gone.
   */
  lockLive: (previous: FleetFlowRecord) => Promise<FleetFlowRecord | null>;
}

/** The base a later feature's branch is created at: the approved spec set, or the merged default branch. */
export type FeatureStartBase = 'spec' | 'default';

export interface FeatureStartInput {
  flow: FleetFlowRecord;
  feature: FleetFlowFeatureRecord;
  base: FeatureStartBase;
}

/** A refusal the caller writes under the flow locks, or a pass that waits for the next tick. */
export type FeatureStartRefusal =
  | { kind: 'retry' }
  | { kind: 'stop'; reason: FlowStopReason; detail: string };

/**
 * What one start attempt did. `retry` hands the feature back to the next tick without touching
 * flow state; a `stop` is a refusal the caller writes under the flow locks.
 */
export type FeatureStartOutcome =
  | { kind: 'started'; branch: string; sha: string }
  | FeatureStartRefusal;

/**
 * US-011: start a later feature on its own branch.
 *
 * The pass runs outside any transaction and mints one installation token for every forge call it
 * makes. It resolves the base the branch is created at, refuses a spec that is no longer the
 * approved one, creates `feat/<feature>` and records the branch under the flow locks.
 */
export async function runFeatureStart(
  deps: FeaturePassDeps,
  input: FeatureStartInput,
): Promise<FeatureStartOutcome> {
  const { flow, feature, base } = input;
  // A thread-entry flow runs one feature: the thread's published spec set is that one flow.
  if (flow.threadId !== null) {
    return { kind: 'stop', reason: 'dispatch_refused', detail: 'thread entry runs one feature' };
  }
  const repo = await deps.repos.findReviewRepo(flow.repoId);
  if (!repo || repo.githubInstallationId === null) {
    return { kind: 'stop', reason: 'dispatch_refused', detail: 'repo not connected' };
  }
  const branch = `feat/${feature.feature}`;
  const created = await createFeatureBranch(deps, repo, feature, branch, base, flow.setSha);
  if (created.kind !== 'created') return created;
  await recordFeatureStart(deps, flow, feature, { base, sha: created.sha, branch });
  return { kind: 'started', branch, sha: created.sha };
}

/** The forge half of the start: the branch of the feature exists at the base sha. */
type FeatureBranch =
  | { kind: 'created'; sha: string }
  | FeatureStartRefusal;

/**
 * The forge calls of the start pass, with one minted token for all of them. The token is never
 * persisted and never logged.
 */
async function createFeatureBranch(
  deps: FeaturePassDeps,
  repo: { owner: string; name: string; defaultBranch: string; githubInstallationId: bigint },
  feature: FleetFlowFeatureRecord,
  branch: string,
  base: FeatureStartBase,
  setSha: string,
): Promise<FeatureBranch> {
  try {
    const { token } = await deps.github.mintInstallationToken(repo.githubInstallationId, repo.name);
    // The approved set for a feature that depends on nothing, the merged default branch for one
    // whose dependency is already merged.
    const baseSha = base === 'default'
      ? await deps.github.getBranchHead(token, repo.owner, repo.name, repo.defaultBranch)
      : setSha;
    const approved = await specMatchesApproved(deps, token, repo.owner, repo.name, feature.specPath, baseSha, setSha);
    if (!approved) {
      return { kind: 'stop', reason: 'spec_changed', detail: `${feature.specPath} differs from the approved spec` };
    }
    const result = await deps.github.createBranch(token, repo.owner, repo.name, branch, baseSha);
    if (result.kind === 'refused') {
      return { kind: 'stop', reason: 'dispatch_refused', detail: `branch ${branch} not created` };
    }
    // A branch that already points at the base is this pass's own branch: a crash between the
    // creation and its record leaves it behind, and the repeat must not refuse the flow.
    if (result.kind === 'exists' && result.sha !== baseSha) {
      return { kind: 'stop', reason: 'dispatch_refused', detail: `branch ${branch} already exists` };
    }
    return { kind: 'created', sha: baseSha };
  } catch (error) {
    if (!(error instanceof RepoCheckException)) throw error;
    // A permanent installation failure stops the flow; anything else waits for the next tick.
    return callsOutcomeForForgeError(error.reason) === 'failed'
      ? { kind: 'stop', reason: 'dispatch_refused', detail: error.reason }
      : { kind: 'retry' };
  }
}

/**
 * The spec the feature builds from must be the approved one: the blob shas at the base and at the
 * set head must be the same, and the file must exist at both. A base that is the set head itself
 * is read once.
 */
async function specMatchesApproved(
  deps: FeaturePassDeps,
  token: string,
  owner: string,
  name: string,
  specPath: string,
  baseSha: string,
  setSha: string,
): Promise<boolean> {
  const atBase = await deps.github.getFile(token, owner, name, specPath, baseSha);
  if (!atBase) return false;
  const atSet = baseSha === setSha
    ? atBase
    : await deps.github.getFile(token, owner, name, specPath, setSha);
  return atSet !== null && atSet.sha === atBase.sha;
}

/**
 * The locked half of the start: the feature's branch and state, and the activity that records the
 * start. A flow that stopped, an approval that changed or a feature that already started drops the
 * progress: the branch exists, but this flow does not own it any more.
 */
async function recordFeatureStart(
  deps: FeaturePassDeps,
  flow: FleetFlowRecord,
  feature: FleetFlowFeatureRecord,
  started: { base: FeatureStartBase; sha: string; branch: string },
): Promise<void> {
  await deps.txManager.run(async () => {
    const current = await deps.lockLive(flow);
    if (!current) return;
    const selected = current.features.find(({ id }) => id === feature.id);
    if (!selected || selected.state !== 'PENDING') return;
    await deps.steps.setFeatureBranch(selected.id, started.branch);
    await deps.steps.markFeatureState(selected.id, 'RUNNING');
    await deps.audit.record({
      key: 'system.flow.advance', resourceType: 'flow', resourceId: current.id,
      projectId: current.projectId, summary: 'flow feature started',
    });
    await deps.activity.record({
      actorType: 'SYSTEM', actorId: 'flow', action: 'flow.feature_started',
      entityType: 'flow', entityId: current.id, projectId: current.projectId,
      payload: { feature: selected.feature, base: started.base, sha: started.sha, branch: started.branch },
    });
  });
}
