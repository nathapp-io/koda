import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Permissions P3 US-009 — a settled ask's fleet activity is
 * recorded by the one durable outbox consumer, once per engine status, after the
 * deciding or expiring transaction committed.
 *
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-ask-events.integration.spec.ts
 */
import type { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, type PrismaClient } from '../../../src/generated/prisma/client';
import { ApprovalDecisionService } from '../../../src/approvals/approval-decision.service';
import { ApprovalRequestExpirySweeper } from '../../../src/approvals/approval-request-expiry.sweeper';
import { APPROVAL_REQUEST_CHANGED } from '../../../src/approvals/approval-request-events';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { FanOutPublisher } from '../../../src/outbox/fan-out-publisher';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { outboxRecord } from '../../helpers/outbox-record';
import { seedFleetAsk } from '../../helpers/fleet-ask-fixtures';

const integration = canRunDbTests() ? describe : describe.skip;
const now = new Date('2026-11-10T09:00:00Z');

integration('fleet ask events recorded from the engine (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let decisions: ApprovalDecisionService;
  let sweeper: ApprovalRequestExpirySweeper;
  let publisher: FanOutPublisher;
  let projectId: string;
  let jobId: string;
  let runnerId: string;
  let requestId: string;
  const userId = 'ask-decider';
  const agentId = 'ask-deciding-agent';
  const naxAskId = 'nax-ask-events';

  const seedAsk = async (expiresAt = new Date('2030-01-01T00:00:00Z')): Promise<string> => (await seedFleetAsk(db, {
    kind: 'bash', projectId, expiresAt, onBehalfOf: { type: 'USER', id: userId },
    input: { jobId, leaseEpoch: 3, naxAskId, payload: { command: 'bun run test', commandTruncated: false, options: ['allow', 'deny'] } },
    link: { jobId, leaseEpoch: 3, naxAskId },
  })).requestId;

  /** What the outbox relay does: hand every recorded change to the fan-out publisher. */
  const relay = async (): Promise<void> => {
    for (const row of await db.outboxEvent.findMany({ where: { type: APPROVAL_REQUEST_CHANGED }, orderBy: { createdAt: 'asc' } })) {
      await publisher.publish(outboxRecord(row.type, JSON.parse(row.payload), {
        id: row.id, metadata: { projectId: row.projectId, eventId: row.eventId },
      }));
    }
  };
  const activity = (id: string) => db.fleetActivity.findMany({ where: { entityType: 'approval', entityId: id } });
  const decide = (decision: 'approve' | 'reject', at = now) =>
    withTestActor({ type: 'USER', id: userId }, () => decisions.decide(requestId, decision, null, at));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    const user = await db.user.create({ data: { id: userId, email: `${userId}@koda.test`, passwordHash: 'x' } });
    const project = await db.project.create({ data: { name: 'Ask events', slug: 'ask-events', key: 'ASK' } });
    projectId = project.id;
    const repo = await db.fleetRepo.create({ data: {
      projectId, provider: 'github', owner: 'acme', name: 'ask-events', defaultBranch: 'main', createdById: user.id,
    } });
    runnerId = (await db.runner.create({ data: {
      name: 'ask-events-runner', apiKeyHash: 'ask-events-hash', os: 'linux', arch: 'x64', labels: [], capabilities: {},
      daemonVersion: '1.0.0', protocolVersion: 1, bootId: 'ask-events-boot', lastSeenAt: now, createdById: user.id,
    } })).id;
    jobId = (await db.fleetJob.create({ data: {
      projectId, repoId: repo.id, ref: 'main', command: 'RUN', feature: 'ask-events', profiles: [],
      maxCostUsd: new Prisma.Decimal(5), selectorLabels: [], requestedById: user.id, requestedByType: 'USER',
      runnerId, state: 'RUNNING', leaseEpoch: 3, bashMode: 'escalate', firstStartedAt: now,
    } })).id;
    await grantKeys(db, { type: 'USER', id: userId }, ['fleet.job.shell.escalate', 'approval.decide@fleet.job.shell.escalate'], projectId);
    await db.agent.create({ data: { id: agentId, name: 'Ask decider', slug: 'ask-decider-agent', apiKeyHash: 'ask-agent-key-hash' } });
    await grantKeys(db, { type: 'AGENT', id: agentId }, ['fleet.job.shell.escalate', 'approval.decide@fleet.job.shell.escalate'], projectId);
    await db.webhook.create({ data: {
      projectId, url: 'https://hooks.example.com/koda', secret: 's'.repeat(32),
      events: JSON.stringify(['approval.requested', 'approval.resolved']),
    } });
    decisions = app.get(ApprovalDecisionService, { strict: false });
    sweeper = app.get(ApprovalRequestExpirySweeper, { strict: false });
    publisher = app.get(FanOutPublisher, { strict: false });
  });

  afterAll(async () => { await app?.close(); });
  beforeEach(async () => {
    await db.fleetCommand.deleteMany();
    await db.fleetApprovalAsk.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.outboxEvent.deleteMany();
    await db.fleetActivity.deleteMany();
    await db.fleetJob.update({ where: { id: jobId }, data: { state: 'RUNNING', leaseEpoch: 3, runnerId } });
    requestId = await seedAsk();
  });

  it('AC-1: a rejected ask records approval.decided for the decider, payload decision deny', async () => {
    expect(await decide('reject')).toMatchObject({ status: 'rejected' });
    // Nothing is written before the relay: the recorder owns these outputs, not the decide path.
    expect(await activity(requestId)).toEqual([]);

    await relay();

    expect(await activity(requestId)).toMatchObject([
      { action: 'approval.decided', actorId: userId, entityType: 'approval', payload: { decision: 'deny' } },
    ]);
  });

  it('AC-2: an executed approve records the approved view with decision allow', async () => {
    expect(await decide('approve')).toMatchObject({ status: 'executed' });

    await relay();

    expect(await activity(requestId)).toMatchObject([
      { action: 'approval.decided', actorId: userId, payload: { status: 'approved', decision: 'allow' } },
    ]);
  });

  it('AC-3: an ask the expiry sweeper settles records approval.expired for the system', async () => {
    await db.fleetApprovalAsk.delete({ where: { requestId } });
    await db.approvalRequest.delete({ where: { id: requestId } });
    requestId = await seedAsk(new Date('2026-11-10T08:00:00Z'));

    expect(await sweeper.tick(now)).toMatchObject({ expired: 1 });
    await relay();

    expect((await db.fleetApprovalAsk.findUniqueOrThrow({ where: { requestId } })).resolvedBy).toBe('timeout');
    expect(await activity(requestId)).toMatchObject([
      { action: 'approval.expired', actorType: 'SYSTEM', responsibleUserId: userId },
    ]);
  });

  it('retired live AC-3: relaying the same executed change twice records approval.decided once', async () => {
    expect(await decide('approve')).toMatchObject({ status: 'executed' });

    await relay();
    await relay();

    expect(await activity(requestId)).toMatchObject([{ action: 'approval.decided', entityId: requestId }]);
    expect(await activity(requestId)).toHaveLength(1);
    expect((await db.fleetApprovalAsk.findUniqueOrThrow({ where: { requestId } })).recordedStatus).toBe('executed');
  });

  it('AC-11: an executed job_ended ask records approval.cancelled and keeps the job_ended resolution', async () => {
    // The ask was cancelled when its job ended, and the engine executed it afterwards: the change the
    // engine recorded is the `executed` one, never a fleet-side close of its own.
    await db.approvalRequest.update({ where: { id: requestId }, data: { status: 'executed', settledAt: now, approverId: userId } });
    await db.fleetApprovalAsk.update({ where: { requestId }, data: { resolvedBy: 'job_ended' } });
    await publisher.publish(outboxRecord(APPROVAL_REQUEST_CHANGED, {
      requestId, status: 'executed', projectId, permissionKey: 'fleet.job.shell.escalate', requiredMode: 'agent',
      actorType: 'SYSTEM', actorId: 'runner', onBehalfOfType: 'USER', onBehalfOfId: userId, expiresAt: now.toISOString(),
    }));

    // The fleet status comes from the link's resolution, so the closer records the cancelled action.
    expect(await activity(requestId)).toMatchObject([{ action: 'approval.cancelled', entityType: 'approval' }]);
    expect((await db.fleetApprovalAsk.findUniqueOrThrow({ where: { requestId } })).resolvedBy).toBe('job_ended');
  });

  it('an agent decider records its activity as an AGENT, which the relay context cannot infer', async () => {
    await withTestActor({ type: 'AGENT', id: agentId }, () => decisions.decide(requestId, 'reject', null, now));

    await relay();

    expect(await activity(requestId)).toMatchObject([
      { action: 'approval.decided', actorType: 'AGENT', actorId: agentId, responsibleUserId: agentId },
    ]);
  });
});
