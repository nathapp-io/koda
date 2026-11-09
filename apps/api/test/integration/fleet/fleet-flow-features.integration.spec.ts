import type { NathApplication } from '@nathapp/nestjs-app';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import type { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { FleetFlowsService } from '../../../src/fleet/flows/fleet-flows.service';
import { FleetFlowTicker } from '../../../src/fleet/flows/fleet-flow.ticker';
import { GitHubAppClient } from '../../../src/fleet/git-broker/github-app-client';
import type { VcsPrStatus } from '../../../src/vcs/types';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { insertRunner, seedFleetBase } from '../../helpers/fleet-fixtures';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const integration = canRunDbTests() ? describe : describe.skip;

// Every sha differs, so a base read from the wrong place is visible in the assertions.
const SPEC_SHA = 'a'.repeat(40);
const SET_SHA = 'c'.repeat(40);
const MOVED_FLOW_HEAD = 'd'.repeat(40);
const DEFAULT_HEAD = 'e'.repeat(40);
const PLAN_SHA = (feature: string): string => (feature === 'a' ? '1' : '2').repeat(40);
const RUN_SHA = (feature: string): string => (feature === 'a' ? '3' : '4').repeat(40);
const PR_NUMBER = (feature: string): number => (feature === 'a' ? 11 : 12);

const FLOW_BRANCH = 'feat/a';
const specPath = (feature: string): string => `.nax/features/${feature}/spec.md`;
const base = new Date('2026-11-07T12:00:00.000Z');
const approvedAt = new Date(base.getTime() - 120_000);

type StepName = 'SPEC_REVIEW' | 'PLAN' | 'PRD_REVIEW' | 'RUN' | 'REVIEW' | 'FIX';

integration('two-feature fleet flows through tick against PG with a stubbed forge', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let ticker: FleetFlowTicker;
  let github: GitHubAppClient;
  let projectId: string;
  let repoId: string;
  let creatorId: string;
  let approverId: string;
  let runnerId: string;
  let repoName: string;
  let heads: Record<string, string>;
  let pullRequest: Partial<VcsPrStatus>;
  let inTransactionProbes: boolean[];
  let tickNo: number;

  beforeAll(async () => {
    // Only explicit ticks may progress the fixtures in this suite.
    vi.stubEnv('FLEET_SWEEP_ENABLED', 'false');
    vi.stubEnv('OUTBOX_RELAY_ENABLED', 'false');
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    ({ projectId, repoId, adminId: creatorId } = await seedFleetBase(db));
    approverId = (await db.user.create({ data: { email: 'features-approver@koda.test', passwordHash: 'x' } })).id;
    runnerId = (await insertRunner(db, { createdById: creatorId })).id;
    repoName = (await db.fleetRepo.findUniqueOrThrow({ where: { id: repoId } })).name;
    ticker = app.get(FleetFlowTicker);
    github = app.get(GitHubAppClient);
  }, 60_000);

  afterAll(async () => {
    try { await app?.close(); } finally { vi.unstubAllEnvs(); }
  });

  afterEach(() => {
    // Restore only this suite's forge overrides; test-setup's shared Logger spies stay intact.
    for (const method of FORGE_METHODS) vi.mocked(github[method]).mockRestore();
  });

  beforeEach(async () => {
    await db.fleetPrReview.deleteMany({ where: { repoId } });
    await db.fleetJob.deleteMany({ where: { projectId } });
    await db.fleetFlowFeature.deleteMany();
    await db.fleetFlow.deleteMany();
    await db.outboxEvent.deleteMany();
    heads = { [FLOW_BRANCH]: SPEC_SHA, main: DEFAULT_HEAD };
    pullRequest = { state: 'open', merged: false };
    inTransactionProbes = [];
    tickNo = 0;
    const probe = () => {
      inTransactionProbes.push(app.get<ITransactionManager>(TRANSACTION_MANAGER).isInTransaction());
    };
    const token = (value: string) => async () => { probe(); return { token: value, expiresAt: base }; };
    vi.spyOn(github, 'mintReadOnlyToken').mockImplementation(token('test-read-token'));
    vi.spyOn(github, 'mintInstallationToken').mockImplementation(token('test-write-token'));
    vi.spyOn(github, 'mintThreadReadToken').mockImplementation(token('test-thread-token'));
    vi.spyOn(github, 'getBranchHead').mockImplementation(async (_token, _owner, _name, branch) => {
      probe();
      const head = heads[branch];
      if (head === undefined) throw new Error(`unstubbed branch ${branch}`);
      return head;
    });
    vi.spyOn(github, 'getFile').mockImplementation(async () => {
      probe(); return { sha: 'blob1', size: 7, content: Buffer.from('# Spec\n') };
    });
    vi.spyOn(github, 'createBranch').mockImplementation(async () => { probe(); return { kind: 'created' }; });
    vi.spyOn(github, 'getPullRequest').mockImplementation(async (_token, _owner, _name, number) => {
      probe();
      return {
        number, state: 'open', draft: false, merged: false, mergedAt: null, mergedBy: null, mergeSha: null,
        url: `https://github.com/acme/${repoName}/pull/${number}`, title: 'feature', ...pullRequest,
      };
    });
  });

  /** An approved, running nax-entry flow of features a and b, as the approval path leaves it. */
  async function seedFlow(bDependsOn: string[]) {
    const { flow } = await withTestActor({ type: 'USER', id: creatorId }, () => app.get(FleetFlowsService).create({
      entry: 'NAX', repoId, branch: FLOW_BRANCH, specSha: SPEC_SHA,
      features: [
        { feature: 'a', specPath: specPath('a'), dependsOn: [] },
        { feature: 'b', specPath: specPath('b'), dependsOn: bDependsOn },
      ],
      roles: { reviewer: 'acp:claude', supervisor: 'native:fast' }, costCapUsd: '25',
    }, { type: 'USER', id: creatorId }, { projectId, now: approvedAt }));
    // The set sha is the approved set's head: keep it apart from the spec sha so a wrong base shows.
    await db.fleetFlow.update({ where: { id: flow.id }, data: {
      state: 'APPROVED', approvalMode: 'REQUEST', approverId, approvedAt, pinnedRunnerId: runnerId, setSha: SET_SHA,
    } });
    const features = await db.fleetFlowFeature.findMany({ where: { flowId: flow.id }, orderBy: { position: 'asc' }, take: 3 });
    return { flowId: flow.id, a: features[0], b: features[1] };
  }

  const tick = (): Promise<void> => ticker.tick(new Date(base.getTime() + (++tickNo) * 1_000));

  async function jobFor(flowId: string, featureId: string, step: StepName) {
    const jobs = await db.fleetJob.findMany({ where: { flowId, flowFeatureId: featureId, flowStep: step }, take: 3 });
    expect(jobs).toHaveLength(1);
    return jobs[0];
  }

  /** The test plays the runner and the ingest: it settles the job the engine dispatched. */
  async function settle(jobId: string, data: Prisma.FleetJobUncheckedUpdateInput = {}): Promise<void> {
    await db.fleetJob.update({ where: { id: jobId }, data: { state: 'COMPLETED', finishedAt: new Date(), ...data } });
  }

  const verdict = (): Prisma.FleetJobUncheckedUpdateInput => ({
    agentResult: { status: 'completed', output: JSON.stringify({ findings: [] }),
      truncated: false, deniedAsks: [], deniedAsksTruncated: false },
  });

  /** One tick dispatches the step for the feature; the test then settles it with the step's result. */
  async function runStep(flowId: string, feature: { id: string; feature: string }, step: StepName, branch: string) {
    await tick();
    const job = await jobFor(flowId, feature.id, step);
    const result: Record<StepName, Prisma.FleetJobUncheckedUpdateInput> = {
      SPEC_REVIEW: verdict(),
      PRD_REVIEW: verdict(),
      PLAN: { resultBranch: branch, resultSha: PLAN_SHA(feature.feature) },
      RUN: {
        resultBranch: branch, resultSha: RUN_SHA(feature.feature),
        resultPrUrl: `https://github.com/acme/${repoName}/pull/${PR_NUMBER(feature.feature)}`,
      },
      REVIEW: {},
      FIX: { fixReady: { markedReady: true } },
    };
    await settle(job.id, result[step]);
    return job;
  }

  /** Feature a, from the set review to the ready FIX; the tick after it marks the feature READY. */
  async function runFirstFeature(flowId: string, a: { id: string; feature: string }) {
    const jobs = [];
    for (const step of ['SPEC_REVIEW', 'PLAN', 'PRD_REVIEW', 'RUN', 'REVIEW', 'FIX'] as const) {
      jobs.push(await runStep(flowId, a, step, FLOW_BRANCH));
    }
    return jobs;
  }

  const flowRow = (id: string) => db.fleetFlow.findUniqueOrThrow({ where: { id } });
  const featureRow = (id: string) => db.fleetFlowFeature.findUniqueOrThrow({ where: { id } });

  function expectForgeOutsideTransaction(): void {
    expect(inTransactionProbes.length).toBeGreaterThan(0);
    expect(inTransactionProbes.every((inTransaction) => inTransaction === false)).toBe(true);
  }

  it('AC-1/AC-2/AC-3/AC-7: an independent b starts at the ready PR of a, on its own branch from the set sha', async () => {
    const { flowId, a, b } = await seedFlow([]);

    // AC-1: a runs the six steps, every job carrying a's feature id.
    const jobs = await runFirstFeature(flowId, a);
    expect(jobs.map((job) => job.flowStep)).toEqual(['SPEC_REVIEW', 'PLAN', 'PRD_REVIEW', 'RUN', 'REVIEW', 'FIX']);
    expect(jobs.map((job) => job.flowFeatureId)).toEqual(Array(6).fill(a.id));
    expect(await db.fleetJob.count({ where: { flowId } })).toBe(6);

    // AC-2: the ready FIX makes a READY, the flow stays RUNNING and nothing is dispatched for b yet.
    // The flow branch has moved on from the approved spec, which must not hold b back.
    heads[FLOW_BRANCH] = MOVED_FLOW_HEAD;
    expect(MOVED_FLOW_HEAD).not.toBe((await flowRow(flowId)).specSha);
    await tick();
    expect(await featureRow(a.id)).toMatchObject({ state: 'READY', prNumber: PR_NUMBER('a') });
    expect(await flowRow(flowId)).toMatchObject({ state: 'RUNNING' });
    expect(github.createBranch).not.toHaveBeenCalled();

    await tick();
    expect(github.createBranch).toHaveBeenCalledExactlyOnceWith(
      'test-write-token', 'acme', repoName, 'feat/b', SET_SHA,
    );
    expect(await featureRow(b.id)).toMatchObject({ state: 'RUNNING', branch: 'feat/b' });
    expect(await flowRow(flowId)).toMatchObject({ specSha: SPEC_SHA, setSha: SET_SHA, state: 'RUNNING' });
    expect(await db.fleetJob.count({ where: { flowId, flowFeatureId: b.id } })).toBe(0);

    await tick();
    const plan = await jobFor(flowId, b.id, 'PLAN');
    expect(plan).toMatchObject({ flowFeatureId: b.id, ref: 'feat/b', command: 'PLAN', feature: 'b' });
    await settle(plan.id, { resultBranch: 'feat/b', resultSha: PLAN_SHA('b') });

    // AC-3: b runs to its ready FIX and the flow completes with both features COMPLETED.
    await runStep(flowId, b, 'PRD_REVIEW', 'feat/b');
    await runStep(flowId, b, 'RUN', 'feat/b');
    await runStep(flowId, b, 'REVIEW', 'feat/b');
    await runStep(flowId, b, 'FIX', 'feat/b');
    for (const step of ['PRD_REVIEW', 'RUN', 'REVIEW', 'FIX'] as const) {
      expect((await jobFor(flowId, b.id, step)).flowFeatureId).toBe(b.id);
    }
    await tick();

    expect(await flowRow(flowId)).toMatchObject({ state: 'COMPLETED', stopReason: null });
    expect(await featureRow(a.id)).toMatchObject({ state: 'COMPLETED' });
    expect(await featureRow(b.id)).toMatchObject({ state: 'COMPLETED' });
    // AC-7
    expectForgeOutsideTransaction();
  });

  /** Flow of a and a dependent b, driven until a's ready FIX has made the flow wait for a's merge. */
  async function reachWaitingMerge() {
    const seeded = await seedFlow(['a']);
    await runFirstFeature(seeded.flowId, seeded.a);
    heads[FLOW_BRANCH] = MOVED_FLOW_HEAD;
    await tick();
    return seeded;
  }

  it('AC-4/AC-5/AC-7: a dependent b waits for the merge of a, then starts from the default branch head', async () => {
    const { flowId, a, b } = await reachWaitingMerge();

    // AC-4: a is READY, the flow waits for its merge, and an open PR changes nothing.
    expect(await featureRow(a.id)).toMatchObject({ state: 'READY' });
    expect(await flowRow(flowId)).toMatchObject({ state: 'WAITING_MERGE' });
    await tick();
    expect(github.getPullRequest).toHaveBeenCalledWith('test-thread-token', 'acme', repoName, PR_NUMBER('a'));
    expect(await flowRow(flowId)).toMatchObject({ state: 'WAITING_MERGE', stopReason: null });
    expect(await featureRow(a.id)).toMatchObject({ state: 'READY' });
    expect(github.createBranch).not.toHaveBeenCalled();

    // AC-5: a merged PR marks a MERGED and resumes the flow; the next tick starts b at the default head.
    pullRequest = { state: 'closed', merged: true };
    await tick();
    expect(await featureRow(a.id)).toMatchObject({ state: 'MERGED' });
    expect(await flowRow(flowId)).toMatchObject({ state: 'RUNNING' });
    expect(github.createBranch).not.toHaveBeenCalled();

    await tick();
    expect(github.createBranch).toHaveBeenCalledExactlyOnceWith(
      'test-write-token', 'acme', repoName, 'feat/b', DEFAULT_HEAD,
    );
    expect(github.getBranchHead).toHaveBeenCalledWith('test-write-token', 'acme', repoName, 'main');
    expect(await featureRow(b.id)).toMatchObject({ state: 'RUNNING', branch: 'feat/b' });
    // AC-7
    expectForgeOutsideTransaction();
  });

  it('AC-6/AC-7: a PR closed without a merge stops the waiting flow pr_closed, persisted on the row', async () => {
    const { flowId, a, b } = await reachWaitingMerge();
    expect(await flowRow(flowId)).toMatchObject({ state: 'WAITING_MERGE' });

    pullRequest = { state: 'closed', merged: false };
    await tick();

    expect(await flowRow(flowId)).toMatchObject({
      state: 'STOPPED', stopReason: 'pr_closed', stopDetail: `PR #${PR_NUMBER('a')} closed without merge`,
    });
    // The stop is the flow's: a never became MERGED and b never got a branch or a job.
    expect(await featureRow(a.id)).not.toMatchObject({ state: 'MERGED' });
    expect(await featureRow(b.id)).toMatchObject({ branch: null });
    expect(await db.fleetJob.count({ where: { flowId, flowFeatureId: b.id } })).toBe(0);
    expect(github.createBranch).not.toHaveBeenCalled();
    // A stopped flow is not advanced again.
    await tick();
    expect(await flowRow(flowId)).toMatchObject({ state: 'STOPPED', stopReason: 'pr_closed' });
    // AC-7
    expectForgeOutsideTransaction();
  });
});

const FORGE_METHODS = [
  'mintReadOnlyToken', 'mintInstallationToken', 'mintThreadReadToken',
  'getBranchHead', 'getFile', 'createBranch', 'getPullRequest',
] as const;
