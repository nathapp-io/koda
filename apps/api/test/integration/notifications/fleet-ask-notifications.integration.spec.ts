import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Permissions P3 US-011 — the fleet approval notification's context on PG: the ask's status comes from the
 * approval engine (`ApprovalRequest`) and the repo from its `FleetApprovalAsk` link's job, so a budget ask opened
 * by the evaluator (no job) is delivered like a relayed bash ask.
 *
 * Run: cd apps/api && bun run test:scoped test/integration/notifications/fleet-ask-notifications.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { FleetNotificationReader } from '../../../src/notifications/fleet/fleet-notification.reader';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { seedFleetAsk } from '../../helpers/fleet-ask-fixtures';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('fleet ask notification context (PG, US-011)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let reader: FleetNotificationReader;
  let n = 0;

  const job = () => prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'main', command: 'RUN', feature: `note${++n}`,
      profiles: [], selectorLabels: [], maxCostUsd: new Prisma.Decimal(5), requestedById: world.ids.dev,
      state: 'QUEUED',
    },
    select: { id: true },
  });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    reader = app.get(FleetNotificationReader, { strict: false });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await prisma.fleetApprovalAsk.deleteMany();
    await prisma.approvalRequest.deleteMany();
    await prisma.fleetJob.deleteMany();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('US-011 AC-12: a pending bash ask answers pending with the job repo as owner/name', async () => {
    const running = await job();
    const { requestId } = await seedFleetAsk(prisma, {
      kind: 'bash', projectId: world.projectId,
      input: { jobId: running.id, leaseEpoch: 1, naxAskId: 'ask-note-bash', payload: { command: 'bun run test', commandTruncated: false, options: ['allow'] } },
      link: { jobId: running.id, leaseEpoch: 1, naxAskId: 'ask-note-bash' },
    });

    await expect(reader.approvalContext(requestId)).resolves.toEqual({ status: 'pending', repo: 'acme/app' });
  });

  it('US-011 AC-13: a pending budget ask answers pending with no repo', async () => {
    const { requestId } = await seedFleetAsk(prisma, {
      kind: 'budget', projectId: world.projectId,
      input: {
        policyId: 'policy-note', scopeType: 'project', scopeId: world.projectId, windowKind: 'day',
        windowStart: new Date().toISOString(), spentUsd: '10.5', amountUsd: '20', requestedAt: new Date().toISOString(),
      },
      link: { budgetPolicyId: 'policy-note' },
    });

    await expect(reader.approvalContext(requestId)).resolves.toEqual({ status: 'pending', repo: null });
  });

  it('answers the engine status of a settled ask, and null for a request that is gone', async () => {
    const running = await job();
    const { requestId } = await seedFleetAsk(prisma, {
      kind: 'bash', projectId: world.projectId, status: 'executed', settledAt: new Date(),
      input: { jobId: running.id, leaseEpoch: 1, naxAskId: 'ask-note-settled', payload: { command: 'ls', commandTruncated: false, options: ['allow'] } },
      link: { jobId: running.id, leaseEpoch: 1, naxAskId: 'ask-note-settled' },
      decisions: [{ deciderType: 'USER', deciderId: world.ids.root, decision: 'approve', params: { choice: 'allow' } }],
    });

    await expect(reader.approvalContext(requestId)).resolves.toEqual({ status: 'executed', repo: 'acme/app' });
    await expect(reader.approvalContext('missing-request')).resolves.toBeNull();
  });
});
