import type { ITransactionManager } from '@nathapp/nestjs-data';
import type { AuditRecorder } from '../../audit/audit-recorder.service';
import type { FleetActivityService } from '../activity/fleet-activity.service';
import type { GitHubAppClient } from '../git-broker/github-app-client';
import { RepoCheckException, type RepoCheckReason } from '../git-broker/repo-check.exception';
import type { FleetReposService } from '../repos/fleet-repos.service';
import type { FleetFlowFeatureRecord, FleetFlowRecord } from './domain/fleet-flow.domain';
import type { IFleetFlowStepRepository } from './domain/fleet-flow-step.domain';
import { callsOutcomeForForgeError } from './flow-calls';
import { nextFlowFeature } from './flow-features';
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
  /**
   * US-012: the merge watch's re-read. It takes the parent and flow locks like `lockLive`, but it
   * only answers for a flow that still waits for the same approval: null when the flow stopped,
   * was approved again or resumed meanwhile.
   */
  lockWaitingMerge: (previous: FleetFlowRecord) => Promise<FleetFlowRecord | null>;
  /**
   * US-012: writes the stop of a flow the caller already holds the locks for, with the activity,
   * the audit entry and the outbox event every other stop carries.
   */
  stopLocked: (
    flow: FleetFlowRecord,
    feature: FleetFlowFeatureRecord,
    reason: FlowStopReason,
    detail: string,
    now: Date,
  ) => Promise<void>;
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

/** US-012: the flow that waits for a merge, and the moment the pass runs at. */
export interface MergeWatchInput {
  flow: FleetFlowRecord;
  now: Date;
}

/**
 * What one merge watch did. `watched` carries the features it marked merged, `idle` means the
 * flow waits for nothing this pass can poll, and `retry` means a transient forge failure: the
 * next tick polls again.
 */
export type MergeWatchOutcome =
  | { kind: 'watched'; merged: string[] }
  | { kind: 'idle' }
  | { kind: 'retry' };

/** The stop a merge watch refuses a flow with, and the feature it names. */
interface MergeWatchStop {
  reason: FlowStopReason;
  detail: string;
  feature: FleetFlowFeatureRecord;
}

/** What the pass saw: the features whose PR merged, and the stop it refuses the flow with. */
interface MergeWatchObservation {
  merged: FleetFlowFeatureRecord[];
  stop: MergeWatchStop | null;
}

/** One awaited feature and the PR the pass polls for it. */
interface AwaitedPr {
  feature: FleetFlowFeatureRecord;
  prNumber: number;
}

/**
 * US-012: the merge watch of a flow that waits for a merge.
 *
 * The pass runs outside any transaction: it mints one read token and polls the PR of every awaited
 * feature. A merged PR marks its feature MERGED, a PR that was closed without a merge (or that is
 * gone) stops the flow, and an open PR changes nothing. The merges and the stop are written under
 * the flow locks, and only while the flow still waits for the same approval. The pass never
 * dispatches: a flow that resumes waits for the next pass to start the next feature.
 */
export async function runMergeWatch(
  deps: FeaturePassDeps,
  input: MergeWatchInput,
): Promise<MergeWatchOutcome> {
  const { flow, now } = input;
  const awaited = awaitedFeatures(flow);
  const [first] = awaited;
  if (first === undefined) return { kind: 'idle' };

  // A repo that is not connected to a forge cannot be watched at all.
  const repo = await deps.repos.findReviewRepo(flow.repoId);
  if (!repo || repo.githubInstallationId === null) {
    await recordMergeWatch(deps, flow, {
      merged: [],
      stop: { reason: 'dispatch_refused', detail: 'repo not connected', feature: first },
    }, now);
    return { kind: 'watched', merged: [] };
  }

  // A feature without a PR number has nothing to watch.
  const withoutPr = awaited.find((feature) => feature.prNumber === null);
  if (withoutPr) {
    await recordMergeWatch(deps, flow, {
      merged: [],
      stop: { reason: 'dispatch_refused', detail: `feature ${withoutPr.feature} has no PR`, feature: withoutPr },
    }, now);
    return { kind: 'watched', merged: [] };
  }

  const targets: AwaitedPr[] = [];
  for (const feature of awaited) {
    if (feature.prNumber === null) continue;
    targets.push({ feature, prNumber: feature.prNumber });
  }
  const polled = await pollAwaited(deps, repo, targets);
  if (polled.kind === 'retry') return { kind: 'retry' };
  await recordMergeWatch(deps, flow, polled.observation, now);
  return { kind: 'watched', merged: polled.observation.merged.map((feature) => feature.id) };
}

/**
 * The features the flow waits for: the named dependencies that are not merged yet, in the order
 * the features run.
 */
export function awaitedFeatures(flow: FleetFlowRecord): FleetFlowFeatureRecord[] {
  const next = nextFlowFeature(flow.features);
  if (next.kind !== 'wait_merge') return [];
  const ids = new Set(next.featureIds);
  return [...flow.features]
    .filter((feature) => ids.has(feature.id) && feature.state !== 'MERGED')
    .sort((left, right) => left.position - right.position);
}

/** Select the feature whose work most directly caused a flow-level failure. */
export function failureStopFeature(flow: FleetFlowRecord): FleetFlowFeatureRecord {
  const ordered = [...flow.features].sort((left, right) => left.position - right.position);
  const active = nextFlowFeature(ordered);
  const selected = flow.state === 'WAITING_MERGE'
    ? awaitedFeatures(flow)[0]
    : active.kind === 'active' ? ordered.find((feature) => feature.id === active.featureId) : undefined;
  const fallback = ordered[0];
  const feature = selected ?? fallback;
  if (!feature) throw new Error(`Flow ${flow.id} has no features to stop`);
  return feature;
}

/**
 * The forge half of the watch: one read token for every PR, and one read per awaited feature. The
 * results are collected before anything is decided, so a merged PR is recorded even when another
 * PR of the same pass refuses the flow.
 */
async function pollAwaited(
  deps: FeaturePassDeps,
  repo: { owner: string; name: string; githubInstallationId: bigint },
  targets: AwaitedPr[],
): Promise<{ kind: 'observed'; observation: MergeWatchObservation } | { kind: 'retry' }> {
  const [first] = targets;
  if (first === undefined) return { kind: 'observed', observation: { merged: [], stop: null } };

  let token: string;
  try {
    ({ token } = await deps.github.mintThreadReadToken(repo.githubInstallationId, repo.name));
  } catch (error) {
    if (!(error instanceof RepoCheckException)) throw error;
    const stop = stopForForgeError(error.reason, first.feature);
    return stop === null
      ? { kind: 'retry' }
      : { kind: 'observed', observation: { merged: [], stop } };
  }

  const settled = await Promise.allSettled(targets.map((target) =>
    deps.github.getPullRequest(token, repo.owner, repo.name, target.prNumber)));
  const merged: FleetFlowFeatureRecord[] = [];
  let stop: MergeWatchStop | null = null;
  for (const [index, outcome] of settled.entries()) {
    const target = targets[index];
    if (target === undefined) continue;
    if (outcome.status === 'rejected') {
      const error = outcome.reason;
      if (!(error instanceof RepoCheckException)) throw error;
      // A transient failure writes nothing: the next tick polls the same PRs again.
      if (callsOutcomeForForgeError(error.reason) === 'retry') return { kind: 'retry' };
      stop ??= { reason: 'dispatch_refused', detail: error.reason, feature: target.feature };
      continue;
    }
    const pr = outcome.value;
    if (pr === null) {
      stop ??= { reason: 'pr_closed', detail: `PR #${target.prNumber} not found`, feature: target.feature };
      continue;
    }
    if (pr.merged) {
      merged.push(target.feature);
      continue;
    }
    if (pr.state === 'closed') {
      stop ??= { reason: 'pr_closed', detail: `PR #${target.prNumber} closed without merge`, feature: target.feature };
    }
  }
  return { kind: 'observed', observation: { merged, stop } };
}

/**
 * A permanent installation failure stops the flow; every other reason waits for the next tick.
 */
function stopForForgeError(reason: RepoCheckReason, feature: FleetFlowFeatureRecord): MergeWatchStop | null {
  return callsOutcomeForForgeError(reason) === 'failed'
    ? { reason: 'dispatch_refused', detail: reason, feature }
    : null;
}

/**
 * The locked half of the watch: the merges and the stop, and the resume of a flow whose next
 * feature can start. A flow that stopped, was approved again or resumed meanwhile owns nothing of
 * this pass: the merges it saw are dropped with it.
 */
async function recordMergeWatch(
  deps: FeaturePassDeps,
  flow: FleetFlowRecord,
  observation: MergeWatchObservation,
  now: Date,
): Promise<void> {
  if (observation.merged.length === 0 && observation.stop === null) return;
  await deps.txManager.run(async () => {
    const current = await deps.lockWaitingMerge(flow);
    if (!current) return;
    const merged = observation.merged.filter((feature) =>
      current.features.some((item) => item.id === feature.id && item.state !== 'MERGED'));
    for (const feature of merged) {
      await deps.steps.markFeatureState(feature.id, 'MERGED');
    }
    if (observation.stop) {
      await deps.stopLocked(current, observation.stop.feature, observation.stop.reason, observation.stop.detail, now);
      return;
    }
    const updated = current.features.map((item) =>
      merged.some((feature) => feature.id === item.id) ? { ...item, state: 'MERGED' } : item);
    // The next feature can start now: the flow resumes, and the next pass starts the feature.
    if (nextFlowFeature(updated).kind !== 'start') return;
    await deps.steps.setFlowState(current.id, 'RUNNING');
    await deps.audit.record({
      key: 'system.flow.advance', resourceType: 'flow', resourceId: current.id,
      projectId: current.projectId, summary: 'flow resumed',
    });
    await deps.activity.record({
      actorType: 'SYSTEM', actorId: 'flow', action: 'flow.resumed',
      entityType: 'flow', entityId: current.id, projectId: current.projectId,
      payload: { merged: merged.map((feature) => feature.feature) },
    });
  });
}
