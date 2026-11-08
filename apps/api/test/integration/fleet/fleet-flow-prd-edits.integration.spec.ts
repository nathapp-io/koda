import { Logger } from '@nestjs/common';
import type { NathApplication } from '@nathapp/nestjs-app';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import type { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { FleetFlowsService } from '../../../src/fleet/flows/fleet-flows.service';
import { FleetFlowTicker } from '../../../src/fleet/flows/fleet-flow.ticker';
import { GitHubAppClient } from '../../../src/fleet/git-broker/github-app-client';
import { grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { insertRunner, seedFleetBase } from '../../helpers/fleet-fixtures';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const integration = canRunDbTests() ? describe : describe.skip;
const SHA = 'a'.repeat(40);
const FEATURE = 'manual-loop';
const SPEC = `.nax/features/${FEATURE}/spec.md`;
const PRD = `.nax/features/${FEATURE}/prd.json`;
const BRANCH = `feat/${FEATURE}`;
const now = new Date('2026-11-07T12:00:00.000Z');
const approvedAt = new Date(now.getTime() - 120_000);
const minor = { id: 'F1', class: 'minor', summary: 'Missing coverage note', fix: 'Document the retry case' };
const prdBefore = JSON.stringify({ userStories: [{ id: 'US-011', description: 'old description', acceptanceCriteria: ['Old criterion', 'Keep this'] }] });
const prdAfter = JSON.stringify({ userStories: [{ id: 'US-011', description: 'old description', acceptanceCriteria: ['Replacement criterion', 'Keep this'] }] }, null, 2) + '\n';

integration('manual fleet flow loop through ticker and persistence (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let ticker: FleetFlowTicker;
  let projectId: string;
  let repoId: string;
  let creatorId: string;
  let approverId: string;
  let runnerId: string;
  let repoName: string;
  let forgeHead: string;
  let specBytes: Buffer;
  let prdBytes: Buffer;
  let specBlob: string;
  let prdBlob: string;
  let commit: number;
  let github: GitHubAppClient;
  let forgeCallsOutsideTransaction: boolean[];

  beforeAll(async () => {
    vi.stubEnv('FLEET_SWEEP_ENABLED', 'false');
    vi.stubEnv('OUTBOX_RELAY_ENABLED', 'false');
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    ({ projectId, repoId, adminId: creatorId } = await seedFleetBase(db));
    approverId = (await db.user.create({ data: { email: 'flow-prd-edits-approver@koda.test', passwordHash: 'x' } })).id;
    await grantBaseline(db, { type: 'USER', id: approverId });
    await grantRole(db, { type: 'USER', id: approverId }, 'admin', null);
    runnerId = (await insertRunner(db, { createdById: creatorId })).id;
    repoName = (await db.fleetRepo.findUniqueOrThrow({ where: { id: repoId } })).name;
    ticker = app.get(FleetFlowTicker);
    github = app.get(GitHubAppClient);
  }, 60_000);

  afterAll(async () => {
    try { await app?.close(); } finally { vi.unstubAllEnvs(); }
  });
  afterEach(() => {
    for (const method of ['mintReadOnlyToken', 'mintInstallationToken', 'getBranchHead', 'getFile', 'putFile'] as const) {
      vi.mocked(github[method]).mockRestore();
    }
  });

  beforeEach(async () => {
    await db.fleetJob.deleteMany({ where: { projectId } });
    await db.fleetFlowFeature.deleteMany();
    await db.fleetFlow.deleteMany();
    await db.outboxEvent.deleteMany();
    forgeHead = SHA;
    specBytes = Buffer.from('# Spec\n');
    prdBytes = Buffer.from(prdBefore);
    specBlob = 'spec-blob-0';
    prdBlob = 'prd-blob-0';
    commit = 0;
    forgeCallsOutsideTransaction = [];
    const check = () => forgeCallsOutsideTransaction.push(!app.get<ITransactionManager>(TRANSACTION_MANAGER).isInTransaction());
    vi.spyOn(github, 'mintReadOnlyToken').mockImplementation(async () => { check(); return { token: 'test-read-token', expiresAt: now }; });
    vi.spyOn(github, 'mintInstallationToken').mockImplementation(async () => { check(); return { token: 'test-write-token', expiresAt: now }; });
    vi.spyOn(github, 'getBranchHead').mockImplementation(async () => { check(); return forgeHead; });
    vi.spyOn(github, 'getFile').mockImplementation(async (_token, _owner, _name, path) => {
      check();
      return path === PRD
        ? { sha: prdBlob, size: prdBytes.length, content: prdBytes }
        : { sha: specBlob, size: specBytes.length, content: specBytes };
    });
    vi.spyOn(github, 'putFile').mockImplementation(async (_token, _owner, _name, path, input) => {
      check();
      commit++;
      forgeHead = `commit-${commit}`;
      if (path === PRD) { prdBytes = input.content; prdBlob = `prd-blob-${commit}`; }
      else { specBytes = input.content; specBlob = `spec-blob-${commit}`; }
      return { kind: 'committed', commitSha: forgeHead };
    });
    vi.mocked(Logger.prototype.error).mockClear();
  });

  async function seedFlow(step: 'SPEC_REVIEW' | 'PRD_REVIEW' = 'SPEC_REVIEW') {
    const { flow } = await withTestActor({ type: 'USER', id: creatorId }, () => app.get(FleetFlowsService).create({
      entry: 'NAX', repoId, branch: BRANCH, specSha: SHA,
      features: [{ feature: FEATURE, specPath: SPEC, dependsOn: [] }],
      roles: { reviewer: 'acp:claude', supervisor: 'native:fast' }, costCapUsd: '25',
    }, { type: 'USER', id: creatorId }, { projectId, now: approvedAt }));
    await db.fleetFlow.update({ where: { id: flow.id }, data: {
      state: 'RUNNING', approvalMode: 'REQUEST', approverId, approvedAt, pinnedRunnerId: runnerId,
    } });
    await db.fleetFlowFeature.updateMany({ where: { flowId: flow.id }, data: { state: 'RUNNING', currentStep: step } });
    return flow;
  }

  function jobData(flowId: string): Prisma.FleetJobUncheckedCreateInput {
    return { projectId, repoId, flowId, ref: forgeHead, command: 'PLAN', feature: FEATURE, profiles: [], maxCostUsd: '10',
      selectorLabels: [], pinnedRunnerId: runnerId, requestedById: creatorId, state: 'COMPLETED' };
  }

  async function createCompletedReview(flowId: string, step: 'SPEC_REVIEW' | 'PRD_REVIEW', output: unknown) {
    return db.fleetJob.create({ data: {
      ...jobData(flowId), command: 'AGENT', flowStep: step,
      queuedAt: new Date(now.getTime() - 30_000), finishedAt: new Date(now.getTime() - 10_000),
      agentResult: { status: 'completed', output: JSON.stringify(output), truncated: false, deniedAsks: [], deniedAsksTruncated: false },
    } });
  }

  async function completeDispatchedJob(jobId: string, output: unknown, resultSha = forgeHead) {
    return db.fleetJob.update({ where: { id: jobId }, data: {
      state: 'COMPLETED', finishedAt: new Date(now.getTime() + 1_000), resultBranch: BRANCH, resultSha,
      agentResult: { status: 'completed', output: JSON.stringify(output), truncated: false, deniedAsks: [], deniedAsksTruncated: false },
    } });
  }

  it('AC-1–AC-8: runs both spec reviews, plans once, edits the PRD, records progress, then dispatches RUN', async () => {
    const flow = await seedFlow();
    const first = await createCompletedReview(flow.id, 'SPEC_REVIEW', { findings: [minor] });

    await ticker.tick(now);
    expect(github.putFile).toHaveBeenCalledTimes(1);
    expect(github.putFile).toHaveBeenCalledWith('test-write-token', 'acme', repoName, SPEC, expect.objectContaining({
      branch: BRANCH, blobSha: 'spec-blob-0', content: expect.any(Buffer),
      message: `docs(${FEATURE}): flow calls from SPEC_REVIEW job ${first.id}`,
    }));

    await ticker.tick(new Date(now.getTime() + 1_000));
    const reviewsAfterFirst = await db.fleetJob.findMany({ where: { flowId: flow.id, flowStep: 'SPEC_REVIEW' }, orderBy: { queuedAt: 'asc' }, take: 3 });
    expect(reviewsAfterFirst).toHaveLength(2);
    expect(reviewsAfterFirst[1]).toMatchObject({ flowId: flow.id, flowStep: 'SPEC_REVIEW', ref: forgeHead });
    expect(reviewsAfterFirst[1].id).not.toBe(first.id);

    await completeDispatchedJob(reviewsAfterFirst[1].id, { findings: [minor] }, forgeHead);
    await ticker.tick(new Date(now.getTime() + 2_000));
    expect(github.putFile).toHaveBeenCalledTimes(2);
    expect(github.putFile.mock.calls[1][3]).toBe(SPEC);

    await ticker.tick(new Date(now.getTime() + 3_000));
    const plan = await db.fleetJob.findFirstOrThrow({ where: { flowId: flow.id, flowStep: 'PLAN' } });
    expect(plan).toMatchObject({ flowId: flow.id, flowStep: 'PLAN' });
    expect(await db.fleetJob.count({ where: { flowId: flow.id, flowStep: 'SPEC_REVIEW' } })).toBe(2);

    await completeDispatchedJob(plan.id, { findings: [] }, forgeHead);
    await ticker.tick(new Date(now.getTime() + 4_000));
    const prdReview = await db.fleetJob.findFirstOrThrow({ where: { flowId: flow.id, flowStep: 'PRD_REVIEW' } });
    await completeDispatchedJob(prdReview.id, { findings: [], prdEdits: [{ story: 'US-011', op: 'replace_ac', old: 'Old criterion', new: 'Replacement criterion' }] }, forgeHead);

    await ticker.tick(new Date(now.getTime() + 5_000));
    expect(github.putFile).toHaveBeenCalledTimes(3);
    expect(github.putFile.mock.calls[2][3]).toBe(PRD);
    expect(github.putFile.mock.calls[2][4]).toMatchObject({ branch: BRANCH, blobSha: 'prd-blob-0' });
    expect(github.putFile.mock.calls[2][4].content.toString('utf8')).toBe(prdAfter);
    expect(await db.fleetFlowFeature.findFirstOrThrow({ where: { flowId: flow.id } })).toMatchObject({ prdEditsJobId: prdReview.id });
    const activity = await db.fleetActivity.findMany({ where: { entityId: flow.id, action: 'flow.prd_edits' }, take: 2 });
    expect(activity).toHaveLength(1);
    expect(activity[0].payload).toMatchObject({ jobId: prdReview.id, sha: forgeHead, applied: 1 });

    await ticker.tick(new Date(now.getTime() + 6_000));
    const run = await db.fleetJob.findFirstOrThrow({ where: { flowId: flow.id, flowStep: 'RUN' } });
    expect(run).toMatchObject({ flowId: flow.id, flowStep: 'RUN', command: 'RUN' });
    expect(forgeCallsOutsideTransaction.length).toBeGreaterThan(0);
    expect(forgeCallsOutsideTransaction.every(Boolean)).toBe(true);
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });

  it('AC-9: stops a malformed PRD edits verdict as unreadable', async () => {
    const flow = await seedFlow('PRD_REVIEW');
    await createCompletedReview(flow.id, 'PRD_REVIEW', { findings: [], prdEdits: {} });

    await ticker.tick(now);

    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } }))
      .toMatchObject({ state: 'STOPPED', stopReason: 'verdict_unreadable' });
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });
});
