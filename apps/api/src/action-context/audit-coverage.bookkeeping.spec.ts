import {
  bookkeeping,
  currentAuditScope,
  currentBookkeepingReason,
  noteAuditEntry,
  noteAuditWrite,
  openAuditScope,
  runInAuditScope,
  type BookkeepingReason,
} from './audit-coverage';
import { BOOKKEEPING_REASONS } from './audit-coverage.reasons';
import { UNAUDITED_SURFACES } from './audit-coverage.allowlist';

const EXPECTED_REASON_IDS = [
  'runner.heartbeat',
  'runner.command-delivery',
  'runner.command-ack',
  'thread.input-ack',
  'runner.event-log',
  'runner.fence-abandon',
  'runner.boot-reconcile',
  'fleet.placement',
  'fleet.pr-link-job',
  'fleet.ticket-comment-claim',
  'fleet.pr-attribution-claim',
  'fleet.log-chunk',
  'thread.transcript',
  'fleet.ingest-queue',
  'fleet.schedule-bookkeeping',
  'assistant.tool-call-ledger',
  'assistant.action-request-link',
  'email.template-seed',
  'vcs.poll-log',
  'webhook.replay-record',
  'vcs.push-outbox',
  'vcs.pr-same-state',
  'vcs.link-refresh',
  'context.query-metric',
  'fleet.ingest-progress',
  'fleet.analytics-progress',
  'approval.request-open',
  'approval.request-settle',
] as const;

const EXPECTED_UNAUDITED_SURFACES = [
  'POST /me/notifications/:id/read',
  'POST /me/notifications/read-all',
  'system:outbox',
  'writer:PrismaOutboxStore',
  'writer:EmailDispatcher',
  'system:knowledge',
  'system:unknown',
] as const;

describe('audit coverage bookkeeping', () => {
  it('AC-1: exposes the current bookkeeping reason inside its callback', async () => {
    await bookkeeping('runner.heartbeat', () => {
      expect(currentBookkeepingReason()).toBe('runner.heartbeat');
    });
  });

  it("AC-2: suppresses writes inside bookkeeping without modifying the scope's write list", async () => {
    let writes: readonly string[] = [];
    await openAuditScope('POST /x', async (scope) => {
      await bookkeeping('runner.heartbeat', () => noteAuditWrite('Runner.update'));
      writes = scope.writes;
    });
    expect(writes).toEqual([]);
  });

  it('AC-3: clears the reason after bookkeeping resolves', async () => {
    await bookkeeping('runner.heartbeat', () => undefined);
    expect(currentBookkeepingReason()).toBeUndefined();
  });

  it('AC-4: rejects an unknown reason with its id', async () => {
    await expect(bookkeeping('not-a-reason' as BookkeepingReason, () => undefined)).rejects.toThrow(
      'unknown bookkeeping reason: not-a-reason',
    );
  });

  it('AC-5: does not invoke the callback for an unknown reason', async () => {
    const fn = vi.fn();
    await expect(bookkeeping('not-a-reason' as BookkeepingReason, fn)).rejects.toThrow(
      'unknown bookkeeping reason: not-a-reason',
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('AC-6: awaits a lazy thenable while its bookkeeping reason is active', async () => {
    let observed: BookkeepingReason | undefined;
    const lazy = {
      then: (resolve: (value: BookkeepingReason | undefined) => unknown) => {
        observed = currentBookkeepingReason();
        return resolve(observed);
      },
    } as PromiseLike<BookkeepingReason | undefined>;

    await expect(bookkeeping('runner.heartbeat', () => lazy)).resolves.toBe('runner.heartbeat');
    expect(observed).toBe('runner.heartbeat');
  });

  it('AC-7: awaits a lazy thenable while the audit scope is active', async () => {
    let observed: ReturnType<typeof currentAuditScope>;
    const lazy = {
      then: (resolve: (value: ReturnType<typeof currentAuditScope>) => unknown) => {
        observed = currentAuditScope();
        return resolve(observed);
      },
    } as PromiseLike<ReturnType<typeof currentAuditScope>>;

    await expect(runInAuditScope('POST /x', () => lazy)).resolves.toMatchObject({ surface: 'POST /x' });
    expect(observed?.surface).toBe('POST /x');
  });

  it("AC-8: keeps audit entries countable inside bookkeeping", async () => {
    let entries = 0;
    await openAuditScope('POST /x', async (scope) => {
      await bookkeeping('thread.transcript', () => noteAuditEntry());
      entries = scope.entries;
    });
    expect(entries).toBe(1);
  });

  it('AC-9: contains exactly the 26 initial, two progress and two approval reason ids', () => {
    expect(Object.keys(BOOKKEEPING_REASONS).sort()).toEqual([...EXPECTED_REASON_IDS].sort());
  });

  it('AC-10: gives every catalogue id a non-empty sentence', () => {
    for (const sentence of Object.values(BOOKKEEPING_REASONS)) {
      expect(sentence.trim().length).toBeGreaterThan(0);
    }
  });

  it('AC-11: contains exactly the seven unaudited surfaces', () => {
    expect([...UNAUDITED_SURFACES.keys()].sort()).toEqual([...EXPECTED_UNAUDITED_SURFACES].sort());
  });

  it('AC-12: gives every unaudited surface a non-empty reason', () => {
    for (const reason of UNAUDITED_SURFACES.values()) {
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });
});
