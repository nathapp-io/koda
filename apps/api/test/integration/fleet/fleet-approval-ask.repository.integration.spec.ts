import { randomUUID } from 'node:crypto';
import { PrismaTransactionManager, type PrismaService } from '@nathapp/nestjs-prisma';
import { canRunDbTests } from '../../helpers/test-environment';
import { applyMigration, scratchSchemaBefore, type ScratchSchema } from '../../helpers/migration-schema';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaFleetApprovalAskRepository } from '../../../src/fleet/approvals/prisma-fleet-approval-ask.repository';
import { MAX_PENDING_ASKS_PER_JOB } from '../../../src/fleet/approvals/domain/fleet-approval-ask.domain';

/**
 * Permissions P3d-1 (US-009) — the FleetApprovalAsk link table behind the committed migration.
 * The scratch schema is built by replaying the committed migrations (never `db push`), so these
 * assertions cover the shipped DDL: the (jobId, leaseEpoch, naxAskId) unique index, the indexes the
 * finders rely on and the ON DELETE CASCADE to ApprovalRequest.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-approval-ask.repository.integration.spec.ts
 */
const describeDb = canRunDbTests() ? describe : describe.skip;
const MIGRATION = '20261106090000_approval_fleet_core';

describeDb('FleetApprovalAsk repository (PG)', () => {
  let scratch: ScratchSchema;
  let db: PrismaClient;
  let tx: PrismaTransactionManager;
  let repository: PrismaFleetApprovalAskRepository;
  const projectId = `project-${randomUUID()}`;

  beforeAll(async () => {
    scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'fleet_ask_repo', MIGRATION);
    await applyMigration(scratch.db, MIGRATION);
    db = scratch.db;
    // The repository reads `prisma.client`, the transaction-aware proxy: route it through the real
    // transaction manager so `FOR UPDATE` runs inside a real PG transaction.
    tx = new PrismaTransactionManager(db);
    const prisma = { get client() { return tx.getClient<PrismaClient>() ?? db; } } as unknown as PrismaService<PrismaClient>;
    repository = new PrismaFleetApprovalAskRepository(tx, prisma);
  }, 120_000);

  afterAll(async () => {
    await scratch?.drop();
  });

  /** A stored approval request; the link table's request row must exist, its project need not. */
  async function request(status = 'pending', createdAt?: Date, id?: string): Promise<string> {
    const row = await db.approvalRequest.create({
      data: {
        ...(id !== undefined ? { id } : {}),
        permissionKey: 'fleet.job.shell.escalate',
        projectId,
        actorType: 'AGENT',
        actorId: 'agent-1',
        origin: 'runner',
        correlationId: randomUUID(),
        input: {},
        inputHash: randomUUID(),
        requiredMode: 'human',
        onTimeout: 'reject',
        approverMustHoldAction: true,
        requireDistinctApprover: false,
        status,
        expiresAt: new Date(Date.now() + 60_000),
        ...(createdAt !== undefined ? { createdAt } : {}),
      },
    });
    return row.id;
  }

  function ask(requestId: string, over: Record<string, unknown> = {}) {
    return { requestId, kind: 'bash' as const, projectId, jobId: 'job-1', leaseEpoch: 2, naxAskId: 'ask-1', ...over };
  }

  it('AC-1: insert then findByRequest returns the stored link with the nullable columns empty', async () => {
    const requestId = await request();
    const stored = await repository.insert({
      requestId, kind: 'bash', projectId, jobId: 'job-1', leaseEpoch: 2, naxAskId: 'ask-1',
    });
    expect(stored).toMatchObject({
      requestId, kind: 'bash', projectId, jobId: 'job-1', leaseEpoch: 2, naxAskId: 'ask-1',
      budgetPolicyId: null, resolvedBy: null, outcome: null,
    });
    expect(await repository.findByRequest(requestId)).toEqual(stored);
  });

  it('AC-2: findByAsk returns the link joined with its request status', async () => {
    const requestId = await request();
    await repository.insert(ask(requestId, { naxAskId: 'ask-2' }));
    expect(await repository.findByAsk('job-1', 2, 'ask-2')).toEqual({
      ask: expect.objectContaining({ requestId, jobId: 'job-1', leaseEpoch: 2, naxAskId: 'ask-2' }),
      status: 'pending',
    });
  });

  it('AC-3: findByAsk of a different lease epoch is null', async () => {
    const requestId = await request();
    await repository.insert(ask(requestId, { naxAskId: 'ask-3' }));
    expect(await repository.findByAsk('job-1', 3, 'ask-3')).toBeNull();
  });

  it('AC-4: a second link for the same job, lease epoch and nax ask id rejects with P2002', async () => {
    const first = await request();
    const second = await request();
    await repository.insert(ask(first, { naxAskId: 'ask-4' }));
    await expect(repository.insert(ask(second, { naxAskId: 'ask-4' }))).rejects.toMatchObject({ code: 'P2002' });
    expect(await repository.findByRequest(second)).toBeNull();
  });

  it('AC-5: findPendingForJob returns the pending links oldest request first, bounded by the take', async () => {
    const older = await request('pending', new Date(1_000), 'ac5-older');
    const newer = await request('pending', new Date(2_000), 'ac5-newer');
    const cancelled = await request('cancelled', new Date(500), 'ac5-cancelled');
    const otherJob = await request('pending', new Date(500), 'ac5-other-job');
    await repository.insert(ask(older, { jobId: 'job-5', naxAskId: 'ask-5-older' }));
    await repository.insert(ask(newer, { jobId: 'job-5', naxAskId: 'ask-5-newer' }));
    await repository.insert(ask(cancelled, { jobId: 'job-5', naxAskId: 'ask-5-cancelled' }));
    await repository.insert(ask(otherJob, { jobId: 'job-5-other', naxAskId: 'ask-5-other' }));

    const pending = await repository.findPendingForJob('job-5');
    expect(pending.map((link) => link.requestId)).toEqual([older, newer]);

    // The bound, not just the filter: one more pending link than the take may return is stored.
    const overflow = Array.from({ length: MAX_PENDING_ASKS_PER_JOB + 2 }, (_, index) => `ac5-bounded-${index}`);
    await db.approvalRequest.createMany({
      data: overflow.map((id, index) => ({
        id, permissionKey: 'fleet.job.shell.escalate', projectId, actorType: 'AGENT', actorId: 'agent-1',
        origin: 'runner', correlationId: randomUUID(), input: {}, inputHash: randomUUID(), requiredMode: 'human',
        onTimeout: 'reject', approverMustHoldAction: true, requireDistinctApprover: false, status: 'pending',
        expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(10_000 + index), updatedAt: new Date(),
      })),
    });
    await db.fleetApprovalAsk.createMany({
      data: overflow.map((requestId, index) => ({
        requestId, kind: 'bash', projectId, jobId: 'job-5-bounded', leaseEpoch: 1, naxAskId: `ask-5-bounded-${index}`,
        updatedAt: new Date(),
      })),
    });
    const bounded = await repository.findPendingForJob('job-5-bounded');
    expect(bounded).toHaveLength(MAX_PENDING_ASKS_PER_JOB);
    expect(bounded.map((link) => link.requestId)).toEqual(overflow.slice(0, MAX_PENDING_ASKS_PER_JOB));
  });

  it('AC-6: findPendingForPolicy returns the pending link and ignores an expired request', async () => {
    const pending = await request();
    const expired = await request('expired');
    await repository.insert(ask(pending, { kind: 'budget', jobId: null, leaseEpoch: null, naxAskId: null, budgetPolicyId: 'policy-6' }));
    await repository.insert(ask(expired, { kind: 'budget', jobId: null, leaseEpoch: null, naxAskId: null, budgetPolicyId: 'policy-6-expired' }));

    expect(await repository.findPendingForPolicy('policy-6')).toMatchObject({ requestId: pending, budgetPolicyId: 'policy-6' });
    expect(await repository.findPendingForPolicy('policy-6-expired')).toBeNull();
  });

  it('AC-7: lockByRequest returns the locked link inside a transaction and null without one', async () => {
    const requestId = await request();
    const link = await repository.insert(ask(requestId, { naxAskId: 'ask-7' }));
    const locked = await tx.run(() => repository.lockByRequest(requestId));
    expect(locked).toEqual(link);
    const linkless = await request();
    expect(await tx.run(() => repository.lockByRequest(linkless))).toBeNull();
  });

  it('AC-8: setResolvedBy stores the resolver', async () => {
    const requestId = await request();
    await repository.insert(ask(requestId, { naxAskId: 'ask-8' }));
    await repository.setResolvedBy(requestId, 'job_ended');
    expect(await repository.findByRequest(requestId)).toMatchObject({ requestId, resolvedBy: 'job_ended' });
  });

  it('AC-9: setOutcome replaces the previous outcome', async () => {
    const requestId = await request();
    await repository.insert(ask(requestId, { naxAskId: 'ask-9' }));
    await repository.setOutcome(requestId, { delivery: { result: 'ok' } });
    await repository.setOutcome(requestId, { requeueResults: [] });
    expect((await repository.findByRequest(requestId))?.outcome).toEqual({ requeueResults: [] });
  });

  it('AC-10: deleting the request cascades its link away', async () => {
    const requestId = await request();
    await repository.insert(ask(requestId, { naxAskId: 'ask-10' }));
    await db.approvalRequest.delete({ where: { id: requestId } });
    expect(await repository.findByRequest(requestId)).toBeNull();
    expect(await db.fleetApprovalAsk.count({ where: { requestId } })).toBe(0);
  });
});
