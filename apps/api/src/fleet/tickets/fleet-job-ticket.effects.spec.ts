import { FleetJobTicketEffects } from './fleet-job-ticket.effects';

describe('FleetJobTicketEffects.onRunDispatched (C9 §3.1, D452)', () => {
  const principal = { actorType: 'user', id: 'u1', role: 'MEMBER', email: 'u@koda.test' } as never;
  const actor = { principal, projectSlug: 'web' };
  const t = (ref: string, status: string) => ({ id: ref, ref, title: ref, status });
  let transitions: { start: jest.Mock };
  let effects: FleetJobTicketEffects;

  beforeEach(() => {
    transitions = { start: jest.fn().mockResolvedValue({}) };
    effects = new FleetJobTicketEffects(transitions as never, {} as never, {} as never, {} as never);
  });

  it('starts CREATED and VERIFIED tickets only, as the requester', async () => {
    await effects.onRunDispatched(actor, [t('WEB-1', 'CREATED'), t('WEB-2', 'VERIFIED'), t('WEB-3', 'IN_PROGRESS'), t('WEB-4', 'VERIFY_FIX')]);
    expect(transitions.start.mock.calls).toEqual([['web', 'WEB-1', principal], ['web', 'WEB-2', principal]]);
  });

  it('keeps going when one transition fails, and never throws', async () => {
    transitions.start.mockRejectedValueOnce(new Error('Ticket state changed concurrently'));
    await expect(effects.onRunDispatched(actor, [t('WEB-1', 'CREATED'), t('WEB-2', 'CREATED')])).resolves.toBeUndefined();
    expect(transitions.start).toHaveBeenCalledTimes(2);
  });
});

describe('FleetJobTicketEffects.onTerminal (C9 §3.2, D453)', () => {
  const effectJob = (state: string) => ({
    id: 'j1', projectId: 'p', projectSlug: 'web', command: 'RUN', state, leaseEpoch: 3,
    stateReason: 'boom', escalationReason: null, requestedById: 'u1',
  });
  const linked = (ticketId: string) => ({ ticketId, ref: ticketId, title: ticketId, status: 'IN_PROGRESS', notifiedEpoch: null });
  let repo: { findJobForEffects: jest.Mock; findTicketsForJob: jest.Mock; claimNotified: jest.Mock; createSystemComment: jest.Mock };
  let events: { record: jest.Mock };
  let effects: FleetJobTicketEffects;

  beforeEach(() => {
    repo = {
      findJobForEffects: jest.fn(),
      findTicketsForJob: jest.fn().mockResolvedValue([linked('t1'), linked('t2')]),
      claimNotified: jest.fn().mockResolvedValue(true),
      createSystemComment: jest.fn().mockImplementation(async (ticketId: string) => ({ id: `c-${ticketId}` })),
    };
    events = { record: jest.fn() };
    effects = new FleetJobTicketEffects({} as never, repo as never, events as never, { run: (fn: () => unknown) => fn() } as never);
  });

  it.each(['FAILED', 'ESCALATED', 'CRASHED'])('comments on every linked ticket for %s and records COMMENT_ADDED', async (state) => {
    repo.findJobForEffects.mockResolvedValue(effectJob(state));
    await effects.onTerminal(['j1']);
    expect(repo.claimNotified.mock.calls).toEqual([['j1', 't1', 3], ['j1', 't2', 3]]);
    expect(repo.createSystemComment).toHaveBeenCalledWith('t1', expect.stringContaining(`ended ${state}: boom`));
    expect(events.record).toHaveBeenCalledWith({ projectId: 'p', ticketId: 't2', action: 'COMMENT_ADDED', actorId: 'u1', data: { commentId: 'c-t2' } });
  });

  it.each(['COMPLETED', 'CANCELLED', 'RUNNING'])('does nothing for %s', async (state) => {
    repo.findJobForEffects.mockResolvedValue(effectJob(state));
    await effects.onTerminal(['j1']);
    expect(repo.findTicketsForJob).not.toHaveBeenCalled();
  });

  it('skips a ticket whose claim is lost (already commented this attempt)', async () => {
    repo.findJobForEffects.mockResolvedValue(effectJob('FAILED'));
    repo.claimNotified.mockResolvedValueOnce(false);
    await effects.onTerminal(['j1']);
    expect(repo.createSystemComment.mock.calls.map((c) => c[0])).toEqual(['t2']);
  });

  it('never throws: one ticket failing does not stop the next, one job failing does not stop the next', async () => {
    repo.findJobForEffects.mockRejectedValueOnce(new Error('db down')).mockResolvedValue(effectJob('FAILED'));
    repo.createSystemComment.mockRejectedValueOnce(new Error('fk'));
    await expect(effects.onTerminal(['jx', 'j1'])).resolves.toBeUndefined();
    expect(repo.createSystemComment.mock.calls.map((c) => c[0])).toEqual(['t1', 't2']);
  });

  it('deduplicates job ids and ignores a missing job', async () => {
    repo.findJobForEffects.mockResolvedValue(null);
    await effects.onTerminal(['j1', 'j1']);
    expect(repo.findJobForEffects).toHaveBeenCalledTimes(1);
  });
});
