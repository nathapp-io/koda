import { Logger } from '@nestjs/common';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { FleetFlowsService } from '../../../src/fleet/flows/fleet-flows.service';
import { FleetFlowTicker } from '../../../src/fleet/flows/fleet-flow.ticker';
import { GitHubAppClient } from '../../../src/fleet/git-broker/github-app-client';
import { NAX_ITEM_INDEX_MARKER } from '../../../src/fleet/rulings/fleet-pr-rulings.service';
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
const HEAD_SHA = 'b'.repeat(40);
const PR = 12;
const BRANCH = 'feat/ruled-flow';
const RUN_BRANCH = `${BRANCH}/run`;
const now = new Date('2026-11-07T12:00:00.000Z');
const approvedAt = new Date(now.getTime() - 300_000);
/** The RUN's open items: an advisor item a RULE round may rule, and a finding FIX has to close. */
const OPEN_ITEMS = [
  { id: 'D-1', kind: 'advisor', issue: 'The advisor premise still holds', severity: 'minor' },
  { id: 'F-1', kind: 'finding', issue: 'A code gap FIX has to close', severity: 'major' },
];
/** The RULE verdict: one ruling for the advisor item and no question. */
const RULE_OUTPUT = 'Ruling the open items.\n{"rulings":[{"item":"D-1","ruling":"verified: test green"}],"questions":[]}\n';

integration('fleet flow PR-phase rulings against the database (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let ticker: FleetFlowTicker;
  let flows: FleetFlowsService;
  let projectId: string;
  let repoId: string;
  let creatorId: string;
  let approverId: string;
  let runnerId: string;
  let repoName: string;
  let repoOwner: string;
  let prUrl: string;
  let github: GitHubAppClient;

  beforeAll(async () => {
    vi.stubEnv('FLEET_SWEEP_ENABLED', 'false');
    vi.stubEnv('OUTBOX_RELAY_ENABLED', 'false');
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    ({ projectId, repoId, adminId: creatorId } = await seedFleetBase(db));
    // A ticket ref is `KEY-N` with an uppercase-letter key, and the ruling path creates the RUN's
    // finish ticket through the ticket service: the shared fixture's `W1` key cannot be resolved.
    await db.project.update({ where: { id: projectId }, data: { key: 'RULE' } });
    approverId = (await db.user.create({ data: { email: 'flow-rulings-approver@koda.test', passwordHash: 'x' } })).id;
    await grantBaseline(db, { type: 'USER', id: approverId });
    await grantRole(db, { type: 'USER', id: approverId }, 'admin', null);
    runnerId = (await insertRunner(db, { createdById: creatorId })).id;
    const repo = await db.fleetRepo.findUniqueOrThrow({ where: { id: repoId } });
    repoName = repo.name;
    repoOwner = repo.owner;
    prUrl = `https://github.com/${repoOwner}/${repoName}/pull/${PR}`;
    ticker = app.get(FleetFlowTicker);
    flows = app.get(FleetFlowsService);
    github = app.get(GitHubAppClient);
  }, 60_000);

  afterAll(async () => {
    try { await app?.close(); } finally { vi.unstubAllEnvs(); }
  });

  afterEach(() => {
    for (const method of ['mintReadOnlyToken', 'mintThreadReadToken', 'getBranchHead', 'getPullRequest', 'listIssueComments'] as const) {
      vi.mocked(github[method]).mockRestore();
    }
  });

  beforeEach(async () => {
    await db.notification.deleteMany({ where: { projectId } });
    await db.outboxEvent.deleteMany({ where: { projectId } });
    await db.fleetJob.deleteMany({ where: { projectId } });
    await db.fleetFlow.deleteMany({ where: { projectId } });
    vi.mocked(Logger.prototype.error).mockClear();
    // The item-index read and the PR head read are the only forge calls of this path; the branch head
    // read is stubbed too, so a preflight that runs stays deterministic.
    vi.spyOn(github, 'mintReadOnlyToken').mockResolvedValue({ token: 'test-read-token', expiresAt: now });
    vi.spyOn(github, 'getBranchHead').mockResolvedValue(SHA);
    vi.spyOn(github, 'mintThreadReadToken').mockResolvedValue({ token: 'test-thread-token', expiresAt: now });
    vi.spyOn(github, 'listIssueComments').mockResolvedValue([NAX_ITEM_INDEX_MARKER]);
    vi.spyOn(github, 'getPullRequest').mockResolvedValue({ state: 'open', headSha: HEAD_SHA } as never);
  });

  const at = (offsetMs: number): Date => new Date(now.getTime() + offsetMs);

  function jobBase(flowId: string, feature: string): Prisma.FleetJobUncheckedCreateInput {
    return {
      projectId, repoId, flowId, ref: SHA, command: 'AGENT', feature, profiles: [],
      maxCostUsd: '10', selectorLabels: [], pinnedRunnerId: runnerId, requestedById: creatorId, state: 'COMPLETED',
    };
  }

  /**
   * A nax-entry flow whose RUN published a draft PR with open items, and whose REVIEW is done:
   * the state the PR phase starts from.
   */
  async function seedDraftRun(feature: string): Promise<{ flowId: string; runId: string }> {
    const { flow } = await withTestActor({ type: 'USER', id: creatorId }, () => flows.create({
      entry: 'NAX', repoId, branch: BRANCH, specSha: SHA,
      features: [{ feature, specPath: `.nax/features/${feature}/spec.md`, dependsOn: [] }],
      roles: { reviewer: 'acp:claude', supervisor: 'native:fast' }, costCapUsd: '25',
    }, { type: 'USER', id: creatorId }, { projectId, now: approvedAt }));
    await db.fleetFlow.update({ where: { id: flow.id }, data: {
      state: 'RUNNING', approvalMode: 'REQUEST', approverId, approvedAt, pinnedRunnerId: runnerId,
    } });
    await db.fleetFlowFeature.updateMany({ where: { flowId: flow.id }, data: {
      state: 'RUNNING', currentStep: 'REVIEW', prNumber: PR,
    } });
    const run = await db.fleetJob.create({ data: {
      ...jobBase(flow.id, feature), command: 'RUN', flowStep: 'RUN', feature, ref: BRANCH,
      resultPrUrl: prUrl, resultBranch: RUN_BRANCH, resultSha: 'run-sha',
      workflow: { runId: 'nax-run-1', outcome: 'draft', workflowPassed: false, reasons: [], openItems: OPEN_ITEMS },
      queuedAt: at(-120_000), finishedAt: at(-90_000),
    } });
    await db.fleetJob.create({ data: {
      ...jobBase(flow.id, feature), command: 'REVIEW', flowStep: 'REVIEW', feature: `review-pr-${PR}`, ref: 'main',
      queuedAt: at(-60_000), finishedAt: at(-30_000),
      agentResult: { status: 'completed', output: '{"findings":[]}', truncated: false, deniedAsks: [], deniedAsksTruncated: false },
    } });
    return { flowId: flow.id, runId: run.id };
  }

  /**
   * The first automatic round: the RULE job is dispatched, its verdict completes it, and the next
   * tick records the ruling.
   */
  async function ruleRound(flowId: string): Promise<string> {
    await ticker.tick(now);
    const rule = await db.fleetJob.findFirstOrThrow({
      where: { flowId, flowStep: 'RULE' }, orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }],
    });
    await db.fleetJob.update({ where: { id: rule.id }, data: {
      state: 'COMPLETED', finishedAt: at(1_000),
      agentResult: { status: 'completed', output: RULE_OUTPUT, truncated: false, deniedAsks: [], deniedAsksTruncated: false },
    } });
    await ticker.tick(at(2_000));
    return rule.id;
  }

  /** The FIX round the recorded ruling triggers: dispatched, then completed with its ready result. */
  async function fixRound(flowId: string, fixReady: Prisma.InputJsonValue): Promise<string> {
    await ticker.tick(at(3_000));
    const fix = await db.fleetJob.findFirstOrThrow({
      where: { flowId, flowStep: 'FIX' }, orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }],
    });
    await db.fleetJob.update({ where: { id: fix.id }, data: {
      state: 'COMPLETED', finishedAt: at(4_000), fixReady,
    } });
    return fix.id;
  }

  function agentTask(input: Prisma.JsonValue | null): string {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('the job carries no agent input');
    const task = (input as Record<string, unknown>)['task'];
    if (typeof task !== 'string') throw new Error('the job carries no agent task');
    return task;
  }

  it('AC-1: a draft RUN with open items dispatches a RULE AGENT job on the next advance tick', async () => {
    const { flowId } = await seedDraftRun('ruled-ac1');
    await ticker.tick(now);

    const rules = await db.fleetJob.findMany({
      where: { flowId, flowStep: 'RULE' }, orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }], take: 2,
    });
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ command: 'AGENT', feature: 'ruled-ac1', ref: RUN_BRANCH, flowStep: 'RULE' });
    const task = agentTask(rules[0].agentInput);
    expect(task).toContain('- D-1 (advisor, minor): The advisor premise still holds');
    expect(task).not.toContain('F-1');
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });

  it('AC-2/AC-3: the RULE verdict is stored as a SYSTEM ruling and commented on the RUN finish ticket', async () => {
    const { flowId, runId } = await seedDraftRun('ruled-ac2');
    const ruleId = await ruleRound(flowId);

    const rulings = await db.fleetPrRuling.findMany({ where: { jobId: runId }, take: 5 });
    expect(rulings).toHaveLength(1);
    expect(rulings[0]).toMatchObject({
      itemId: 'D-1', itemKind: 'advisor', text: 'verified: test green', disposition: 'verified',
      actorType: 'SYSTEM', actorId: 'flow', state: 'pending', prNumber: PR,
    });
    expect(await db.fleetFlowFeature.findFirstOrThrow({ where: { flowId } })).toMatchObject({ rulingsJobId: ruleId });

    const ticket = await db.ticket.findFirstOrThrow({ where: { projectId, title: `Finish draft PR #${PR} (ruled-ac2)` } });
    const comments = await db.comment.findMany({ where: { ticketId: ticket.id }, take: 5 });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      type: 'RULING',
      body: `D-1 (advisor): verified: test green (flow ${flowId})`,
      authorUserId: null,
      authorAgentId: null,
    });
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });

  it('AC-4: the recorded ruling rides the FIX dispatch as its prRulings snapshot', async () => {
    const { flowId, runId } = await seedDraftRun('ruled-ac4');
    await ruleRound(flowId);
    await ticker.tick(at(3_000));

    const fixes = await db.fleetJob.findMany({
      where: { flowId, flowStep: 'FIX' }, orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }], take: 2,
    });
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatchObject({ command: 'FIX', feature: `review-pr-${PR}`, flowStep: 'FIX' });
    const ruling = await db.fleetPrRuling.findFirstOrThrow({ where: { jobId: runId } });
    expect(fixes[0].prRulings).toEqual({
      headSha: HEAD_SHA,
      rulings: [{
        rulingId: ruling.id, item: 'D-1', ruling: 'verified: test green',
        by: 'koda:system:flow', at: ruling.createdAt.toISOString(),
      }],
    });
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });

  it('AC-5/AC-8: a held FIX waits for an answer, and its questions reach the ticket and the recipients', async () => {
    const { flowId } = await seedDraftRun('ruled-ac5');
    await ruleRound(flowId);
    const fixId = await fixRound(flowId, { markedReady: false, readyHeld: '1 open item(s): G-1' });
    await ticker.tick(at(5_000));

    const waiting = await db.fleetFlow.findUniqueOrThrow({ where: { id: flowId }, include: { features: true } });
    expect(waiting.state).toBe('WAITING_ANSWER');
    expect(waiting.features[0]).toMatchObject({ state: 'WAITING_ANSWER', questionsJobId: fixId });
    expect(waiting.features[0].questions).toEqual([{
      id: '1',
      question: `PR still held after FIX ${fixId}: 1 open item(s): G-1. Answer with guidance for one more ruling and FIX round, or stop the flow.`,
    }]);

    // The questions ticket and the notifications are the F4b fan-out of this tick's outbox event.
    const eventId = `${flowId}:questions:${fixId}`;
    const rows = await db.outboxEvent.findMany({ where: { projectId, type: 'fleet_flow_questions', eventId }, take: 2 });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    const payload: unknown = JSON.parse(row.payload);
    const record = outboxRecord(row.type, payload, {
      id: row.id, createdAt: row.createdAt, metadata: { projectId: row.projectId, eventId: row.eventId },
    });
    await app.get(FanOutPublisher).publish(record);

    const ticket = await db.ticket.findFirstOrThrow({ where: { projectId, title: 'Fleet flow: ruled-ac5' } });
    const comments = await db.comment.findMany({ where: { ticketId: ticket.id }, take: 5 });
    expect(comments).toHaveLength(1);
    expect(comments[0].body.startsWith(`Flow needs answers (FIX job ${fixId}):`)).toBe(true);

    const notifications = await db.notification.findMany({
      where: { projectId, kind: 'flow_questions', sourceType: 'fleet_flow', sourceId: `${flowId}:${fixId}` }, take: 5,
    });
    expect(notifications.map(({ userId }) => userId).sort()).toEqual([creatorId, approverId].sort());
    expect(notifications[0]).toMatchObject({ category: 'FLEET_NEEDS_YOU' });
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });

  it('AC-6: the human answer guides the next RULE round', async () => {
    const { flowId } = await seedDraftRun('ruled-ac6');
    await ruleRound(flowId);
    const fixId = await fixRound(flowId, { markedReady: false, readyHeld: '1 open item(s): G-1' });
    await ticker.tick(at(5_000));

    const answered = await withTestActor({ type: 'USER', id: creatorId }, () => flows.answer(projectId, flowId,
      { jobId: fixId, answers: [{ id: '1', answer: 're-run the gate after the fix' }] },
      { type: 'USER', id: creatorId }, at(6_000)));
    expect(answered.state).toBe('RUNNING');

    await ticker.tick(at(7_000));

    const rules = await db.fleetJob.findMany({
      where: { flowId, flowStep: 'RULE' }, orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }], take: 3,
    });
    expect(rules).toHaveLength(2);
    const task = agentTask(rules[1].agentInput);
    expect(task).toContain('Still held: 1 open item(s): G-1');
    expect(task).toContain('A: re-run the gate after the fix');
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });

  it('AC-6: a long hold still carries the human answer into the guided RULE round', async () => {
    const { flowId } = await seedDraftRun('ruled-ac6-long');
    await ruleRound(flowId);
    // A hold long enough to fill the question line: the answer must survive it.
    const held = `1 open item(s): G-1 ${'detail '.repeat(140)}`;
    const fixId = await fixRound(flowId, { markedReady: false, readyHeld: held });
    await ticker.tick(at(5_000));

    await withTestActor({ type: 'USER', id: creatorId }, () => flows.answer(projectId, flowId,
      { jobId: fixId, answers: [{ id: '1', answer: 're-run the gate after the fix' }] },
      { type: 'USER', id: creatorId }, at(6_000)));

    await ticker.tick(at(7_000));

    const rules = await db.fleetJob.findMany({
      where: { flowId, flowStep: 'RULE' }, orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }], take: 3,
    });
    expect(rules).toHaveLength(2);
    const task = agentTask(rules[1].agentInput);
    expect(task).toContain('Still held: 1 open item(s): G-1');
    expect(task).toContain('A: re-run the gate after the fix');
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });

  it('AC-7: a held FIX whose hold is a CI failure stops the flow instead of waiting', async () => {
    const { flowId } = await seedDraftRun('ruled-ac7');
    await ruleRound(flowId);
    await fixRound(flowId, { markedReady: false, readyHeld: 'CI failure: test' });
    await ticker.tick(at(5_000));

    const stopped = await db.fleetFlow.findUniqueOrThrow({ where: { id: flowId }, include: { features: true } });
    expect(stopped).toMatchObject({ state: 'STOPPED', stopReason: 'pr_not_ready', stopDetail: 'CI failure: test' });
    expect(stopped.features[0]).toMatchObject({ state: 'STOPPED', questionsJobId: null });
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });
});
