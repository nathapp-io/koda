import { Logger } from '@nestjs/common';
import type { NathApplication } from '@nathapp/nestjs-app';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import type { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { FleetFlowsService } from '../../../src/fleet/flows/fleet-flows.service';
import { FleetFlowTicker } from '../../../src/fleet/flows/fleet-flow.ticker';
import { formatQuestionsComment, FLOW_CALL_TEXT_MAX } from '../../../src/fleet/flows/flow-calls';
import { GitHubAppClient } from '../../../src/fleet/git-broker/github-app-client';
import { FanOutPublisher } from '../../../src/outbox/fan-out-publisher';
import { grantBaseline, grantRole } from '../../../src/permissions/test-helpers/permission-fixtures';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { insertRunner, seedFleetBase } from '../../helpers/fleet-fixtures';
import { bootHttpApp } from '../../helpers/http-app';
import { outboxRecord } from '../../helpers/outbox-record';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const integration = canRunDbTests() ? describe : describe.skip;
const SHA = 'a'.repeat(40);
const FEATURE = 'answered-flow';
const SPEC = `.nax/features/${FEATURE}/spec.md`;
const BRANCH = `feat/${FEATURE}`;
const now = new Date('2026-11-07T12:00:00.000Z');
const approvedAt = new Date(now.getTime() - 120_000);
const minor = { id: 'F1', class: 'minor', summary: 'Missing coverage note', fix: 'Document the retry case' };
const ambiguous = { class: 'ambiguous', summary: 'Currency is undecided', question: 'Which currency should values use?' };

integration('answered fleet flows through tick and outbox (PG)', () => {
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
  let github: GitHubAppClient;
  let forgeCallsOutsideTransaction: boolean[];

  beforeAll(async () => {
    vi.stubEnv('FLEET_SWEEP_ENABLED', 'false');
    vi.stubEnv('OUTBOX_RELAY_ENABLED', 'false');
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    ({ projectId, repoId, adminId: creatorId } = await seedFleetBase(db));
    approverId = (await db.user.create({ data: { email: 'flow-answers-approver@koda.test', passwordHash: 'x' } })).id;
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
    forgeCallsOutsideTransaction = [];
    const check = () => forgeCallsOutsideTransaction.push(!app.get<ITransactionManager>(TRANSACTION_MANAGER).isInTransaction());
    vi.spyOn(github, 'mintReadOnlyToken').mockImplementation(async () => { check(); return { token: 'test-read-token', expiresAt: now }; });
    vi.spyOn(github, 'mintInstallationToken').mockImplementation(async () => { check(); return { token: 'test-write-token', expiresAt: now }; });
    vi.spyOn(github, 'getBranchHead').mockImplementation(async () => { check(); return forgeHead; });
    vi.spyOn(github, 'getFile').mockImplementation(async () => { check(); return { sha: 'blob1', size: 7, content: Buffer.from('# Spec\n') }; });
    vi.spyOn(github, 'putFile').mockImplementation(async () => { check(); return { kind: 'committed', commitSha: 'c2' }; });
    vi.mocked(Logger.prototype.error).mockClear();
  });

  async function seedReview(findings: unknown[] = [minor, ambiguous]) {
    const { flow } = await withTestActor({ type: 'USER', id: creatorId }, () => app.get(FleetFlowsService).create({
      entry: 'NAX', repoId, branch: BRANCH, specSha: SHA,
      features: [{ feature: FEATURE, specPath: SPEC, dependsOn: [] }],
      roles: { reviewer: 'acp:claude', supervisor: 'native:fast' }, costCapUsd: '25',
    }, { type: 'USER', id: creatorId }, { projectId, now: approvedAt }));
    await db.fleetFlow.update({ where: { id: flow.id }, data: {
      state: 'RUNNING', approvalMode: 'REQUEST', approverId, approvedAt, pinnedRunnerId: runnerId,
    } });
    await db.fleetFlowFeature.updateMany({ where: { flowId: flow.id }, data: { state: 'RUNNING', currentStep: 'SPEC_REVIEW' } });
    const job = await db.fleetJob.create({ data: {
      ...(await jobData(flow.id)), command: 'AGENT', flowStep: 'SPEC_REVIEW',
      queuedAt: new Date(now.getTime() - 30_000), finishedAt: new Date(now.getTime() - 10_000),
      agentResult: { status: 'completed', output: JSON.stringify({ findings }), truncated: false, deniedAsks: [], deniedAsksTruncated: false },
    } });
    return { flow, job };
  }

  /** A flow job belongs to the flow's feature (US-001), so the engine's per-feature reads find it. */
  async function jobData(flowId: string): Promise<Prisma.FleetJobUncheckedCreateInput> {
    const flowFeature = await db.fleetFlowFeature.findFirstOrThrow({ where: { flowId }, orderBy: { position: 'asc' } });
    return { projectId, repoId, flowId, flowFeatureId: flowFeature.id, ref: SHA, command: 'PLAN', feature: FEATURE, profiles: [], maxCostUsd: '10',
      selectorLabels: [], pinnedRunnerId: runnerId, requestedById: creatorId, state: 'COMPLETED' };
  }

  it('AC-1–AC-7: waits, publishes replay-safe questions, answers, commits calls, and dispatches the second review', async () => {
    const { flow, job } = await seedReview();
    await ticker.tick(now);

    const waiting = await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id }, include: { features: true } });
    expect(waiting.state).toBe('WAITING_ANSWER');
    expect(waiting.features[0]).toMatchObject({ state: 'WAITING_ANSWER', questionsJobId: job.id,
      questions: [{ id: '2', question: ambiguous.question }] });

    const eventId = `${flow.id}:questions:${job.id}`;
    const rows = await db.outboxEvent.findMany({ where: { projectId, type: 'fleet_flow_questions', eventId }, take: 2 });
    expect(rows).toHaveLength(1);
    await ticker.tick(new Date(now.getTime() + 1_000));
    expect(await db.outboxEvent.count({ where: { projectId, type: 'fleet_flow_questions', eventId } })).toBe(1);

    const row = rows[0];
    const payload: unknown = JSON.parse(row.payload);
    const record = outboxRecord(row.type, payload, {
      id: row.id, createdAt: row.createdAt, metadata: { projectId: row.projectId, eventId: row.eventId },
    });
    const publisher = app.get(FanOutPublisher);
    const expectedComment = formatQuestionsComment({ step: 'SPEC_REVIEW', jobId: job.id,
      questions: [{ id: '2', question: ambiguous.question }], answerPath: `/api/projects/${(await db.project.findUniqueOrThrow({ where: { id: projectId } })).slug}/flows/${flow.id}/answers` });
    await publisher.publish(record);

    const ticket = await db.ticket.findFirstOrThrow({ where: { projectId, title: `Fleet flow: ${FEATURE}` } });
    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).toMatchObject({ ticketId: ticket.id });
    const comments = await db.comment.findMany({ where: { ticketId: ticket.id }, take: 2 });
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe(expectedComment);
    const notificationWhere = { userId: approverId, sourceType: 'fleet_flow', sourceId: `${flow.id}:${job.id}`, kind: 'flow_questions' };
    const notifications = await db.notification.findMany({ where: notificationWhere, take: 2 });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ ...notificationWhere, projectId, category: 'FLEET_NEEDS_YOU' });

    await publisher.publish(record);
    expect(await db.comment.findMany({ where: { ticketId: ticket.id }, take: 2 })).toEqual(comments);
    expect(await db.notification.findMany({ where: notificationWhere, take: 2 })).toEqual(notifications);

    const answered = await withTestActor({ type: 'USER', id: creatorId }, () =>
      app.get(FleetFlowsService).answer(projectId, flow.id,
        { jobId: job.id, answers: [{ id: '2', answer: 'Use USD' }] }, { type: 'USER', id: creatorId }, now));
    expect(answered.state).toBe('RUNNING');
    expect(answered.features[0]).toMatchObject({ answers: [{ id: '2', answer: 'Use USD' }] });

    vi.mocked(github.putFile).mockClear();
    await ticker.tick(new Date(now.getTime() + 2_000));
    expect(github.putFile).toHaveBeenCalledTimes(1);
    const written = vi.mocked(github.putFile).mock.calls[0][4].content.toString('utf8');
    expect(written).toContain(`### SPEC_REVIEW job ${job.id}`);
    expect(written).toContain(`- **F1** (minor): ${minor.summary} Call: ${minor.fix}`);
    expect(written).toContain(`- **2** (answer): ${ambiguous.question} Answer: Use USD`);
    expect(await db.fleetFlowFeature.findFirstOrThrow({ where: { flowId: flow.id } })).toMatchObject({ callsJobId: job.id });

    forgeHead = 'c2';
    vi.mocked(github.getBranchHead).mockClear();
    await ticker.tick(new Date(now.getTime() + 3_000));
    const reviews = await db.fleetJob.findMany({ where: { flowId: flow.id, flowStep: 'SPEC_REVIEW' }, take: 3 });
    expect(reviews).toHaveLength(2);
    expect(reviews[1]).toMatchObject({ flowId: flow.id, flowStep: 'SPEC_REVIEW', command: 'AGENT', ref: 'c2' });
    expect(await db.fleetJob.count({ where: { flowId: flow.id, flowStep: 'PLAN' } })).toBe(0);
    expect(github.getBranchHead).toHaveBeenCalledWith('test-read-token', 'acme', repoName, BRANCH);
    expect(forgeCallsOutsideTransaction.length).toBeGreaterThan(0);
    expect(forgeCallsOutsideTransaction.every(Boolean)).toBe(true);
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });

  it('AC-1 (surrogate boundary): a question cut inside a surrogate pair still waits and publishes its questions', async () => {
    // The question is cut between the halves of the emoji, so the stored question keeps only whole
    // characters: a lone surrogate would make the JSONB write fail and roll the wait back.
    const question = 'a'.repeat(FLOW_CALL_TEXT_MAX - 1) + '😀';
    const { flow, job } = await seedReview([{ class: 'ambiguous', summary: 'Currency is undecided', question }]);
    await ticker.tick(now);

    const waiting = await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id }, include: { features: true } });
    expect(waiting.state).toBe('WAITING_ANSWER');
    expect(waiting.features[0]).toMatchObject({
      state: 'WAITING_ANSWER', questionsJobId: job.id,
      questions: [{ id: '1', question: 'a'.repeat(FLOW_CALL_TEXT_MAX - 1) }],
    });
    expect(await db.outboxEvent.count({
      where: { projectId, type: 'fleet_flow_questions', eventId: `${flow.id}:questions:${job.id}` },
    })).toBe(1);
  });

  it('AC-8: human stop moves a WAITING_ANSWER flow to STOPPED with human_stop', async () => {
    const { flow } = await seedReview();
    await withTestActor({ type: 'USER', id: creatorId }, async () => {
      await db.fleetFlow.update({ where: { id: flow.id }, data: { state: 'WAITING_ANSWER' } });
      await db.fleetFlowFeature.updateMany({ where: { flowId: flow.id }, data: {
        state: 'WAITING_ANSWER', questionsJobId: 'review-j1', questions: [{ id: '2', question: ambiguous.question }],
      } });
    });
    const stopped = await withTestActor({ type: 'USER', id: creatorId }, () =>
      app.get(FleetFlowsService).stop(projectId, flow.id, { type: 'USER', id: creatorId }, now));
    expect(stopped).toMatchObject({ state: 'STOPPED', stopReason: 'human_stop' });
  });

  it('AC-9: rejects answers bound to an older review job with answersStale', async () => {
    const { flow } = await seedReview();
    await withTestActor({ type: 'USER', id: creatorId }, async () => {
      await db.fleetFlow.update({ where: { id: flow.id }, data: { state: 'WAITING_ANSWER' } });
      await db.fleetFlowFeature.updateMany({ where: { flowId: flow.id }, data: {
        state: 'WAITING_ANSWER', questionsJobId: 'j1', questions: [{ id: '2', question: ambiguous.question }],
      } });
    });
    await expect(app.get(FleetFlowsService).answer(projectId, flow.id,
      { jobId: 'j0', answers: [{ id: '2', answer: 'Use USD' }] }, { type: 'USER', id: creatorId }, now))
      .rejects.toMatchObject({ status: 409, response: { prefix: 'fleet.flows.answersStale' } });
  });
});
