import { Logger } from '@nestjs/common';
import type { MockInstance } from 'vitest';
import { currentContext, type ActionContext } from '../../action-context/action-context';
import { currentBookkeepingReason } from '../../action-context/audit-coverage';
import type { BookkeepingReason } from '../../action-context/audit-coverage.reasons';
import type { AuditRecordInput } from '../../audit/audit-recorder.service';
import { noopLastErrors, outboxRecord } from '../../../test/helpers/outbox-record';
import { FanOutPublisher } from '../../outbox/fan-out-publisher';
import type { FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import { buildFixFollowUpPayload, FIX_FOLLOW_UP, type FixFollowUpPayload } from '../common/fix-follow-up-events';
import type { FleetPrReviewRecord } from './domain/fleet-pr-review.domain';
import { FixFollowUpSubscriber } from './fix-follow-up.subscriber';

/**
 * US-002 — the subscriber that turns a pushed `FIX` into a follow-up `REVIEW`.
 *
 * The handlers are stubbed at unit level; the seam AC-10 walks the real `FanOutPublisher`, so the
 * registration, the `fleet_fix_follow_up` payload and the dispatch are exercised together.
 */

/** The FIX job the event describes: `review-pr-22`, pushed head `'a'.repeat(40)`, $1.25, two profiles. */
const fixJob = (over: Partial<FleetJobRecord> = {}): FleetJobRecord => ({
  id: 'fix-1', projectId: 'p1', repoId: 'r1', requestedById: 'u1', requestedByType: 'USER',
  leaseEpoch: 3, profiles: ['balanced', 'security'], maxCostUsd: '1.2500',
  ...over,
} as FleetJobRecord);

const HEAD_SHA = 'a'.repeat(40);

const payload = (over: Partial<FleetJobRecord> = {}): FixFollowUpPayload =>
  buildFixFollowUpPayload(fixJob(over), 22, HEAD_SHA);

const claimRow = (over: Partial<FleetPrReviewRecord> = {}): FleetPrReviewRecord => ({
  id: 'claim-1', repoId: 'r1', prNumber: 22, headSha: HEAD_SHA, jobId: null, outcome: 'pending',
  createdAt: new Date(0), updatedAt: new Date(0), ...over,
});

interface AuditWrite {
  input: AuditRecordInput;
  /** Whether `AuditRecorder.record` ran inside `txManager.run`, which the recorder requires. */
  inTransaction: boolean;
}

/** One subscriber with every collaborator stubbed, as the plan's fixture list describes it. */
function createSubscriber() {
  const registry = new FanOutPublisher(noopLastErrors);

  const writeReasons: (BookkeepingReason | undefined)[] = [];
  const reviews = {
    findPrincipalAccess: vi.fn(async () => ({ exists: true, disabled: false })),
    insertPending: vi.fn(async (): Promise<FleetPrReviewRecord | null> => {
      writeReasons.push(currentBookkeepingReason());
      return claimRow();
    }),
    markDispatched: vi.fn(async (): Promise<void> => {
      writeReasons.push(currentBookkeepingReason());
    }),
  };

  /** The action context each `dispatch` call ran in, read from inside the call itself. */
  const contexts: (ActionContext | undefined)[] = [];
  const jobs = {
    dispatch: vi.fn(async (
      _actorId: string,
      _projectId: string,
      _dto: { command?: string },
      _opts?: { auditKey?: string },
    ): Promise<{ job: { id: string } }> => {
      contexts.push(currentContext());
      return { job: { id: 'rev-1' } };
    }),
  };

  // US-003 stubs: a granted requester and an existing repo, so its checks keep these fixtures.
  const repos = {
    findReviewRepo: vi.fn(async () => ({
      id: 'r1', projectId: 'p1', owner: 'o', name: 'n', githubInstallationId: 1n,
    })),
  };
  const permissions = { effectiveKeys: vi.fn(async () => new Set(['fleet.job.dispatch'])) };

  let inTransaction = false;
  const audits: AuditWrite[] = [];
  const txManager = {
    run: vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => {
      inTransaction = true;
      try {
        return await fn();
      } finally {
        inTransaction = false;
      }
    }),
    getClient: vi.fn(),
    isInTransaction: vi.fn(() => inTransaction),
  };
  const audit = {
    record: vi.fn(async (input: AuditRecordInput): Promise<void> => {
      audits.push({ input, inTransaction });
    }),
  };

  const subscriber = new FixFollowUpSubscriber(
    registry,
    reviews as never,
    jobs as never,
    repos as never,
    permissions as never,
    audit as never,
    txManager as never,
  );

  return { subscriber, registry, reviews, jobs, contexts, repos, permissions, audit, audits, txManager, writeReasons };
}

type Harness = ReturnType<typeof createSubscriber>;

describe('FixFollowUpSubscriber', () => {
  let warn: MockInstance;

  beforeEach(() => {
    // `test-setup.ts` spies on Logger.prototype globally; this spy is the one the AC-2 assertion reads.
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    vi.clearAllMocks();
  });

  it('AC-1: registers its handler for fleet_fix_follow_up on init', () => {
    const { subscriber, registry }: Harness = createSubscriber();

    subscriber.onModuleInit();

    expect(registry.getHandlers(FIX_FOLLOW_UP)).toEqual([subscriber.handle]);
  });

  it('AC-2: a payload the parser rejects logs a warning', async () => {
    const { subscriber }: Harness = createSubscriber();

    await expect(subscriber.handle({ jobId: 'fix-1' })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(FIX_FOLLOW_UP);
    expect(warn.mock.calls[0]?.[0]).toContain('malformed');
  });

  it('AC-3: a malformed payload writes no claim, job or audit entry', async () => {
    const { subscriber, reviews, jobs, audit, txManager }: Harness = createSubscriber();

    await subscriber.handle('garbage');

    expect(reviews.insertPending).not.toHaveBeenCalled();
    expect(reviews.markDispatched).not.toHaveBeenCalled();
    expect(jobs.dispatch).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(txManager.run).not.toHaveBeenCalled();
  });

  it('AC-4: claims the pushed head with the payload repo, PR number and head sha', async () => {
    const { subscriber, reviews }: Harness = createSubscriber();

    await subscriber.handle(payload());

    expect(reviews.insertPending).toHaveBeenCalledExactlyOnceWith('r1', 22, HEAD_SHA);
  });

  it('AC-5: dispatches the follow-up REVIEW with the payload values and the new audit key', async () => {
    const { subscriber, jobs }: Harness = createSubscriber();

    await subscriber.handle(payload());

    expect(jobs.dispatch).toHaveBeenCalledExactlyOnceWith(
      'u1',
      'p1',
      { command: 'REVIEW', repoId: 'r1', prNumber: 22, profiles: ['balanced', 'security'], maxCostUsd: 1.25 },
      { auditKey: 'system.pr-fix.follow-up' },
    );
  });

  it('AC-6: the dispatch runs in the pr-fix system actor context', async () => {
    const { subscriber, contexts }: Harness = createSubscriber();

    await subscriber.handle(payload());

    expect(contexts[0]?.actor).toEqual({ type: 'SYSTEM', id: 'pr-fix' });
  });

  it('AC-7: the dispatch runs on behalf of the FIX requester', async () => {
    const { subscriber, contexts }: Harness = createSubscriber();

    await subscriber.handle(payload({ requestedById: 'a1', requestedByType: 'AGENT' }));

    expect(contexts[0]?.onBehalfOf).toEqual({ type: 'AGENT', id: 'a1' });
  });

  it('AC-8: records the review job on the claim', async () => {
    const { subscriber, reviews }: Harness = createSubscriber();

    await subscriber.handle(payload());

    expect(reviews.markDispatched).toHaveBeenCalledExactlyOnceWith('claim-1', 'rev-1');
  });

  it('AC-9: writes one audit entry on the FIX job, inside a transaction', async () => {
    const { subscriber, audits, txManager }: Harness = createSubscriber();

    await subscriber.handle(payload());

    expect(txManager.run).toHaveBeenCalledTimes(1);
    expect(audits).toEqual([{
      input: {
        key: 'system.pr-fix.follow-up',
        resourceType: 'fleet-job',
        resourceId: 'fix-1',
        projectId: 'p1',
        summary: 'follow-up review dispatched: rev-1',
      },
      inTransaction: true,
    }]);
  });

  it('AC-10: publishing a fleet_fix_follow_up record dispatches one REVIEW', async () => {
    const { subscriber, registry, jobs }: Harness = createSubscriber();
    subscriber.onModuleInit();

    await registry.publish(outboxRecord(FIX_FOLLOW_UP, payload()));

    expect(jobs.dispatch).toHaveBeenCalledTimes(1);
    expect(jobs.dispatch.mock.calls[0]?.[2]).toMatchObject({ command: 'REVIEW' });
  });

  it('AC-13: a claim that rejects with a database error makes the handler reject', async () => {
    const { subscriber, reviews }: Harness = createSubscriber();
    reviews.insertPending.mockRejectedValue(new Error('db down'));

    await expect(subscriber.handle(payload())).rejects.toThrow('db down');
  });

  it('AC-14: a mark that rejects with a database error after a dispatch makes the handler reject', async () => {
    const { subscriber, reviews, jobs }: Harness = createSubscriber();
    reviews.markDispatched.mockRejectedValue(new Error('db down'));

    await expect(subscriber.handle(payload())).rejects.toThrow('db down');
    expect(jobs.dispatch).toHaveBeenCalledTimes(1);
  });

  it('AC-15: an audit write that rejects with a database error makes the handler reject', async () => {
    const { subscriber, audit, jobs }: Harness = createSubscriber();
    audit.record.mockRejectedValue(new Error('db down'));

    await expect(subscriber.handle(payload())).rejects.toThrow('db down');
    expect(jobs.dispatch).toHaveBeenCalledTimes(1);
  });

  it('keeps both head writes in fleet.pr-review-bookkeeping bookkeeping', async () => {
    const { subscriber, writeReasons }: Harness = createSubscriber();

    await subscriber.handle(payload());

    expect(writeReasons).toEqual(['fleet.pr-review-bookkeeping', 'fleet.pr-review-bookkeeping']);
  });
});
