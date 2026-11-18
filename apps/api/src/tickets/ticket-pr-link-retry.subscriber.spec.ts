import { Logger } from '@nestjs/common';
import { currentAuditScope } from '../action-context/audit-coverage';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { TICKET_PR_LINK_RETRY } from '../vcs/ticket-pr-link';
import { TicketPrLinkRetrySubscriber } from './ticket-pr-link-retry.subscriber';

/**
 * Review B2: the outbox handler of a recovered classic auto-PR link. It runs the ticket's retry inside this
 * component's writer scope and records the recovered link; a stray payload is skipped, never fatal.
 *
 * Fix round 2 (B6): the audit entry is written by the *real* `AuditRecorder` inside the transaction that writes the
 * link, so the two commit together. Recording it after the link committed left a link whose entry never happened,
 * and the redelivery then found the link, answered "nothing to do" and skipped the audit for good.
 */
describe('TicketPrLinkRetrySubscriber', () => {
  const payload = { projectId: 'proj-1', projectKey: 'KODA', ticketId: 'ticket-1' };

  interface Recorded {
    action: string;
    resourceId: string;
    inTransaction: boolean;
    projectId: unknown;
  }

  const build = (linked = true) => {
    const registry = { register: vi.fn() };

    /** The transaction the transitions service opens around the link write; the audit entry must run inside it. */
    const tx = { inTx: false, runs: 0 };
    const txManager = {
      run: vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => {
        tx.runs += 1;
        tx.inTx = true;
        try {
          return await fn();
        } finally {
          tx.inTx = false;
        }
      }),
      getClient: vi.fn(),
      isInTransaction: vi.fn(() => tx.inTx),
    };

    const recorded: Recorded[] = [];
    const storage = {
      record: vi.fn(async (entry: { action: string; resourceId: string; metadata: { projectId: unknown } }) => {
        recorded.push({
          action: entry.action,
          resourceId: entry.resourceId,
          projectId: entry.metadata.projectId,
          inTransaction: tx.inTx,
        });
      }),
    };
    const audit = new AuditRecorder(storage as never, txManager as never);

    /** What the real service does: the link and the caller's `onLinked` in one `txManager.run`. */
    const transitions = {
      retryPrLink: vi.fn(async (_payload: unknown, onLinked?: () => Promise<void>) => {
        if (!linked) return false;
        await txManager.run(async () => {
          if (onLinked !== undefined) await onLinked();
        });
        return true;
      }),
    };

    const subscriber = new TicketPrLinkRetrySubscriber(registry as never, transitions as never, audit);
    subscriber.onModuleInit();
    const handler = registry.register.mock.calls[0]?.[1] as (payload: unknown) => Promise<void>;
    return { registry, transitions, audit, handler, recorded, tx, txManager };
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers one handler for the link retry event', () => {
    const { registry } = build();

    expect(registry.register).toHaveBeenCalledWith(TICKET_PR_LINK_RETRY, expect.any(Function));
  });

  it('runs the retry for the payload ticket', async () => {
    const { handler, transitions } = build();

    await handler(payload);

    expect(transitions.retryPrLink).toHaveBeenCalledWith(payload, expect.any(Function));
  });

  it('records the recovered link under the ticket-link refresh key, inside the link transaction', async () => {
    const { handler, recorded } = build(true);

    await handler(payload);

    expect(recorded).toEqual([{
      action: 'system.ticket-link.pr-refresh',
      resourceId: 'ticket-1',
      projectId: 'proj-1',
      inTransaction: true,
    }]);
  });

  it('does not append a second audit entry on a redelivery that found nothing to link', async () => {
    const { handler, recorded } = build(false);

    await handler(payload);

    expect(recorded).toEqual([]);
  });

  it('rejects when the audit write fails, so the link does not commit without it', async () => {
    const { handler, txManager } = build(true);
    // A failed audit entry aborts the transaction the link write ran in, which is what makes the relay retry it.
    vi.spyOn(txManager, 'run').mockImplementation(async () => {
      throw new Error('audit db down');
    });

    await expect(handler(payload)).rejects.toThrow('audit db down');
  });

  it('runs its write inside the subscriber writer scope', async () => {
    const { handler, transitions } = build();

    let surface: string | undefined;
    transitions.retryPrLink.mockImplementation(async () => {
      surface = currentAuditScope()?.surface;
      return true;
    });

    await handler(payload);

    expect(surface).toBe('writer:TicketPrLinkRetrySubscriber');
  });

  it('skips a payload without ids and warns instead of failing the relay', async () => {
    const { handler, transitions } = build();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(handler({ projectId: 'proj-1' })).resolves.toBeUndefined();

    expect(transitions.retryPrLink).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(TICKET_PR_LINK_RETRY));
  });
});
