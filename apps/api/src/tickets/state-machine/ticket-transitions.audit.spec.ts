import { TicketTransitionsService } from './ticket-transitions.service';
import { TicketStatus, CommentType } from '../../common/enums';
import type { UserPrincipal } from '../../auth/principal/koda-principal.types';

const principal = { actorType: 'user', id: 'user' } as UserPrincipal;
describe('transition audit transaction seam', () => {
  const build = (from: TicketStatus) => {
    let inside = false;
    const repo = {
      findProjectBySlug: vi.fn().mockResolvedValue({ id: 'project', key: 'T' }),
      findTicketByRefRaw: vi.fn().mockResolvedValue({ id: 'ticket', projectId: 'project', status: from }),
      updateTicketStatusIf: vi.fn().mockResolvedValue({ id: 'ticket' }),
      createTicketActivity: vi.fn().mockResolvedValue({ id: 'activity' }),
      createComment: vi.fn().mockResolvedValue({ id: 'comment' }),
    };
    const audit = { record: vi.fn(async () => { expect(inside).toBe(true); }) };
    const tx = { run: vi.fn(async (fn: () => Promise<unknown>) => { inside = true; try { return await fn(); } finally { inside = false; } }) };
    const service = new TicketTransitionsService(repo as never, tx as never, { can: vi.fn().mockResolvedValue({ allowed: true }) } as never, audit as never);
    return { service, repo, audit, tx };
  };
  it.each([
    [TicketStatus.CREATED, TicketStatus.VERIFIED, CommentType.VERIFICATION, 'verify'],
    [TicketStatus.CREATED, TicketStatus.IN_PROGRESS, undefined, 'start'],
    [TicketStatus.VERIFIED, TicketStatus.IN_PROGRESS, undefined, 'start'],
    [TicketStatus.IN_PROGRESS, TicketStatus.VERIFY_FIX, CommentType.FIX_REPORT, 'fix'],
    [TicketStatus.VERIFY_FIX, TicketStatus.CLOSED, CommentType.REVIEW, 'verify-fix.approve'],
    [TicketStatus.VERIFY_FIX, TicketStatus.IN_PROGRESS, CommentType.REVIEW, 'verify-fix.return'],
    [TicketStatus.CREATED, TicketStatus.REJECTED, CommentType.GENERAL, 'reject'],
  ])('records %s -> %s inside the existing transaction', async (from, to, commentType, key) => {
    const { service, audit, tx } = build(from);
    await (service as unknown as { executeTransitionInternal: (...args: unknown[]) => Promise<unknown> }).executeTransitionInternal('slug', 'T-1', to, commentType, 'body', principal);
    expect(audit.record).toHaveBeenCalledExactlyOnceWith({ key: `ticket.transition.${key}`, resourceType: 'ticket', resourceId: 'ticket', projectId: 'project', summary: `status: ${from} -> ${to}` });
    expect(tx.run).toHaveBeenCalledTimes(1);
  });
  it('records close', async () => {
    const { service, audit } = build(TicketStatus.VERIFIED);
    await service.close('slug', 'T-1', 'reason', principal);
    expect(audit.record).toHaveBeenCalledExactlyOnceWith({ key: 'ticket.transition.close', resourceType: 'ticket', resourceId: 'ticket', projectId: 'project', summary: 'status: VERIFIED -> CLOSED' });
  });
  it('propagates audit rejection to the transaction caller on dispatch start', async () => {
    const { service, audit } = build(TicketStatus.VERIFIED);
    audit.record.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(service.startForDispatch('slug', 'T-1', principal)).rejects.toThrow('audit unavailable');
  });
  it('lost race does not record', async () => {
    const { service, repo, audit } = build(TicketStatus.CREATED);
    repo.updateTicketStatusIf.mockResolvedValueOnce(null);
    await expect(service.verify('slug', 'T-1', 'body', principal)).rejects.toMatchObject({ status: 409 });
    expect(audit.record).not.toHaveBeenCalled();
  });
  it('invalid edge does not record', async () => {
    const { service, audit } = build(TicketStatus.CREATED);
    await expect(service.fix('slug', 'T-1', 'body', principal)).rejects.toThrow();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
