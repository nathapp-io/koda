import { CommentType } from '../../common/enums';
import { FleetJobTicketEffects } from './fleet-job-ticket.effects';
import { FleetPrRulingsService } from '../rulings/fleet-pr-rulings.service';
import { HttpException } from '@nestjs/common';
import type { IFleetPrRulingRepository } from '../rulings/fleet-pr-ruling.domain';

const principal: import('../../auth/principal/koda-principal.types').AgentPrincipal = { actorType: 'agent', id: 'agent', slug: 'ruler', status: 'ACTIVE', capabilities: [] };
const setup = () => {
  const order: string[] = [];
  const repo = {
    lockJobRow: vi.fn(async () => { order.push('lock'); }),
    findEligibleFinishTicket: vi.fn(async () => { order.push('select'); return null as { ticketId: string } | null; }),
    findJobForFinishTicket: vi.fn(async () => ({ id: 'run', projectId: 'p', projectSlug: 'web', feature: 'feature', resultPrUrl: 'https://github.com/acme/app/pull/42', repo: { provider: 'github', owner: 'acme', name: 'app' } })),
    upsertFleetPrLink: vi.fn(async () => 'link'), createRulingComment: vi.fn(async () => ({ id: 'comment' })),
  };
  const tickets = { create: vi.fn(async () => ({ id: 'ticket', ref: 'WEB-1', title: 'Finish draft PR #42 (feature)', status: 'CREATED' })) };
  const links = { link: vi.fn() };
  const transitions = { startForDispatch: vi.fn() };
  const effects = new FleetJobTicketEffects(transitions as never, repo as never, {} as never, {} as never, {} as never, {} as never, tickets as never, links as never);
  return { effects, repo, tickets, links, transitions, order };
};
describe('finish ticket transaction effects', () => {
  it('AC-1: exports the RULING type', () => { expect(CommentType.RULING).toBe('RULING'); });
  it('AC-2/3: locks before selection and creates, starts and links a TASK with its PR', async () => {
    const { effects, repo, tickets, links, transitions, order } = setup();
    expect(await effects.ensureFinishTicket({ id: 'run' }, principal)).toBe('ticket');
    expect(order).toEqual(['lock', 'select']);
    expect(tickets.create).toHaveBeenCalledWith('web', { type: 'TASK', title: 'Finish draft PR #42 (feature)' }, principal);
    expect(transitions.startForDispatch).toHaveBeenCalledWith('web', 'WEB-1', principal);
    expect(links.link).toHaveBeenCalledWith('run', [expect.objectContaining({ id: 'ticket' })]);
    expect(repo.upsertFleetPrLink).toHaveBeenCalledWith(expect.objectContaining({ ticketId: 'ticket', jobId: 'run', url: 'https://github.com/acme/app/pull/42', prNumber: 42, provider: 'github', externalRef: 'acme/app#42' }));
  });
  it('AC-5/6: reuses the repository-selected eligible ticket', async () => {
    const { effects, repo, tickets } = setup(); repo.findEligibleFinishTicket.mockResolvedValue({ ticketId: 'oldest' });
    expect(await effects.ensureFinishTicket({ id: 'run' }, principal)).toBe('oldest');
    expect(tickets.create).not.toHaveBeenCalled();
  });
  it('AC-4: delegates authored ruling comment insertion without deferral', async () => {
    const { effects, repo } = setup();
    expect(await effects.createRulingComment('ticket', 'D-1 (advisor): confirm: test green', principal)).toEqual({ id: 'comment' });
    expect(repo.createRulingComment).toHaveBeenCalledWith('ticket', 'D-1 (advisor): confirm: test green', principal);
  });
  it('AC-11: ticket-number conflict propagates through ruling creation before insertion', async () => {
    const { effects, tickets } = setup(); const conflict = new HttpException('Ticket number allocation conflicted; retry the request', 409);
    tickets.create.mockRejectedValue(conflict);
    const target = { projectId: 'p', repoId: 'repo', prNumber: 42, openItems: [{ id: 'D-1', kind: 'advisor' }], command: 'RUN', outcome: 'draft' };
    const repo = { lockTarget: vi.fn(async () => target), findTarget: vi.fn(async () => target), latestRunForPr: vi.fn(async () => 'run'), latestRuling: vi.fn(async () => null), replacePending: vi.fn(), insert: vi.fn() };
    const service = new FleetPrRulingsService(repo as unknown as IFleetPrRulingRepository, { run: (fn: () => Promise<unknown>) => fn() } as never, {} as never, effects);
    await expect(service.create(principal, 'web', 'run', { itemId: 'D-1', text: 'confirm: test green' })).rejects.toBe(conflict);
    expect(conflict.getStatus()).toBe(409); expect(repo.insert).not.toHaveBeenCalled();
    expect(tickets.create).toHaveBeenCalledOnce();
  });
});
