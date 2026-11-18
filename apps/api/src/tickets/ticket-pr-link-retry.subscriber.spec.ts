import { Logger } from '@nestjs/common';
import { currentAuditScope } from '../action-context/audit-coverage';
import { TICKET_PR_LINK_RETRY } from '../vcs/ticket-pr-link';
import { TicketPrLinkRetrySubscriber } from './ticket-pr-link-retry.subscriber';

/**
 * Review B2: the outbox handler of a failed classic auto-PR link write. It runs the ticket's adopt-only retry inside
 * this component's writer scope and records the recovered link; a stray payload is skipped, never fatal.
 */
describe('TicketPrLinkRetrySubscriber', () => {
  const payload = { projectId: 'proj-1', projectKey: 'KODA', ticketId: 'ticket-1' };

  const build = (linked = true) => {
    const registry = { register: vi.fn() };
    const transitions = { retryPrLink: vi.fn().mockResolvedValue(linked) };
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const subscriber = new TicketPrLinkRetrySubscriber(registry as never, transitions as never, audit as never);
    subscriber.onModuleInit();
    const handler = registry.register.mock.calls[0]?.[1] as (payload: unknown) => Promise<void>;
    return { registry, transitions, audit, handler };
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers one handler for the link retry event', () => {
    const { registry } = build();

    expect(registry.register).toHaveBeenCalledWith(TICKET_PR_LINK_RETRY, expect.any(Function));
  });

  it('runs the adopt-only retry for the payload ticket', async () => {
    const { handler, transitions } = build();

    await handler(payload);

    expect(transitions.retryPrLink).toHaveBeenCalledWith(payload);
  });

  it('records the recovered link under the ticket-link refresh key', async () => {
    const { handler, audit } = build(true);

    await handler(payload);

    expect(audit.record).toHaveBeenCalledWith({
      key: 'system.ticket-link.pr-refresh',
      resourceType: 'ticket',
      resourceId: 'ticket-1',
      projectId: 'proj-1',
      summary: 'linked the open PR of a verified ticket after a failed link write',
    });
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

  it('records nothing when the retry linked no PR', async () => {
    const { handler, audit } = build(false);

    await handler(payload);

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('skips a payload without ids and warns instead of failing the relay', async () => {
    const { handler, transitions } = build();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(handler({ projectId: 'proj-1' })).resolves.toBeUndefined();

    expect(transitions.retryPrLink).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(TICKET_PR_LINK_RETRY));
  });
});
