import { Logger } from '@nestjs/common';
import type { NathApplication } from '@nathapp/nestjs-app';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { OutboxService } from '@nathapp/nestjs-outbox';
import type { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { FleetFlowsService } from '../../../src/fleet/flows/fleet-flows.service';
import { FleetFlowTicker } from '../../../src/fleet/flows/fleet-flow.ticker';
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
const FEATURE = 'classified-flow';
const SPEC = `.nax/features/${FEATURE}/spec.md`;
const BRANCH = `feat/${FEATURE}`;
const now = new Date('2026-11-07T12:00:00.000Z');
const approvedAt = new Date(now.getTime() - 120_000);
const minor = { id: 'F1', class: 'minor', summary: 'Missing coverage note', fix: 'Document the retry case' };
const ambiguous = { id: 'Q1', class: 'ambiguous', summary: 'Retention is undecided', question: 'How long should results be kept?' };

integration('classified fleet flow verdicts through tick and outbox (PG)', () => {
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
    // Only explicit ticks/publishes may progress the fixtures in this suite.
    vi.stubEnv('FLEET_SWEEP_ENABLED', 'false');
    vi.stubEnv('OUTBOX_RELAY_ENABLED', 'false');
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    ({ projectId, repoId, adminId: creatorId } = await seedFleetBase(db));
    approverId = (await db.user.create({ data: { email: 'flow-approver@koda.test', passwordHash: 'x' } })).id;
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
    // Keep test-setup's shared Logger spies intact; restore only this suite's forge overrides.
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
    const check = () => {
      forgeCallsOutsideTransaction.push(!app.get<ITransactionManager>(TRANSACTION_MANAGER).isInTransaction());
    };
    vi.spyOn(github, 'mintReadOnlyToken').mockImplementation(async () => {
      check(); return { token: 'test-read-token', expiresAt: now };
    });
    vi.spyOn(github, 'mintInstallationToken').mockImplementation(async () => {
      check(); return { token: 'test-write-token', expiresAt: now };
    });
    vi.spyOn(github, 'getBranchHead').mockImplementation(async () => { check(); return forgeHead; });
    vi.spyOn(github, 'getFile').mockImplementation(async () => {
      check(); return { sha: 'blob1', size: 7, content: Buffer.from('# Spec\n') };
    });
    vi.spyOn(github, 'putFile').mockImplementation(async () => {
      check(); return { kind: 'committed', commitSha: 'c2' };
    });
    vi.mocked(Logger.prototype.error).mockClear();
  });

  async function seedReview(step: 'SPEC_REVIEW' | 'PRD_REVIEW', finding: typeof minor | typeof ambiguous, entry: 'NAX' | 'THREAD' = 'NAX') {
    const { flow } = await withTestActor({ type: 'USER', id: creatorId }, () => app.get(FleetFlowsService).create({
      entry: 'NAX', repoId, branch: BRANCH, specSha: SHA,
      features: [{ feature: FEATURE, specPath: SPEC, dependsOn: [] }],
      roles: { reviewer: 'acp:claude', supervisor: 'native:fast' }, costCapUsd: '25',
    }, { type: 'USER', id: creatorId }, { projectId, now: approvedAt }));
    // Approval precedes every job. Match persisted bookkeeping so tick advances, rather than just recovering it.
    await db.fleetFlow.update({ where: { id: flow.id }, data: {
      state: 'RUNNING', approvalMode: 'REQUEST', approverId, approvedAt, pinnedRunnerId: runnerId,
      ...(entry === 'THREAD' ? { entry: 'THREAD' } : {}),
    } });
    await db.fleetFlowFeature.updateMany({ where: { flowId: flow.id }, data: { state: 'RUNNING', currentStep: step } });
    const job = await db.fleetJob.create({ data: {
      ...jobData(flow.id), command: 'AGENT', flowStep: step,
      queuedAt: new Date(now.getTime() - 30_000), finishedAt: new Date(now.getTime() - 10_000),
      agentResult: { status: 'completed', output: JSON.stringify({ findings: [finding] }),
        truncated: false, deniedAsks: [], deniedAsksTruncated: false },
    } });
    return { flow, job };
  }

  function jobData(flowId: string): Prisma.FleetJobUncheckedCreateInput {
    return {
      projectId, repoId, flowId, ref: SHA, command: 'PLAN', feature: FEATURE,
      profiles: [], maxCostUsd: '10', selectorLabels: [], pinnedRunnerId: runnerId,
      requestedById: creatorId, state: 'COMPLETED',
    };
  }

  it('AC-1/AC-2: commits SPEC_REVIEW calls, then dispatches the second review on the calls commit', async () => {
    const { flow, job } = await seedReview('SPEC_REVIEW', minor);
    await ticker.tick(now);

    expect(await db.fleetFlowFeature.findMany({ where: { flowId: flow.id }, take: 2 }))
      .toMatchObject([{ callsJobId: job.id, currentStep: 'SPEC_REVIEW' }]);
    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } }))
      .toMatchObject({ state: 'RUNNING', specSha: 'c2' });
    expect(await db.fleetJob.count({ where: { flowId: flow.id, flowStep: 'PLAN' } })).toBe(0);
    expect(github.putFile).toHaveBeenCalledExactlyOnceWith('test-write-token', 'acme', repoName, SPEC, {
      branch: BRANCH, blobSha: 'blob1', content: expect.any(Buffer),
      message: `docs(${FEATURE}): flow calls from SPEC_REVIEW job ${job.id}`,
    });
    const written = vi.mocked(github.putFile).mock.calls[0][4].content.toString('utf8');
    expect(written).toContain(`### SPEC_REVIEW job ${job.id}`);
    expect(written).toContain(minor.fix);

    forgeHead = 'c2';
    vi.mocked(github.getBranchHead).mockClear();
    await ticker.tick(new Date(now.getTime() + 1_000));

    const reviews = await db.fleetJob.findMany({ where: { flowId: flow.id, flowStep: 'SPEC_REVIEW' }, take: 3 });
    expect(reviews).toHaveLength(2);
    expect(reviews[1]).toMatchObject({ flowId: flow.id, flowStep: 'SPEC_REVIEW', command: 'AGENT', ref: 'c2' });
    expect(await db.fleetJob.count({ where: { flowId: flow.id, flowStep: 'PLAN' } })).toBe(0);
    expect(github.getBranchHead).toHaveBeenCalledWith('test-read-token', 'acme', repoName, BRANCH);
    expect(github.putFile).toHaveBeenCalledTimes(1);
    expect(forgeCallsOutsideTransaction.length).toBeGreaterThan(0);
    expect(forgeCallsOutsideTransaction.every(Boolean)).toBe(true);
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });

  it('AC-3–AC-9: ambiguous review stops, and publishing its actual outbox row creates replay-safe ticket, comment and notification', async () => {
    const { flow } = await seedReview('SPEC_REVIEW', ambiguous, 'THREAD');
    await ticker.tick(now);

    const stopped = await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } });
    expect(stopped).toMatchObject({ state: 'STOPPED', stopReason: 'review_ambiguous', ticketId: null });
    expect(stopped.stopDetail).toContain(ambiguous.question);
    const rows = await db.outboxEvent.findMany({ where: { projectId, type: 'fleet_flow_stopped' }, take: 2 });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({ eventId: `${flow.id}:stopped`, type: 'fleet_flow_stopped' });
    const payload: unknown = JSON.parse(row.payload);
    expect(payload).toMatchObject({ flowId: flow.id, feature: FEATURE, stopReason: 'review_ambiguous', approverId });
    const record = outboxRecord(row.type, payload, {
      id: row.id, createdAt: row.createdAt, metadata: { projectId: row.projectId, eventId: row.eventId },
    });
    const publisher = app.get(FanOutPublisher);
    await publisher.publish(record);

    const tickets = await db.ticket.findMany({ where: { projectId, title: `Fleet flow: ${FEATURE}` }, take: 2 });
    expect(tickets).toHaveLength(1);
    const ticket = tickets[0];
    expect(ticket).toMatchObject({ type: 'TASK', title: `Fleet flow: ${FEATURE}`, description: `Flow ${flow.id} on ${BRANCH}` });
    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } })).toMatchObject({ ticketId: ticket.id });
    const comments = await db.comment.findMany({ where: { ticketId: ticket.id }, take: 2 });
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe(`Flow stopped (review_ambiguous): ${stopped.stopDetail}`);
    // A distinct approver proves this is not merely the human-creator notification path.
    const notificationWhere = { userId: approverId, sourceType: 'fleet_flow', sourceId: flow.id, kind: 'flow_stopped' };
    const notes = await db.notification.findMany({ where: notificationWhere, take: 2 });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ ...notificationWhere, projectId, category: 'FLEET_NEEDS_YOU' });

    await publisher.publish(record);

    expect(await db.ticket.count({ where: { projectId, title: `Fleet flow: ${FEATURE}` } })).toBe(1);
    expect(await db.comment.findMany({ where: { ticketId: ticket.id }, take: 2 })).toEqual(comments);
    expect(await db.notification.findMany({ where: notificationWhere, take: 2 })).toEqual(notes);
    await ticker.tick(new Date(now.getTime() + 1_000));
    expect(await db.outboxEvent.count({ where: { type: 'fleet_flow_stopped', eventId: `${flow.id}:stopped` } })).toBe(1);
    expect(github.putFile).not.toHaveBeenCalled();
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });

  it('AC-4: failure after persisting the stop event rolls back both writes', async () => {
    const { flow } = await seedReview('SPEC_REVIEW', ambiguous, 'THREAD');
    const outbox = app.get(OutboxService);
    const record = outbox.record.bind(outbox);
    const eventWhere = { type: 'fleet_flow_stopped', eventId: `${flow.id}:stopped` };
    // Fault after the real insert, inside the engine's own transaction. Do not wrap tick in a
    // test transaction: its forge preflight must still run without an open transaction.
    const fault = vi.spyOn(outbox, 'record').mockImplementationOnce(async (input) => {
      await record(input);
      expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } }))
        .toMatchObject({ state: 'STOPPED', stopReason: 'review_ambiguous' });
      expect(await db.outboxEvent.count({ where: eventWhere })).toBe(1);
      throw new Error('rollback classified stop');
    });
    try {
      await ticker.tick(now);
      expect(fault).toHaveBeenCalledTimes(1);
      expect(Logger.prototype.error).toHaveBeenCalledExactlyOnceWith(`Flow ${flow.id} failed: rollback classified stop`);
      expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } }))
        .toMatchObject({ state: 'RUNNING', stopReason: null });
      expect(await db.outboxEvent.count({ where: eventWhere })).toBe(0);
      expect(forgeCallsOutsideTransaction.length).toBeGreaterThan(0);
      expect(forgeCallsOutsideTransaction.every(Boolean)).toBe(true);
    } finally {
      fault.mockRestore();
    }
  });

  it('AC-10: PRD_REVIEW minor findings are accepted after two PLAN jobs since approval', async () => {
    const { flow, job } = await seedReview('PRD_REVIEW', minor);
    for (const secondsAgo of [90, 60]) {
      await db.fleetJob.create({ data: {
        ...jobData(flow.id), flowStep: 'PLAN', resultSha: SHA, resultBranch: BRANCH,
        queuedAt: new Date(now.getTime() - secondsAgo * 1_000),
        finishedAt: new Date(now.getTime() - (secondsAgo - 10) * 1_000),
      } });
    }
    expect(await db.fleetJob.count({ where: { flowId: flow.id, flowStep: 'PLAN', queuedAt: { gte: approvedAt } } })).toBe(2);

    await ticker.tick(now);

    expect(await db.fleetFlow.findUniqueOrThrow({ where: { id: flow.id } }))
      .toMatchObject({ state: 'RUNNING', stopReason: null });
    expect(await db.fleetFlowFeature.findFirstOrThrow({ where: { flowId: flow.id } }))
      .toMatchObject({ prdEditsJobId: job.id });
    const activities = await db.fleetActivity.findMany({
      where: { entityId: flow.id, action: 'flow.prd_edits' }, take: 2,
    });
    expect(activities).toHaveLength(1);
    expect(activities[0].payload).toMatchObject({
      jobId: job.id, sha: null, applied: 0, accepted: [minor.summary],
    });
    expect(await db.fleetJob.count({ where: { flowId: flow.id } })).toBe(3);
    expect(github.putFile).not.toHaveBeenCalled();
    expect(github.mintInstallationToken).not.toHaveBeenCalled();
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });
});
